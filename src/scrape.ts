export interface ScrapeOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

// Calls Bright Data's request API directly rather than shelling out to the `bdata` CLI: the CLI
// reports every refusal as "fetch failed", while the API says why in x-brd-err-msg (e.g. the
// calling IP isn't on the zone's allowlist) -- and a 200 with an x-brd-error header is a failure.
export async function scrapeHtml(
  url: string,
  { apiKey = process.env.BRIGHTDATA_API_KEY, fetchImpl = fetch }: ScrapeOptions = {}
): Promise<string> {
  if (!apiKey) throw new Error('BRIGHTDATA_API_KEY is not set');
  const res = await fetchImpl('https://api.brightdata.com/request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ zone: process.env.BRIGHTDATA_UNLOCKER_ZONE || 'web_unlocker', url, format: 'raw' }),
    signal: AbortSignal.timeout(90_000),
  });
  const brdError = res.headers.get('x-brd-err-msg') ?? res.headers.get('x-brd-error');
  if (brdError) throw new Error(`Bright Data: ${brdError}`);
  if (!res.ok) throw new Error(`Bright Data: HTTP ${res.status}`);
  return res.text();
}
