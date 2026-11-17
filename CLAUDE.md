# flighttruth

A self-hosted flight-status cross-checker. It watches a few trips, asks many sources, reconciles
what they say, and pushes changes to ntfy. README.md covers what it does and how it is laid out.

## This repo is public

Never commit personal data:
- real trips or itineraries;
- names, hostnames or addresses;
- ntfy topics or API keys;
- screenshots of real trips.

Tests and fixtures use invented flights, or trimmed captures of public flight pages that say
nothing about who looked them up.

The PII guard in `.githooks/` blocks commits and pushes that look like personal data. Turn it on
once per clone with `git config core.hooksPath .githooks`. CI runs its shape checks too.

Maintainers keep design notes and their own deployment config outside this repo. If a
`CLAUDE.local.md` exists (it's gitignored), read it to find where those live.

## Running

- `npm test` (vitest), `npx tsc --noEmit -p .`
- `npm start` serves on `127.0.0.1:3000`. `HOST` and `PORT` change that (see `.env.example`).
- `public/` is served from disk, so UI changes need no restart.
- Scraped sites change their markup. Fixtures in `tests/fixtures/` are captured live, then trimmed.
- Each optional source is switched on by an env var (`src/sources/index.ts`). With none set, the
  free sources still run: ADS-B feeds and the Ben Gurion and Aena airport boards.
