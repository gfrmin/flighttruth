import { describe, it, expect } from 'vitest';
import { scrapeHtml } from '../src/scrape.js';

const fakeFetch = (status: number, body: string, headers: Record<string, string> = {}) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status, headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
};

describe('scrapeHtml', () => {
  it('posts the URL to the Bright Data request API with the web_unlocker zone', async () => {
    const { impl, calls } = fakeFetch(200, '<html>ok</html>', { 'x-brd-status-code': '200' });
    const html = await scrapeHtml('https://example.com/x', { apiKey: 'k', fetchImpl: impl });
    expect(html).toBe('<html>ok</html>');
    expect(calls[0].url).toBe('https://api.brightdata.com/request');
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer k' });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ zone: 'web_unlocker', url: 'https://example.com/x', format: 'raw' });
  });

  it("surfaces Bright Data's own error message, e.g. a non-allowlisted IP", async () => {
    const { impl } = fakeFetch(200, '', {
      'x-brd-error': 'Auth Failed (code: ip_forbidden)',
      'x-brd-err-msg': 'The IP address ... is not whitelisted',
    });
    await expect(scrapeHtml('https://example.com', { apiKey: 'k', fetchImpl: impl })).rejects.toThrow(
      /Bright Data: The IP address \.\.\. is not whitelisted/
    );
  });

  it('rejects on a non-2xx response', async () => {
    const { impl } = fakeFetch(401, 'bad key');
    await expect(scrapeHtml('https://example.com', { apiKey: 'k', fetchImpl: impl })).rejects.toThrow(/401/);
  });

  it('fails clearly without an API key', async () => {
    await expect(scrapeHtml('https://example.com', { apiKey: undefined })).rejects.toThrow(/BRIGHTDATA_API_KEY/);
  });
});
