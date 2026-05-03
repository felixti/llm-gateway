/**
 * Outbound HTTP helpers for upstream (Azure) calls.
 * Enforces HTTPS — Bun handles TLS negotiation (typically TLS 1.2+ / 1.3).
 */

export interface UpstreamFetchOptions extends RequestInit {
  /** Reserved for future certificate pinning / TLS options */
  validateCert?: boolean;
}

export const TLS_VERSION = {
  TLS_1_2: 0x0303,
  TLS_1_3: 0x0304,
} as const;

function urlString(input: string | URL): string {
  return typeof input === 'string' ? input : input.toString();
}

/**
 * Fetch for upstream Azure endpoints — requires HTTPS URL.
 */
export async function upstreamHttpsFetch(
  input: string | URL,
  options: UpstreamFetchOptions = {}
): Promise<Response> {
  const url = urlString(input);
  if (!url.startsWith('https://')) {
    throw new Error('Upstream requests must use HTTPS');
  }
  return fetch(input, options);
}

export function createUpstreamFetcher(): typeof upstreamHttpsFetch {
  return upstreamHttpsFetch;
}
