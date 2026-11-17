# flighttruth

**Is my flight actually on time?** Airline apps, airport boards and flight trackers each tell a
slightly different story, and none of them says whether your connection will hold.

flighttruth is a small self-hosted server that watches your trips:
- It asks a dozen sources about every leg and reconciles what they say.
- It follows the plane that will fly you, so a late inbound plane warns you before the departure
  board does.
- It pushes changes to your phone through [ntfy](https://ntfy.sh).

One person runs it for themselves and the people they travel with. It is not a multi-user service.

## What it does

- **Trips, not single flights.** Enter `LX100 LX200 2026-03-14` and it watches both legs and the
  connection between them. The connection is judged against the airport's minimum connection
  time: OK, tight or at risk.
- **Cross-checks sources.** Every field is reconciled across the sources that report it, weighted
  by how much each source is trusted for that kind of field: gate, estimate, tail number,
  aircraft type, and so on. A value only one source reports is marked unconfirmed, and the API
  keeps every observation.
- **The inbound plane.** It looks at where your aircraft is now and what it flew earlier that day,
  and warns when its turnaround is too short for an on-time departure.
- **Live position** from the free ADS-B feeds (adsb.lol, adsb.fi, OpenSky). It searches by the
  plane's registration first, then by the callsign it actually broadcasts. Airlines often fly
  under callsigns unrelated to the flight number.
- **Pushes that mean something.** Aircraft assigned or swapped, left the gate, took off, landed,
  at the gate with the baggage belt, an arrival estimate that moved by 15 minutes or more, and a
  connection that has become at risk. Each goes out once, and old news is never pushed.
- **A phone-first trip page.** One line on where things stand, a flight strip per leg, every
  detail, and a timeline of what was pushed.

## Sources

| Source | Needs | Gives |
|---|---|---|
| adsb.lol, adsb.fi, OpenSky | nothing | live position, tail, type |
| Ben Gurion (TLV) board, Israel open data | nothing | schedule, estimates, terminal, status |
| Aena boards (Spanish airports) | nothing | schedule, estimates, gate, terminal, belt, status |
| FlightStats, FlightAware, Flightradar24 pages | `BRIGHTDATA_API_KEY` | schedule, gates, tail, codeshares, the plane's earlier flights |
| Google's flight card | `BRIGHTDATA_API_KEY` | schedule and status |
| Etihad's own status | `BRIGHTDATA_BROWSER_WSS` | the airline's own times |
| FlightAware AeroAPI | `AEROAPI_KEY` | schedule, estimates, gates, tail |
| AeroDataBox | `AERODATABOX_KEY` | schedule, estimates, gates, belts, tail |

The paid sources are throttled to stay inside small monthly quotas: they're called often near
departure and rarely before.

Sources fall into three groups:
- **Free ADS-B feeds**, which see only planes in the air.
- **Airport boards**, which answer only for their own airports. They run in a second pass, once
  the other sources have said where the flight goes.
- **Scraped and API sources.**

Today, adding a source means implementing `SourceFetcher` in `src/types.ts` and registering it
in `src/sources/index.ts`. Source plugins are on the [roadmap](#roadmap).

## Architecture

```
src/server.ts          express: the API and the static pages in public/
src/poller.ts          polls each active trip, faster near departure, and decides what to push
src/lookupFlight.ts    asks every source about one flight, then the route-aware second pass
src/aggregate.ts       reconciles values across sources, using the weights in src/types.ts
src/trip.ts            the trip view: phases, milestones, connections and their risk
src/enrich.ts          the plane's earlier flights that day, and the route's track record
src/alerts.ts          turns view changes into pushes, sent through ntfy
src/store.ts           SQLite (node:sqlite): trips, observations, sent alerts
public/                the trip pages, plain ES modules with no build step
```

## Security model

The API has **no authentication**, and adding a trip can trigger paid scrapes. So the server
binds to `127.0.0.1` by default. To reach it from your phone, bind it to an address only you can
reach, such as a VPN or tailnet interface, or put it behind an authenticating proxy. Don't
expose it to the internet.

Your ntfy topic works like a password: anyone who knows it can read your pushes.

## Setup

You need Node.js 24 or newer (it uses the built-in `node:sqlite`).

```sh
git clone <this repo> flighttruth && cd flighttruth
npm ci
cp .env.example .env      # then fill in what you use; everything is optional
npm start                 # http://127.0.0.1:3000
```

Open the page, enter flight numbers and a date, and subscribe to your `NTFY_TOPIC` in the ntfy
app. To run it as a service, `packaging/flighttruth.service` is a systemd user unit; install
steps are in its header.

## Configuration

All settings are environment variables, read from `.env` in the repo root. `.env.example` lists
and explains every one of them.

## Development

```sh
npm test                  # vitest
npx tsc --noEmit -p .
npm run dev               # restarts on change
git config core.hooksPath .githooks   # the PII guard: this repo is public
```

Fixtures in `tests/fixtures/` are trimmed live captures of public flight pages. When a site
changes its markup, recapture and trim a new one.

The reference tables in `data/` are rebuilt by the scripts in `scripts/`. See `data/README.md`
for their sources and licences.

## Roadmap

Not in v0.1, but planned:

- **Source plugins**, so a new source can be added without touching the core:
  - simple airport boards described in a small declarative file;
  - script sources: any executable that reads the flight query as JSON on stdin and prints
    what it found as JSON on stdout, in whatever language you like;
  - later, a shared index of sources contributed by others.
- **Screenshots** in this README, of an invented trip.

## Licence

[AGPL-3.0](LICENSE).
