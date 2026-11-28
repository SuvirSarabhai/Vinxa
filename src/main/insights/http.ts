export type Fetcher = typeof fetch
export class ProviderUnavailable extends Error {}
export class InvalidProviderResponse extends Error {}
export async function requestJson(fetcher: Fetcher, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('The notes provider rejected the API key.')
      if (response.status === 429) throw new ProviderUnavailable('The notes provider rate limit was reached. Try generating notes later.')
      if (response.status >= 500) throw new ProviderUnavailable('The notes provider is temporarily unavailable.')
      throw new Error('The notes provider returned HTTP ' + response.status + '.')
    }
    return await response.json() as unknown
  } catch (error) {
    if (error instanceof SyntaxError) throw new InvalidProviderResponse('The notes provider returned invalid JSON.')
    if (error instanceof Error && error.message.startsWith('The notes provider')) throw error
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new Error('Notes generation timed out.')
    throw new ProviderUnavailable('The notes provider could not be reached.')
  }
}
