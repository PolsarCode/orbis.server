export async function fetchImage(url: string, timeoutMs: number) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (
    !response.ok ||
    !response.headers.get('content-type')?.startsWith('image/')
  ) {
    throw new Error(`Image request failed with ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
