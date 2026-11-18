// Email Owner -> country -> one verified published Task Order mapping per batch.
// Read from the immutable country ownership snapshot; never guess from file names.
import { normalizeCountryOwnershipKey } from "../../../kpi/usVisa/calls/skillStatisticsTaskOrderOwnership.js";
import { normalizeEmailCountryFromOwner, normalizeEmailCountry } from "../../../kpi/usVisa/email/emailCountryService.js";

function normalizeOrderCode(value) {
  const match = String(value || "").toUpperCase().match(/\bTO\s*([0-9]+)\b/);
  return match ? `TO${Number(match[1])}` : null;
}

export function createEmailCountryTaskOrderResolver(snapshot = {}) {
  if (!Number.isSafeInteger(Number(snapshot?.version?.id)) || !snapshot?.version?.id) {
    throw new Error("A published Task Order version is required for Email mapping.");
  }
  const profiles = new Map((snapshot.profiles || []).map((p) => [Number(p.profileId), p]));
  const index = new Map();
  for (const item of snapshot.countries || []) {
    const profile = profiles.get(Number(item.profileId));
    const country = normalizeEmailCountry(item.countryLabel);
    const candidate = {
      countryName: country?.countryName || item.countryLabel,
      countryCode: country?.countryCode || null,
      region: profile?.region || null,
      taskOrderId: normalizeOrderCode(profile?.code),
      profileId: profile?.profileId || null,
      active: Boolean(Number(profile?.active)),
    };
    // A published snapshot includes validated aliases. Resolve those alongside
    // the canonical name, without counting aliases of the same profile twice.
    const names = [item.countryKey, item.countryLabel, ...(item.countryAliases || [])];
    for (const name of names) {
      const key = normalizeCountryOwnershipKey(name);
      if (!key) continue;
      const entries = index.get(key) || [];
      if (!entries.some((e) => e.profileId === candidate.profileId && e.countryName === candidate.countryName)) {
        entries.push(candidate);
        index.set(key, entries);
      }
    }
  }

  return Object.freeze({
    versionId: Number(snapshot.version.id),
    resolve(ownerRaw) {
      const country = normalizeEmailCountryFromOwner(ownerRaw);
      const key = normalizeCountryOwnershipKey(country?.countryName);
      const candidates = key ? (index.get(key) || []) : [];
      const eligible = candidates.filter((c) => c.active && c.taskOrderId);
      if (eligible.length !== 1) {
        return {
          status: candidates.length > 1 || eligible.length > 1 ? "CONFLICT" : "UNMATCHED",
          countryName: country?.countryName || null,
          countryCode: country?.countryCode || null,
          region: null,
          taskOrderId: null,
          versionId: Number(snapshot.version.id),
          message: !country ? "Owner does not identify a country."
            : candidates.length ? "Country has no unique active published Task Order."
            : "Country is not in the published Task Order snapshot.",
        };
      }
      return { ...eligible[0], status: "MATCHED", versionId: Number(snapshot.version.id), message: null };
    },
  });
}
