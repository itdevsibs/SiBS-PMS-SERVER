/**
 * FrontSteps AI Hermes Client
 * 
 * Transport layer for communication with the isolated Hermes AI inference gateway.
 * Enforces timeouts, bounded retries, status checks, and non-sensitive diagnostic logging.
 * 
 * Strict Isolation: Node.js backend only. API keys are never exposed to the frontend.
 */

const DEFAULT_BASE_URL = 'http://172.18.7.100:8642/p/sibs-pms-analyst';
const DEFAULT_MODEL = 'sibs-pms-analyst';
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

function resolveHermesMaxConcurrency() {
  const parsed = parseInt(process.env.FS_AI_HERMES_CONCURRENCY || '1', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

const hermesSemaphoreState = {
  activeCount: 0,
  waiters: [],
};

async function acquireHermesSlot() {
  const maxConcurrent = resolveHermesMaxConcurrency();
  if (hermesSemaphoreState.activeCount < maxConcurrent) {
    hermesSemaphoreState.activeCount += 1;
    return () => releaseHermesSlot();
  }
  await new Promise((resolve) => {
    hermesSemaphoreState.waiters.push(resolve);
  });
  return () => releaseHermesSlot();
}

function releaseHermesSlot() {
  const maxConcurrent = resolveHermesMaxConcurrency();
  if (
    hermesSemaphoreState.waiters.length > 0 &&
    hermesSemaphoreState.activeCount <= maxConcurrent
  ) {
    const nextResolve = hermesSemaphoreState.waiters.shift();
    if (nextResolve) {
      nextResolve();
      return;
    }
  }
  hermesSemaphoreState.activeCount = Math.max(0, hermesSemaphoreState.activeCount - 1);
}

export function getHermesConcurrencyStats() {
  return {
    maxConcurrent: resolveHermesMaxConcurrency(),
    activeCount: hermesSemaphoreState.activeCount,
    queuedCount: hermesSemaphoreState.waiters.length,
  };
}

export class HermesError extends Error {
  constructor(message, { code = 'HERMES_ERROR', status = null, details = null } = {}) {
    super(message);
    this.name = 'HermesError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Gets sanitized Hermes client configuration.
 */
export function getHermesConfig() {
  const baseUrl = (process.env.HERMES_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = process.env.HERMES_MODEL || DEFAULT_MODEL;
  const apiKey = process.env.HERMES_API_KEY || '';
  const timeoutMs = parseInt(process.env.HERMES_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS;

  const parseOptionalPositiveInt = (raw) => {
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    const parsed = parseInt(String(raw), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  const repairPromptMaxTokens = parseOptionalPositiveInt(
    process.env.FS_AI_REPAIR_PROMPT_MAX_TOKENS ?? process.env.HERMES_REPAIR_PROMPT_MAX_TOKENS
  );
  const repairPromptMaxChars = parseOptionalPositiveInt(
    process.env.FS_AI_REPAIR_PROMPT_MAX_CHARS ?? process.env.HERMES_REPAIR_PROMPT_MAX_CHARS
  );
  const modelContextLimitTokens = parseOptionalPositiveInt(
    process.env.HERMES_CONTEXT_LIMIT_TOKENS ?? process.env.HERMES_MAX_PROMPT_TOKENS
  );

  return {
    baseUrl,
    model,
    hasApiKey: Boolean(apiKey),
    apiKey,
    timeoutMs,
    repairPromptMaxTokens,
    repairPromptMaxChars,
    modelContextLimitTokens,
  };
}

/**
 * Helper to sleep for bounded retry intervals.
 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scrubSecretFromText(text, apiKey) {
  const str = String(text || '');
  if (!apiKey || apiKey.length < 4) return str;
  return str.split(apiKey).join('[REDACTED]');
}

/**
 * Executes a chat completion request to the Hermes endpoint under the shared concurrency gate.
 * 
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [options]
 * @param {string} [options.model]
 * @param {number} [options.temperature=0.1]
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.requireJson=true]
 * @returns {Promise<{content: string, rawJson: object, usage: object, model: string}>}
 */
export async function sendHermesChatCompletion(messages, options = {}) {
  const releaseSlot = await acquireHermesSlot();
  try {
    return await executeHermesChatCompletion(messages, options);
  } finally {
    releaseSlot();
  }
}

async function executeHermesChatCompletion(messages, options = {}) {
  const config = getHermesConfig();
  const model = options.model || config.model;
  const temperature = options.temperature ?? 0.1;
  const timeoutMs = options.timeoutMs || config.timeoutMs;
  const endpoint = `${config.baseUrl}/v1/chat/completions`;
  const transportFn = typeof options.transport === 'function' ? options.transport : fetch;

  const payload = {
    model,
    messages,
    stream: false,
    temperature,
    max_tokens: options.maxTokens || 4096,
  };

  if (options.responseFormat) {
    payload.response_format = options.responseFormat;
  }

  const effectiveMaxRetries =
    options.maxTransportRetries !== undefined && options.maxTransportRetries !== null
      ? Math.max(0, Math.min(MAX_RETRIES, Number(options.maxTransportRetries) || 0))
      : MAX_RETRIES;

  let lastError = null;
  let upstreamAttempts = 0;
  const transportRetryReasons = [];

  for (let attempt = 1; attempt <= effectiveMaxRetries + 1; attempt++) {
    upstreamAttempts = attempt;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = {
        'Content-Type': 'application/json',
      };
      if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
      }

      const response = await transportFn(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timer);

      const contentType = response.headers.get('content-type') || '';
      const status = response.status;

      // Handle non-200 responses
      if (!response.ok) {
        let errBody = '';
        try {
          errBody = await response.text();
        } catch {}

        if (status === 401 || status === 403) {
          throw new HermesError(`Hermes authentication failed (HTTP ${status}). Check credentials.`, {
            code: 'HERMES_AUTH_FAILED',
            status,
          });
        }
        if (status === 404) {
          throw new HermesError(`Hermes endpoint not found: ${endpoint} (HTTP 404)`, {
            code: 'HERMES_NOT_FOUND',
            status,
          });
        }
        if (status === 429) {
          if (attempt <= effectiveMaxRetries) {
            transportRetryReasons.push(`HTTP_429_ATTEMPT_${attempt}`);
            console.warn(`[Hermes Client] Rate limited (429). Retrying attempt ${attempt}/${effectiveMaxRetries}...`);
            await wait(RETRY_DELAY_MS * attempt);
            continue;
          }
          throw new HermesError('Hermes rate limit exceeded (HTTP 429). Bounded retries exhausted.', {
            code: 'HERMES_RATE_LIMITED',
            status,
          });
        }
        if (status >= 500) {
          if (attempt <= effectiveMaxRetries) {
            transportRetryReasons.push(`HTTP_${status}_ATTEMPT_${attempt}`);
            console.warn(`[Hermes Client] Gateway error (${status}). Retrying attempt ${attempt}/${effectiveMaxRetries}...`);
            await wait(RETRY_DELAY_MS * attempt);
            continue;
          }
          throw new HermesError(`Hermes gateway error (HTTP ${status}): ${errBody.substring(0, 200)}`, {
            code: status === 502 ? 'HERMES_BAD_GATEWAY' : 'HERMES_SERVER_ERROR',
            status,
            details: errBody.substring(0, 500),
          });
        }

        throw new HermesError(`Hermes request failed with HTTP status ${status}`, {
          code: 'HERMES_REQUEST_FAILED',
          status,
          details: errBody.substring(0, 300),
        });
      }

      // Check Content-Type
      if (!contentType.includes('application/json')) {
        const rawText = await response.text();
        throw new HermesError(`Hermes returned non-JSON Content-Type: ${contentType}`, {
          code: 'HERMES_RESPONSE_NOT_JSON',
          status,
          details: rawText.substring(0, 300),
        });
      }

      // Parse JSON body
      let data;
      try {
        data = await response.json();
      } catch (parseErr) {
        throw new HermesError(`Failed to parse Hermes response as JSON: ${parseErr.message}`, {
          code: 'HERMES_RESPONSE_NOT_JSON',
          status,
        });
      }

      const choice = data.choices?.[0];
      if (!choice || !choice.message) {
        throw new HermesError('Hermes returned an empty or invalid choices structure', {
          code: 'HERMES_INVALID_RESPONSE_STRUCTURE',
          status,
        });
      }

      const content = choice.message.content || '';
      return {
        content,
        reasoningContent: choice.message.reasoning_content || null,
        rawJson: data,
        usage: data.usage || null,
        model: data.model || model,
        upstreamAttempts,
        transportRetries: Math.max(0, upstreamAttempts - 1),
        transportRetryReasons,
      };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        lastError = new HermesError(`Hermes request timed out after ${timeoutMs}ms`, {
          code: 'HERMES_TIMEOUT',
        });
      } else if (err instanceof HermesError) {
        lastError = err;
      } else {
        const safeErr = scrubSecretFromText(err.message, config.apiKey);
        lastError = new HermesError(`Network error reaching Hermes: ${safeErr}`, {
          code: 'HERMES_NETWORK_ERROR',
          details: safeErr,
        });
      }

      // Retry network errors if attempts remaining
      if (attempt <= effectiveMaxRetries && ['HERMES_NETWORK_ERROR', 'HERMES_TIMEOUT'].includes(lastError.code)) {
        transportRetryReasons.push(`${lastError.code}_ATTEMPT_${attempt}`);
        console.warn(`[Hermes Client] ${lastError.code}: Retrying attempt ${attempt}/${effectiveMaxRetries}...`);
        await wait(RETRY_DELAY_MS * attempt);
        continue;
      }

      break;
    }
  }

  if (lastError) {
    lastError.upstreamAttempts = upstreamAttempts;
    lastError.transportRetries = Math.max(0, upstreamAttempts - 1);
    lastError.transportRetryReasons = transportRetryReasons;
  }
  throw lastError;
}

/**
 * Smoke tests Hermes gateway connectivity and model availability.
 */
export async function testHermesConnectivity() {
  const config = getHermesConfig();
  const startTime = Date.now();
  const endpoint = `${config.baseUrl}/v1/models`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const headers = {};
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timer);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      return {
        connected: false,
        status: response.status,
        latencyMs,
        error: `HTTP ${response.status}`,
        baseUrl: config.baseUrl,
        model: config.model,
      };
    }

    const data = await response.json();
    const models = data?.data?.map((m) => m.id) || [];

    return {
      connected: true,
      status: response.status,
      latencyMs,
      models,
      targetModel: config.model,
      baseUrl: config.baseUrl,
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      connected: false,
      status: null,
      latencyMs: Date.now() - startTime,
      error: err.message,
      baseUrl: config.baseUrl,
      model: config.model,
    };
  }
}
