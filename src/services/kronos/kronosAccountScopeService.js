import {
  findCallCenterOperationsAccount,
  listCallCenterOperationsAccounts,
} from "../../repositories/kronos/kronosAccountMappingRepository.js";
import {
  fetchLiveKronosAccounts,
  resolveKronosAccountByName,
} from "./kronosAccountDirectoryService.js";

export class KronosScopeError extends Error {
  constructor(message, { status = 400, code = "KRONOS_SCOPE_ERROR" } = {}) {
    super(message);
    this.name = "KronosScopeError";
    this.status = status;
    this.code = code;
  }
}

function toPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function withLiveResolution(account, kronosAccounts) {
  const { mapping, resolution } = resolveKronosAccountByName(
    account,
    kronosAccounts,
  );

  return {
    ...account,
    kronosMapping: mapping,
    kronosResolution: resolution,
  };
}

/**
 * Lists only HRIS accounts under Call Center Operations and resolves each account
 * against the live Kronos /api/v1/accounts directory by normalized account name.
 * No mapping is persisted in env or database.
 */
export async function getCallCenterOperationsAccountsWithMappings() {
  const [accounts, kronosAccounts] = await Promise.all([
    listCallCenterOperationsAccounts(),
    fetchLiveKronosAccounts(),
  ]);

  return accounts.map((account) => withLiveResolution(account, kronosAccounts));
}

export async function resolveCallCenterOperationsAccountScope(
  accountId,
  { requireKronosMapping = true } = {},
) {
  const hrisAccountId = toPositiveInteger(accountId);
  if (!hrisAccountId) {
    throw new KronosScopeError(
      "A valid Call Center Operations account ID is required.",
      {
        status: 400,
        code: "KRONOS_ACCOUNT_REQUIRED",
      },
    );
  }

  const account = await findCallCenterOperationsAccount(hrisAccountId);
  if (!account) {
    throw new KronosScopeError(
      "The requested account is outside Call Center Operations.",
      {
        status: 403,
        code: "KRONOS_ACCOUNT_OUT_OF_SCOPE",
      },
    );
  }

  const kronosAccounts = await fetchLiveKronosAccounts();
  const resolved = withLiveResolution(account, kronosAccounts);

  if (requireKronosMapping && !resolved.kronosMapping) {
    const resolutionStatus = resolved.kronosResolution?.status;
    throw new KronosScopeError(
      resolutionStatus === "AMBIGUOUS"
        ? `Multiple Kronos accounts match "${account.accountName}". The live account match must be unique before attendance can be loaded.`
        : `No Kronos account with the name "${account.accountName}" was found in the live account directory.`,
      {
        status: 409,
        code:
          resolutionStatus === "AMBIGUOUS"
            ? "KRONOS_ACCOUNT_MATCH_AMBIGUOUS"
            : "KRONOS_ACCOUNT_MATCH_NOT_FOUND",
      },
    );
  }

  return resolved;
}
