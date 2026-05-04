/**
 * Outbound HTTP helpers for upstream (Azure) calls.
 * Enforces HTTPS — Bun handles TLS negotiation (typically TLS 1.2+ / 1.3).
 */

function urlString(input: string | URL): string {
  return typeof input === 'string' ? input : input.toString();
}

/**
 * Fetch for upstream Azure endpoints — requires HTTPS URL.
 */
export async function upstreamHttpsFetch(
  input: string | URL,
  options: RequestInit = {}
): Promise<Response> {
  const url = urlString(input);
  if (!url.startsWith('https://')) {
    throw new Error('Upstream requests must use HTTPS');
  }
  return fetch(input, options);
}
