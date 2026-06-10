export async function upstreamHttpsFetch(
  input: string | URL,
  options: RequestInit = {},
): Promise<Response> {
  const url = typeof input === 'string' ? input : input.toString();
  if (!url.startsWith('https://')) {
    throw new Error('Upstream requests must use HTTPS');
  }
  return fetch(input, options);
}
