/**
 * Canonical identities used by the Staking reward and provider-terms paths.
 *
 * Provider websites and supplier endpoint domains are not stable identifiers:
 * a provider may advertise more than one domain, and a display name may carry
 * a suffix such as "Kleomedes α". Keep the aliases explicit and resolve them
 * conservatively so an unrelated provider is never merged by a weak fragment.
 */

export type StakingProviderIdentity = {
  id: string;
  provider: string;
  nameAliases: string[];
  domainAliases: string[];
  rewardDomainCandidates: string[];
};

const SECOND_LEVEL_SUFFIXES = new Set(["co.uk", "org.uk", "com.au", "net.au", "co.jp", "com.br"]);

export const STAKING_PROVIDER_IDENTITIES: StakingProviderIdentity[] = [
  {
    id: "kleomedes",
    provider: "Kleomedes",
    nameAliases: ["kleomedes"],
    domainAliases: ["kleomedes.network", "kleomedes.cloud"],
    rewardDomainCandidates: ["kleomedes.network", "kleomedes.cloud"]
  },
  {
    id: "kalorius",
    provider: "Kalorius.tech",
    nameAliases: ["kalorius", "kaloriustech"],
    domainAliases: ["kalorius.tech"],
    rewardDomainCandidates: ["kalorius.tech"]
  },
  {
    id: "nodefleet",
    provider: "Nodefleet",
    nameAliases: ["nodefleet"],
    domainAliases: ["nodefleet.net", "nodefleet.org"],
    rewardDomainCandidates: ["nodefleet.net", "nodefleet.org"]
  },
  {
    id: "purroofgroup",
    provider: "purroofgroup",
    nameAliases: ["purroofgroup", "purroof"],
    domainAliases: ["purroofgroup.com"],
    rewardDomainCandidates: ["purroofgroup.com"]
  },
  {
    id: "easy2stake",
    provider: "Easy2stake",
    nameAliases: ["easy2stake"],
    domainAliases: ["easy2stake.com"],
    rewardDomainCandidates: ["easy2stake.com"]
  }
];

export function normalizeIdentityToken(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function normalizeProviderDomain(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const labels = hostname.split(".").filter(Boolean);
    if (labels.length <= 2) return hostname;
    const suffix = labels.slice(-2).join(".");
    return SECOND_LEVEL_SUFFIXES.has(suffix) && labels.length >= 3
      ? labels.slice(-3).join(".")
      : labels.slice(-2).join(".");
  } catch {
    return null;
  }
}

export type ProviderIdentityResolutionInput = {
  providerOverride?: string | null;
  providerName?: string | null;
  domain?: string | null;
};

function exactIdentityById(value: string): StakingProviderIdentity | null {
  const normalized = normalizeIdentityToken(value);
  return STAKING_PROVIDER_IDENTITIES.find((identity) => identity.id === normalized) ?? null;
}

/**
 * Resolve a provider with a strict priority order. The final token/contains
 * pass only returns an identity when exactly one configured provider matches;
 * ambiguous or weak fragments remain unresolved.
 */
export function resolveStakingProviderIdentity(input: ProviderIdentityResolutionInput): StakingProviderIdentity | null {
  if (input.providerOverride) {
    const explicit = exactIdentityById(input.providerOverride) ?? STAKING_PROVIDER_IDENTITIES.find((identity) =>
      identity.domainAliases.includes(normalizeProviderDomain(input.providerOverride ?? "") ?? "")
    );
    return explicit ?? null;
  }

  const domain = input.domain ? normalizeProviderDomain(input.domain) : null;
  if (domain) {
    const exactDomain = STAKING_PROVIDER_IDENTITIES.find((identity) => identity.domainAliases.includes(domain));
    if (exactDomain) return exactDomain;
  }

  const name = input.providerName?.trim() || null;
  if (name) {
    const normalizedName = normalizeIdentityToken(name);
    const exactName = STAKING_PROVIDER_IDENTITIES.find((identity) => identity.nameAliases.some((alias) => normalizeIdentityToken(alias) === normalizedName));
    if (exactName) return exactName;
  }

  const candidates = [domain, name].filter((value): value is string => Boolean(value));
  const matches = new Set<StakingProviderIdentity>();
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeIdentityToken(candidate);
    if (!normalizedCandidate) continue;
    for (const identity of STAKING_PROVIDER_IDENTITIES) {
      if (identity.nameAliases.some((alias) => {
        const normalizedAlias = normalizeIdentityToken(alias);
        return normalizedAlias.length >= 6 && normalizedCandidate.includes(normalizedAlias);
      })) {
        matches.add(identity);
      }
    }
  }
  return matches.size === 1 ? [...matches][0] : null;
}

export function stakingProviderIdentityById(id: string): StakingProviderIdentity | null {
  return STAKING_PROVIDER_IDENTITIES.find((identity) => identity.id === id) ?? null;
}
