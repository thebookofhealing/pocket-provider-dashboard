# Pocket Provider Dashboard

Public-facing Pocket Network dashboard focused on service demand, reward trends, and provider onboarding economics without naming or ranking commercial providers.

## Branch Scope

- `main`: PNF-safe public dashboard. It does not expose named provider leaderboards, provider detail pages, staker rankings, supplier playbooks, or per-provider service mix in the UI or public dashboard API payloads.
- `provider`: operator/provider intelligence edition preserved from the pre-PNF-feedback dashboard. It includes named provider rankings, provider detail reports, staker yield rankings, and infrastructure deep dives for private operator analysis.

## Overview

This project is a Next.js app that turns live Pocket Network data into a simple provider-side market view.

The current public demo focuses on:

- aggregate provider-side revenue across `24h`, `7d`, and `30d` windows
- relay demand across active services
- high-demand services, supplier competition, and service opportunity scoring
- a growth calculator for early provider planning

## Current Product Scope

This repository does **not** implement the full RC1 architecture described in the technical docs yet.

Today, the project is intentionally lightweight:

- a Next.js application for the UI and read-only API routes
- a separate Node.js indexer for Pocket RPC/WebSocket data collection
- a compact local SQLite store for indexed settlement facts, metadata, and dashboard snapshots
- direct Pocket RPC as the primary source of truth
- a legacy `Poktscan` ingestion worker kept temporarily as fallback while the indexer is validated
- provider grouping at the domain level inside the ingestion model, with named provider data removed from public `main` surfaces

That makes it a good public demo, but not yet a full historical analytics product backed by a dedicated indexer.

## Data Sources

The dashboard uses an indexer-first data strategy.

### Primary path: Pocket RPC indexer

The `pocket-indexer` process subscribes to CometBFT new blocks over WebSocket, repairs missing heights from the last retention window over HTTP RPC, parses `EventClaimSettled`, and writes compact settlement facts to SQLite. The UI reads only materialized SQLite cache payloads.

Live indexing and historical repair run in the same process. A fresh or partially indexed database can start in production immediately: WebSocket tailing follows new blocks while the repair loop fills gaps in the last `POCKET_INDEXER_RETENTION_DAYS` in the background.

### Legacy fallback: `Poktscan`

The older `npm run worker` ingestion path can still populate snapshots through `Poktscan` and RPC fallback, but it is no longer the preferred production data path.
Its default GraphQL endpoint is `https://data.pocket.network/`; override it with `POKTSCAN_API_URL` only when testing an alternate compatible endpoint.

### Legacy RPC fallback semantics

The legacy `npm run worker` path can fall back to Pocket Shannon RPC and read settlement information from `end_block_events`.

In fallback mode it:

- uses `block_search` to find recent blocks containing `EventClaimSettled`
- fetches only a recent sample of settlement blocks per time window
- skips slow or heavy `block_results` responses automatically

In this mode, provider-side revenue is computed from the supplier-side share inside `reward_distribution_detailed`.

## Demo Semantics

Some details are important when reading the numbers shown in the UI.

- The public dashboard shows provider-domain metrics only as aggregate counts, averages, medians, and concentration measures.
- Named provider rankings and provider-level operational detail are intentionally out of scope for `main`.
- The preserved `provider` branch keeps the provider/operator edition for private analysis.
- USD values are derived from the live CoinGecko price for `pocket-network`.
- Time windows are based on settlement block time from indexed Pocket blocks.
- The growth calculator is deliberately simple and designed to provide plausible onboarding guidance, not exact protocol-level forecasting.

## Default Endpoints

- RPC pool:
  - `https://sauron-rpc.infra.pocket.network`
  - `https://pocket-rpc.polkachu.com:443`
  - `https://pocket.api.pocket.network:443`
  - `https://pocket-rpc.kleomedes.network`
- REST:
  - `https://sauron-api.infra.pocket.network`

## Environment Variables

Optional overrides:

- `POCKET_RPC_URL`
- `POCKET_RPC_URLS` comma-separated custom RPC pool
- `POCKET_REST_URL`
- `POKTSCAN_API_URL`
- `POCKET_LEGACY_RPC_FALLBACK_ENABLED=true` opt-in guard for the old worker's heavy RPC fallback
- `POCKET_SQLITE_PATH` absolute persistent SQLite path; required in production and shared by the web and indexer processes

## Local Development

```bash
npm install
npm run ingest
npm run dev
```

Then open `http://localhost:3000`.

The analytics UI reads local SQLite snapshots only. The `/api/health` endpoint and Network Health surface additionally perform the bounded read-only RPC status probe described below. In development, if no local snapshot exists, `npm run dev` serves deterministic PNF-safe dummy analytics data so UI/UX work can continue without running the indexer. Set `POCKET_DISABLE_DEV_DUMMY_DATA=true` to see the real warming state instead.

## Production Runtime

Run the web process and indexer separately:

```bash
npm run build
npm run start
npm run indexer
```

With PM2:

```bash
export POCKET_SQLITE_PATH=/var/lib/pocket-dashboard/pocket-dashboard.sqlite
pm2 start ecosystem.config.cjs
pm2 save
```

The checked-in PM2 configuration requires one absolute persistent `POCKET_SQLITE_PATH`, passes that exact path to both processes, and starts the web process read-only (`POCKET_DB_READONLY=true`) while leaving the indexer as the only writer. Production startup fails closed when the path is missing or relative; the web process also requires the database file to already exist and never creates tables, runs migrations, or writes metadata. Verify both are online after every deployment:

```bash
pm2 status
pm2 logs pocket-indexer --lines 100
curl -fsS http://127.0.0.1:3100/api/health
```

If `/api/health` reports `status: "stale"`, restart the indexer and confirm that `highestIngestedHeight` and `freshnessTimestamp` advance:

```bash
pm2 restart pocket-indexer
pm2 logs pocket-indexer --lines 100
```

The indexer owns all Pocket RPC/WebSocket ingestion requests and writes dashboard snapshots to SQLite. Normal analytics/data requests read the canonical SQLite snapshots only; the `/api/health` endpoint and Network Health surface are the narrow exception, using a bounded read-only RPC status probe solely to observe the independent chain tip. Production `npm run indexer` is live-first: it opens the WebSocket immediately, runs bounded live catchup in the background, and lets the repair loop fill historical gaps without blocking current-height sync. `npm run indexer:backfill` remains available for manual/debug runs, but production should normally only run `npm run indexer`.

Temporary legacy fallback:

```bash
pm2 start npm --name pocket-worker -- run worker
```

The legacy worker does not enable its RPC fallback by default. If `Poktscan` fails, it serves stale snapshots when available instead of scanning the 30d RPC fallback path. Enable the old fallback only for manual debugging:

```bash
POCKET_LEGACY_RPC_FALLBACK_ENABLED=true npm run worker
```

Optional worker interval override:

```bash
POCKET_INGEST_INTERVAL_MS=3600000 npm run worker
```

Indexer commands:

```bash
npm run indexer
npm run indexer:once
npm run indexer:backfill
tsx scripts/indexer.ts --from-height 123456 --to-height 124000 --once
```

Manual backfill uses concurrent RPC reads from newest height to oldest height, so recent data is prioritized before older historical gaps. For debug backfills, tune throughput conservatively against your RPC pool:

```bash
POCKET_INDEXER_BACKFILL_CONCURRENCY=8 POCKET_INDEXER_BACKFILL_BATCH_SIZE=500 npm run indexer:backfill
```

If the RPC pool is slow or rate-limited, reduce concurrency and increase the per-request timeout. The indexer retries failed RPC calls across the full node pool before aborting, and progress logs include per-node success/failure/timeout counters.

```bash
POCKET_INDEXER_RPC_TIMEOUT_MS=30000 POCKET_INDEXER_BACKFILL_CONCURRENCY=2 POCKET_INDEXER_BACKFILL_BATCH_SIZE=100 npm run indexer:backfill
```

Indexer environment variables:

- `POCKET_RPC_URLS` comma-separated RPC pool used for WebSocket and HTTP fallback
- `POCKET_BACKFILL_RPC_URLS` optional comma-separated RPC pool used first for repair/backfill reads
- `POCKET_INDEXER_START_HEIGHT` optional first height when no checkpoint exists
- `POCKET_INDEXER_RETENTION_DAYS` defaults to `45`
- `POCKET_INDEXER_CACHE_INTERVAL_MS` defaults to `30000`
- `POCKET_INDEXER_RPC_TIMEOUT_MS` defaults to `8000`
- `POCKET_INDEXER_RPC_RETRIES` defaults to `3` attempts across the RPC pool
- `POCKET_INDEXER_RPC_RETRY_DELAY_MS` defaults to `500`
- `POCKET_INDEXER_BLOCK_RETRIES` defaults to `5` height-level retries
- `POCKET_INDEXER_AVG_BLOCK_SECONDS` defaults to `60` for Pocket backfill height estimation
- `POCKET_INDEXER_BACKFILL_CONCURRENCY` defaults to `8`
- `POCKET_INDEXER_BACKFILL_BATCH_SIZE` defaults to `500`
- `POCKET_INDEXER_REPAIR_INTERVAL_MS` defaults to `60000`
- `POCKET_INDEXER_REPAIR_BATCH_SIZE` defaults to `250`
- `POCKET_INDEXER_REPAIR_CONCURRENCY` defaults to `4`
- `POCKET_INDEXER_REPAIR_FAILED_COOLDOWN_MS` defaults to `300000`
- `POCKET_INDEXER_REPAIR_MAX_FAILED_RETRIES` defaults to `10`
- `POCKET_INDEXER_LIVE_CATCHUP_MAX_BLOCKS` defaults to `1000`; live mode skips stale checkpoints with larger gaps instead of replaying history
- `POCKET_INDEXER_STALE_AFTER_MS` defaults to `900000` (15 minutes); the health endpoint reports stale data after this interval
- `POCKET_INDEXER_HASH_SALT` salt for privacy-preserving supplier/operator hashes
- `POCKET_UI_MEMORY_CACHE_MS` defaults to `30000`

## Verification

```bash
npm run typecheck
npm run build
```

## Caching

The app uses:

- SQLite persistence for settlement blocks, metadata, and dashboard snapshots
- compact indexed settlement facts with a default 45-day retention window
- `job_runs` records for ingestion success/failure tracking
- materialized UI JSON cache payloads read directly by Next.js

This keeps the public demo responsive and reduces repeated network fetches.

## Repository Context

If you want the longer-term direction for the project, see:

- `TECHNICAL_DESIGN.md`
- `ROADMAP.md`

Those documents describe the path toward a more rigorous RC1 architecture. The implementation in this repository is the current public demo version.
