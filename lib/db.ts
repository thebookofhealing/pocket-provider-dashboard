import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

type CachedSettlementBlockRow = {
  height: number;
  block_time: string;
  events_json: string;
};

export type IndexedSettlementFact = {
  height: number;
  eventIndex: number;
  blockTime: number;
  day: string;
  hour: string;
  serviceId: string;
  supplierHash: string;
  ownerHash: string | null;
  relays: number;
  estimatedRelays?: number;
  claimedComputeUnits?: number;
  estimatedComputeUnits?: number;
  revenueUpokt: string;
  ingestionSource?: string;
  sourceRecordId?: string;
};

export type IndexedService = {
  serviceId: string;
  serviceName: string;
  computeUnitsPerRelay: number | null;
};

export type IndexedSupplierDomain = {
  supplierHash: string;
  domainHash: string;
  hasEndpoint: boolean;
};

export type IndexedHeightStatus = "indexed" | "empty" | "partial" | "failed";

export type IndexedHeightCoverage = {
  height: number;
  status: IndexedHeightStatus;
  event_count: number;
  failure_count: number;
  last_error: string | null;
  scanned_at: string;
  block_time: number | null;
  day: string | null;
  source: string;
  block_complete: number;
  workload_complete: number;
  reward_complete: number;
};

export type IndexedServiceAggregate = {
  service_id: string;
  service_name: string | null;
  compute_units_per_relay: number | null;
  relays: number;
  estimated_relays: number;
  estimated_compute_units: number;
  relay_coverage: number;
  revenue_upokt: string;
  supplier_count: number;
  provider_count: number;
};

export type IndexedProviderAggregate = {
  supplier_hash: string;
  relays: number;
  revenue_upokt: string;
  service_count: number;
};

export type IndexedDailyAggregate = {
  day: string;
  relays: number;
  estimated_relays: number;
  estimated_compute_units: number;
  relay_coverage: number;
  revenue_upokt: string;
};

const defaultDbPath = path.join(process.cwd(), "data", "pocket-dashboard.sqlite");
const dbPath = process.env.POCKET_SQLITE_PATH ?? defaultDbPath;
const isReadOnly = process.env.POCKET_DB_READONLY === "true";

export function isDatabaseReadOnly(): boolean {
  return isReadOnly;
}

export function acquireIndexerLock(): boolean {
  if (isReadOnly) return false;
  const lockfile = path.join(path.dirname(dbPath), "indexer.lock");
  try {
    const fd = fs.openSync(lockfile, "wx");
    fs.writeSync(fd, `${process.pid}\n`);
    fs.closeSync(fd);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const content = fs.readFileSync(lockfile, "utf-8").trim();
        const pid = Number.parseInt(content.split("\n")[0], 10);
        if (pid > 0) {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            const stat = fs.statSync(lockfile);
            const staleAge = Date.now() - stat.mtimeMs;
            if (staleAge < 5000) return false;
            fs.unlinkSync(lockfile);
            const fd2 = fs.openSync(lockfile, "wx");
            fs.writeSync(fd2, `${process.pid}\n${stat.ino}\n`);
            fs.closeSync(fd2);
            return true;
          }
        }
      } catch { /* can't read — don't claim ownership */ }
    }
    return false;
  }
}

export function releaseIndexerLock(): void {
  if (isReadOnly) return;
  try {
    const lockfile = path.join(path.dirname(dbPath), "indexer.lock");
    if (fs.existsSync(lockfile)) {
      const content = fs.readFileSync(lockfile, "utf-8").trim();
      const pid = Number.parseInt(content.split("\n")[0], 10);
      if (pid === process.pid) {
        fs.unlinkSync(lockfile);
      }
    }
  } catch { /* best-effort cleanup */ }
}

export type IndexerHealth = {
  schemaVersion: string | null;
  dataVersion: string | null;
  processedHeight: number | null;
  targetHeight: number | null;
  ingestedHeight: number | null;
  latestIndexedBlockTime: number | null;
  lastIndexedAt: string | null;
  lastSuccessfulCommit: string | null;
  lastBackup: string | null;
  isLocked: boolean;
  gaps: number;
  failedHeights: number;
  missingHeights: number;
  emptyNullTimestamps: number;
  partialWorkloadHeights: number;
  partialRewardHeights: number;
};

export function getIndexerHealth(): IndexerHealth {
  let isLocked = false;
  try {
    const lockfile = path.join(path.dirname(dbPath), "indexer.lock");
    if (fs.existsSync(lockfile)) {
      const content = fs.readFileSync(lockfile, "utf-8").trim();
      const pid = Number.parseInt(content.split("\n")[0], 10);
      try { process.kill(pid, 0); isLocked = true; } catch { /* stale */ }
    }
  } catch { /* ignored */ }

  try {
    const dataVersion = getIndexerState("data_version");
    const processedHeight = getIndexerState("contiguous_processed_height");
    const targetHeight = getIndexerState("highest_seen_height");
    const ingestedHeightStr = getIndexerState("highest_ingested_height");
    const latestIndexedBlock = db.prepare(`
      SELECT block_time AS blockTime, scanned_at AS scannedAt
      FROM indexed_heights
      WHERE status IN ('indexed', 'empty') AND block_time IS NOT NULL
      ORDER BY height DESC
      LIMIT 1
    `).get() as { blockTime: number | null; scannedAt: string | null } | undefined;
    let gaps = 0;
    let failedHeights = 0;
    let emptyNullTimestamps = 0;
    let partialWorkloadHeights = 0;
    let partialRewardHeights = 0;
    let missingHeights = 0;
    const processedH = processedHeight ? Number.parseInt(processedHeight, 10) || 0 : 0;
    const seenH = targetHeight ? Number.parseInt(targetHeight, 10) || 0 : 0;
    const retentionDays = Number(process.env.POCKET_INDEXER_RETENTION_DAYS ?? 45);
    const averageBlockSeconds = Math.max(1, Number(process.env.POCKET_INDEXER_AVG_BLOCK_SECONDS ?? 60));
    const retentionBlocks = Math.ceil((retentionDays * 86400) / averageBlockSeconds);
    const retentionStartH = seenH > 0 ? Math.max(1, seenH - retentionBlocks + 1) : Math.max(1, processedH - retentionBlocks);
    try {
      const gapRow = selectGapCountStatement.get() as { gaps: number; failed: number } | undefined;
      if (gapRow) { gaps = gapRow.gaps; failedHeights = gapRow.failed; }
      emptyNullTimestamps = getEmptyNullTimestampCount();
      partialWorkloadHeights = getPartialWorkloadHeights();
      partialRewardHeights = getPartialRewardHeights();
      if (processedH > 0 && seenH > 0) {
        missingHeights = getMissingHeightCount(retentionStartH, seenH);
      }
    } catch { }
    return {
      schemaVersion: getMeta("schema_version") ?? null,
      dataVersion: dataVersion ?? null,
      processedHeight: processedHeight ? Number.parseInt(processedHeight, 10) || null : null,
      targetHeight: targetHeight ? Number.parseInt(targetHeight, 10) || null : null,
      ingestedHeight: ingestedHeightStr ? Number.parseInt(ingestedHeightStr, 10) || null : null,
      latestIndexedBlockTime: latestIndexedBlock?.blockTime ?? null,
      lastIndexedAt: latestIndexedBlock?.scannedAt ?? null,
      lastSuccessfulCommit: getIndexerState("last_successful_commit") ?? null,
      lastBackup: getIndexerState("last_backup") ?? null,
      isLocked,
      gaps,
      failedHeights,
      missingHeights,
      emptyNullTimestamps,
      partialWorkloadHeights,
      partialRewardHeights,
    };
  } catch {
    return {
      schemaVersion: null,
      dataVersion: null,
      processedHeight: null,
      targetHeight: null,
      ingestedHeight: null,
      latestIndexedBlockTime: null,
      lastIndexedAt: null,
      lastSuccessfulCommit: null,
      lastBackup: null,
      isLocked,
      gaps: 0,
      failedHeights: 0,
      missingHeights: 0,
      emptyNullTimestamps: 0,
      partialWorkloadHeights: 0,
      partialRewardHeights: 0,
    };
  }
}

let db: Database.Database;

if (isReadOnly) {
  if (!process.env.POCKET_SQLITE_PATH) {
    throw new Error("POCKET_SQLITE_PATH must be set when POCKET_DB_READONLY=true");
  }
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 10000");
} else {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 10000");
  db.exec(`
  CREATE TABLE IF NOT EXISTS settlement_blocks (
    height INTEGER PRIMARY KEY,
    block_time TEXT NOT NULL,
    events_json TEXT NOT NULL,
    scanned_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dashboard_cache (
    window TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_ms INTEGER,
    error TEXT,
    metadata_json TEXT
  );

  CREATE TABLE IF NOT EXISTS indexer_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS service_dim (
    service_id TEXT PRIMARY KEY,
    service_name TEXT NOT NULL,
    compute_units_per_relay REAL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS supplier_domain_dim (
    supplier_hash TEXT PRIMARY KEY,
    domain_hash TEXT NOT NULL,
    has_endpoint INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settlement_facts (
    height INTEGER NOT NULL,
    event_index INTEGER NOT NULL,
    block_time INTEGER NOT NULL,
    day TEXT NOT NULL,
    hour TEXT NOT NULL,
    service_id TEXT NOT NULL,
    supplier_hash TEXT NOT NULL,
    owner_hash TEXT,
    relays INTEGER NOT NULL,
    estimated_relays INTEGER,
    claimed_compute_units INTEGER,
    estimated_compute_units INTEGER,
    revenue_upokt TEXT NOT NULL,
    PRIMARY KEY (height, event_index)
  );

  CREATE TABLE IF NOT EXISTS indexed_heights (
    height INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    scanned_at TEXT NOT NULL,
    event_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS daily_rollups (
    day TEXT PRIMARY KEY,
    total_relays INTEGER NOT NULL,
    estimated_relays INTEGER,
    estimated_compute_units INTEGER,
    revenue_upokt TEXT NOT NULL,
    relay_coverage REAL NOT NULL DEFAULT 0,
    generated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS graphql_settlement_facts (
    source_record_id TEXT PRIMARY KEY,
    height INTEGER NOT NULL,
    block_time INTEGER NOT NULL,
    day TEXT NOT NULL,
    service_id TEXT NOT NULL,
    supplier_hash TEXT NOT NULL,
    owner_hash TEXT,
    relays INTEGER,
    estimated_relays INTEGER,
    estimated_compute_units INTEGER,
    claimed_amount TEXT,
    settled_amount TEXT,
    fetched_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS graphql_settlement_facts_height_idx ON graphql_settlement_facts(height);

  CREATE TABLE IF NOT EXISTS block_headers (
    height INTEGER PRIMARY KEY,
    block_time INTEGER NOT NULL,
    day TEXT NOT NULL,
    source TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS block_headers_time_idx ON block_headers(block_time);

  CREATE INDEX IF NOT EXISTS settlement_facts_time_idx ON settlement_facts(block_time);
  CREATE INDEX IF NOT EXISTS settlement_facts_service_time_idx ON settlement_facts(service_id, block_time);
  CREATE INDEX IF NOT EXISTS settlement_facts_day_idx ON settlement_facts(day);
  CREATE INDEX IF NOT EXISTS settlement_facts_supplier_time_idx ON settlement_facts(supplier_hash, block_time);
  CREATE INDEX IF NOT EXISTS supplier_domain_dim_domain_idx ON supplier_domain_dim(domain_hash);
  CREATE INDEX IF NOT EXISTS indexed_heights_status_idx ON indexed_heights(status, height);
`);

  for (const col of ["estimated_relays", "claimed_compute_units", "estimated_compute_units"]) {
    try { db.exec(`ALTER TABLE settlement_facts ADD COLUMN ${col} INTEGER`); } catch { /* column already exists */ }
  }

  const settlementFactsColumns = db.prepare("PRAGMA table_info(settlement_facts)").all() as Array<{ name: string }>;
  const hasLegacyColumn = (col: string) => settlementFactsColumns.some((c) => c.name === col);
  if (!hasLegacyColumn("relays")) {
    try { db.exec("ALTER TABLE settlement_facts ADD COLUMN relays INTEGER"); } catch { /* fallback */ }
  }

  for (const alter of [
    "ALTER TABLE indexed_heights ADD COLUMN block_time INTEGER",
    "ALTER TABLE indexed_heights ADD COLUMN day TEXT",
    "ALTER TABLE indexed_heights ADD COLUMN source TEXT NOT NULL DEFAULT 'rpc'",
    "ALTER TABLE indexed_heights ADD COLUMN block_complete INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE indexed_heights ADD COLUMN workload_complete INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE indexed_heights ADD COLUMN reward_complete INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE settlement_facts ADD COLUMN ingestion_source TEXT NOT NULL DEFAULT 'rpc'",
    "ALTER TABLE settlement_facts ADD COLUMN source_record_id TEXT",
  ]) {
    try { db.exec(alter); } catch { /* column already exists */ }
  }
}

const selectSettlementBlocksStatement = db.prepare(
  `SELECT height, block_time, events_json FROM settlement_blocks WHERE height IN (${Array.from({ length: 999 }, () => "?").join(",")})`
);

const insertSettlementBlockStatement = db.prepare(
  `
    INSERT INTO settlement_blocks (height, block_time, events_json, scanned_at)
    VALUES (@height, @block_time, @events_json, @scanned_at)
    ON CONFLICT(height) DO UPDATE SET
      block_time = excluded.block_time,
      events_json = excluded.events_json,
      scanned_at = excluded.scanned_at
  `
);

const selectMetaStatement = db.prepare("SELECT value FROM meta WHERE key = ?");

const upsertMetaStatement = db.prepare(
  `
    INSERT INTO meta (key, value, updated_at)
    VALUES (@key, @value, @updated_at)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `
);

const selectDashboardCacheStatement = db.prepare(
  "SELECT payload_json, updated_at FROM dashboard_cache WHERE window = ?"
);

const upsertDashboardCacheStatement = db.prepare(
  `
    INSERT INTO dashboard_cache (window, payload_json, updated_at)
    VALUES (@window, @payload_json, @updated_at)
    ON CONFLICT(window) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `
);

const insertJobRunStatement = db.prepare(
  `
    INSERT INTO job_runs (job_name, status, started_at, metadata_json)
    VALUES (@job_name, @status, @started_at, @metadata_json)
  `
);

const updateJobRunStatement = db.prepare(
  `
    UPDATE job_runs
    SET status = @status,
        finished_at = @finished_at,
        duration_ms = @duration_ms,
        error = @error,
        metadata_json = @metadata_json
    WHERE id = @id
  `
);

const upsertIndexerStateStatement = db.prepare(
  `
    INSERT INTO indexer_state (key, value, updated_at)
    VALUES (@key, @value, @updated_at)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `
);

const selectIndexerStateStatement = db.prepare("SELECT value FROM indexer_state WHERE key = ?");

const upsertServiceStatement = db.prepare(
  `
    INSERT INTO service_dim (service_id, service_name, compute_units_per_relay, updated_at)
    VALUES (@service_id, @service_name, @compute_units_per_relay, @updated_at)
    ON CONFLICT(service_id) DO UPDATE SET
      service_name = excluded.service_name,
      compute_units_per_relay = excluded.compute_units_per_relay,
      updated_at = excluded.updated_at
  `
);

const upsertSupplierDomainStatement = db.prepare(
  `
    INSERT INTO supplier_domain_dim (supplier_hash, domain_hash, has_endpoint, updated_at)
    VALUES (@supplier_hash, @domain_hash, @has_endpoint, @updated_at)
    ON CONFLICT(supplier_hash) DO UPDATE SET
      domain_hash = excluded.domain_hash,
      has_endpoint = excluded.has_endpoint,
      updated_at = excluded.updated_at
  `
);

const insertSettlementFactStatement = db.prepare(
  `
    INSERT INTO settlement_facts (
      height,
      event_index,
      block_time,
      day,
      hour,
      service_id,
      supplier_hash,
      owner_hash,
      relays,
      estimated_relays,
      claimed_compute_units,
      estimated_compute_units,
      revenue_upokt,
      ingestion_source,
      source_record_id
    ) VALUES (
      @height,
      @event_index,
      @block_time,
      @day,
      @hour,
      @service_id,
      @supplier_hash,
      @owner_hash,
      @relays,
      @estimated_relays,
      @claimed_compute_units,
      @estimated_compute_units,
      @revenue_upokt,
      @ingestion_source,
      @source_record_id
    )
    ON CONFLICT(height, event_index) DO UPDATE SET
      estimated_relays = COALESCE(excluded.estimated_relays, settlement_facts.estimated_relays),
      claimed_compute_units = COALESCE(excluded.claimed_compute_units, settlement_facts.claimed_compute_units),
      estimated_compute_units = COALESCE(excluded.estimated_compute_units, settlement_facts.estimated_compute_units),
      ingestion_source = excluded.ingestion_source,
      source_record_id = COALESCE(excluded.source_record_id, settlement_facts.source_record_id)
  `
);

const upsertIndexedHeightStatement = db.prepare(
  `
    INSERT INTO indexed_heights (height, status, scanned_at, event_count, failure_count, last_error, block_time, day, source, block_complete, workload_complete, reward_complete)
    VALUES (@height, @status, @scanned_at, @event_count, @failure_count, @last_error, @block_time, @day, @source, @block_complete, @workload_complete, @reward_complete)
    ON CONFLICT(height) DO UPDATE SET
      status = excluded.status,
      scanned_at = excluded.scanned_at,
      event_count = excluded.event_count,
      failure_count = excluded.failure_count,
      last_error = excluded.last_error,
      block_time = COALESCE(excluded.block_time, indexed_heights.block_time),
      day = COALESCE(excluded.day, indexed_heights.day),
      source = excluded.source,
      block_complete = excluded.block_complete,
      workload_complete = excluded.workload_complete,
      reward_complete = excluded.reward_complete
  `
);

const markIndexedHeightFailedStatement = db.prepare(
  `
    INSERT INTO indexed_heights (height, status, scanned_at, event_count, failure_count, last_error, source)
    VALUES (@height, 'failed', @scanned_at, 0, 1, @last_error, @source)
    ON CONFLICT(height) DO UPDATE SET
      status = CASE WHEN indexed_heights.status = 'partial' THEN 'partial' ELSE 'failed' END,
      scanned_at = excluded.scanned_at,
      failure_count = indexed_heights.failure_count + 1,
      last_error = excluded.last_error,
      source = excluded.source,
      block_complete = CASE WHEN indexed_heights.status = 'partial' THEN indexed_heights.block_complete ELSE 0 END,
      workload_complete = CASE WHEN indexed_heights.status = 'partial' THEN 1 ELSE 0 END,
      reward_complete = CASE WHEN indexed_heights.status = 'partial' AND indexed_heights.reward_complete > 0 THEN 1 ELSE 0 END
  `
);

const selectIndexedHeightsStatement = db.prepare(
  `
    SELECT height, status, event_count, failure_count, last_error, scanned_at, block_time, day, source, block_complete, workload_complete, reward_complete
    FROM indexed_heights
    WHERE height BETWEEN ? AND ?
    ORDER BY height ASC
  `
);

const checkHeightCoverageStatement = db.prepare(
  "SELECT status FROM indexed_heights WHERE height = ?"
);

const checkGapHeightsStatement = db.prepare(
  "SELECT height, status FROM indexed_heights WHERE height >= ? AND height <= ? ORDER BY height ASC"
);

const selectFailedHeightsStatement = db.prepare(
  "SELECT height FROM indexed_heights WHERE status = 'failed' ORDER BY failure_count ASC, height DESC LIMIT ?"
);

const insertGraphQLSettlementFactStatement = db.prepare(
  `
    INSERT OR IGNORE INTO graphql_settlement_facts (source_record_id, height, block_time, day, service_id, supplier_hash, owner_hash, relays, estimated_relays, estimated_compute_units, claimed_amount, settled_amount, fetched_at)
    VALUES (@source_record_id, @height, @block_time, @day, @service_id, @supplier_hash, @owner_hash, @relays, @estimated_relays, @estimated_compute_units, @claimed_amount, @settled_amount, @fetched_at)
  `
);

const selectEmptyNullTimestampStatement = db.prepare(
  "SELECT height FROM indexed_heights WHERE status = 'empty' AND block_time IS NULL ORDER BY height ASC LIMIT ?"
);

const countEmptyNullTimestampStatement = db.prepare(
  "SELECT COUNT(*) AS count FROM indexed_heights WHERE status = 'empty' AND block_time IS NULL"
);

const selectEmptyHeightsWithoutMetadataStatement = db.prepare(
  "SELECT ih.height, sb.block_time FROM indexed_heights ih JOIN settlement_blocks sb ON sb.height = ih.height WHERE ih.status = 'empty' AND ih.block_time IS NULL ORDER BY ih.height LIMIT ?"
);

const upsertBlockHeaderStatement = db.prepare(
  `
    INSERT INTO block_headers (height, block_time, day, source, fetched_at)
    VALUES (@height, @block_time, @day, @source, @fetched_at)
    ON CONFLICT(height) DO UPDATE SET
      block_time = excluded.block_time,
      day = excluded.day,
      source = excluded.source,
      fetched_at = excluded.fetched_at
  `
);

const updateHeightTimestampStatement = db.prepare(
  "UPDATE indexed_heights SET block_time = @block_time, day = @day WHERE height = @height"
);

const completeVerifiedEmptyHeightStatement = db.prepare(
  "UPDATE indexed_heights SET block_time = @block_time, day = @day, block_complete = 1, workload_complete = 1, reward_complete = 1 WHERE height = @height AND status = 'empty'"
);

const deleteOldSettlementFactsStatement = db.prepare("DELETE FROM settlement_facts WHERE block_time < ?");
const deleteOldIndexedHeightsStatement = db.prepare("DELETE FROM indexed_heights WHERE height < ?");
const deleteOldJobRunsStatement = db.prepare(
  "DELETE FROM job_runs WHERE id NOT IN (SELECT id FROM job_runs ORDER BY id DESC LIMIT ?)"
);

const selectServiceAggregatesStatement = db.prepare(
  `
    SELECT
      facts.service_id,
      service_dim.service_name,
      service_dim.compute_units_per_relay,
      SUM(facts.relays) AS relays,
      CAST(COALESCE(SUM(facts.estimated_relays), 0) AS INTEGER) AS estimated_relays,
      CAST(COALESCE(SUM(facts.estimated_compute_units), 0) AS INTEGER) AS estimated_compute_units,
      CAST(COALESCE(SUM(CASE WHEN facts.estimated_relays IS NOT NULL THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0), 0) AS REAL) AS relay_coverage,
      CAST(SUM(CAST(facts.revenue_upokt AS INTEGER)) AS TEXT) AS revenue_upokt,
      COUNT(DISTINCT facts.supplier_hash) AS supplier_count,
      COUNT(DISTINCT COALESCE(supplier_domain_dim.domain_hash, facts.owner_hash, facts.supplier_hash)) AS provider_count
    FROM settlement_facts facts
    LEFT JOIN service_dim ON service_dim.service_id = facts.service_id
    LEFT JOIN supplier_domain_dim ON supplier_domain_dim.supplier_hash = facts.supplier_hash
    WHERE facts.block_time >= ?
    GROUP BY facts.service_id
    HAVING relays > 0 OR CAST(revenue_upokt AS INTEGER) > 0
    ORDER BY CAST(revenue_upokt AS INTEGER) DESC, relays DESC
  `
);

const selectProviderAggregatesStatement = db.prepare(
  `
    SELECT
      COALESCE(supplier_domain_dim.domain_hash, settlement_facts.owner_hash, settlement_facts.supplier_hash) AS supplier_hash,
      SUM(settlement_facts.relays) AS relays,
      CAST(SUM(CAST(settlement_facts.revenue_upokt AS INTEGER)) AS TEXT) AS revenue_upokt,
      COUNT(DISTINCT settlement_facts.service_id) AS service_count
    FROM settlement_facts
    LEFT JOIN supplier_domain_dim ON supplier_domain_dim.supplier_hash = settlement_facts.supplier_hash
    WHERE settlement_facts.block_time >= ?
    GROUP BY COALESCE(supplier_domain_dim.domain_hash, settlement_facts.owner_hash, settlement_facts.supplier_hash)
    HAVING relays > 0 OR CAST(revenue_upokt AS INTEGER) > 0
    ORDER BY CAST(revenue_upokt AS INTEGER) DESC, relays DESC
  `
);

const selectDailyAggregatesStatement = db.prepare(
  `
    SELECT
      day,
      SUM(relays) AS relays,
      CAST(COALESCE(SUM(estimated_relays), 0) AS INTEGER) AS estimated_relays,
      CAST(COALESCE(SUM(estimated_compute_units), 0) AS INTEGER) AS estimated_compute_units,
      CAST(COALESCE(SUM(CASE WHEN estimated_relays IS NOT NULL THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0), 0) AS REAL) AS relay_coverage,
      CAST(SUM(CAST(revenue_upokt AS INTEGER)) AS TEXT) AS revenue_upokt
    FROM settlement_facts
    WHERE block_time >= ?
    GROUP BY day
    ORDER BY day ASC
  `
);

const selectGlobalRelayCoverageStatement = db.prepare(
  `
    SELECT CAST(COALESCE(SUM(CASE WHEN estimated_relays IS NOT NULL THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0), 0) AS REAL) AS coverage
    FROM settlement_facts
    WHERE block_time >= ?
  `
);

const selectGlobalComputeUnitCoverageStatement = db.prepare(
  `
    SELECT CAST(COALESCE(SUM(CASE WHEN estimated_compute_units IS NOT NULL THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0), 0) AS REAL) AS coverage
    FROM settlement_facts
    WHERE block_time >= ?
  `
);

const selectGapCountStatement = db.prepare(
  `
    SELECT
      CAST(COALESCE(COUNT(*), 0) AS INTEGER) AS gaps,
      CAST(COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS INTEGER) AS failed
    FROM indexed_heights
    WHERE status = 'failed'
  `
);

const selectServiceDailyAggregatesStatement = db.prepare(
  `
    SELECT
      day,
      SUM(relays) AS relays,
      CAST(COALESCE(SUM(estimated_relays), 0) AS INTEGER) AS estimated_relays,
      CAST(COALESCE(SUM(estimated_compute_units), 0) AS INTEGER) AS estimated_compute_units,
      CAST(COALESCE(SUM(CASE WHEN estimated_relays IS NOT NULL THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0), 0) AS REAL) AS relay_coverage,
      CAST(SUM(CAST(revenue_upokt AS INTEGER)) AS TEXT) AS revenue_upokt
    FROM settlement_facts
    WHERE block_time >= ? AND service_id = ?
    GROUP BY day
    ORDER BY day ASC
  `
);

const selectLatestIndexedFactStatement = db.prepare(
  "SELECT height, block_time FROM settlement_facts ORDER BY height DESC LIMIT 1"
);

const upsertDailyRollupStatement = db.prepare(
  `
    INSERT INTO daily_rollups (day, total_relays, estimated_relays, estimated_compute_units, revenue_upokt, relay_coverage, generated_at)
    VALUES (@day, @total_relays, @estimated_relays, @estimated_compute_units, @revenue_upokt, @relay_coverage, @generated_at)
    ON CONFLICT(day) DO UPDATE SET
      total_relays = excluded.total_relays,
      estimated_relays = excluded.estimated_relays,
      estimated_compute_units = excluded.estimated_compute_units,
      revenue_upokt = excluded.revenue_upokt,
      relay_coverage = excluded.relay_coverage,
      generated_at = excluded.generated_at
  `
);

const selectDailyRollupsStatement = db.prepare(
  `
    SELECT day, total_relays AS relays, estimated_relays, estimated_compute_units, revenue_upokt, relay_coverage
    FROM daily_rollups
    WHERE day >= ?
    ORDER BY day ASC
  `
);

const writeIndexedBlockTransaction = db.transaction((height: number, facts: IndexedSettlementFact[], blockTime: number, day: string, source: string) => {
  if (!Number.isFinite(blockTime)) {
    throw new Error(`Cannot save height ${height} without a block timestamp`);
  }
  for (const fact of facts) {
    insertSettlementFactStatement.run({
      height: fact.height,
      event_index: fact.eventIndex,
      block_time: fact.blockTime,
      day: fact.day,
      hour: fact.hour,
      service_id: fact.serviceId,
      supplier_hash: fact.supplierHash,
      owner_hash: fact.ownerHash,
      relays: fact.relays,
      estimated_relays: fact.estimatedRelays ?? null,
      claimed_compute_units: fact.claimedComputeUnits ?? null,
      estimated_compute_units: fact.estimatedComputeUnits ?? null,
      revenue_upokt: fact.revenueUpokt,
      ingestion_source: fact.ingestionSource ?? "rpc",
      source_record_id: fact.sourceRecordId ?? null
    });
  }

  upsertIndexedHeightStatement.run({
    height,
    status: facts.length > 0 ? "indexed" : "empty",
    scanned_at: new Date().toISOString(),
    event_count: facts.length,
    failure_count: 0,
    last_error: null,
    block_time: blockTime,
    day,
    source,
    block_complete: 1,
    workload_complete: 1,
    reward_complete: 1
  });

  // RPC is canonical. Any provisional GraphQL observations for this height
  // are no longer needed once its reward has been reconciled by RPC.
  if (source === "rpc") {
    db.prepare("DELETE FROM graphql_settlement_facts WHERE height = ?").run(height);
  }

  const currentSeen = Number(getIndexerState("highest_seen_height") ?? 0);
  if (height > currentSeen) {
    setIndexerState("highest_seen_height", String(height));
  }
  const currentIngested = Number(getIndexerState("highest_ingested_height") ?? 0);
  if (height > currentIngested) {
    setIndexerState("highest_ingested_height", String(height));
  }

  const currentContiguous = Number(getIndexerState("contiguous_processed_height") ?? 0);
  // Scan forward from current contiguous boundary, advancing through
  // every consecutive indexed|empty height. Bounded at 10000 to avoid
  // startup storms on fresh DBs with large gaps.
  let next = currentContiguous;
  let scanned = 0;
  while (scanned < 10000) {
    const row = checkHeightCoverageStatement.get(next + 1) as { status: string } | undefined;
    if (row && (row.status === "indexed" || row.status === "empty")) {
      next += 1;
      scanned += 1;
    } else {
      break;
    }
  }
  if (next > currentContiguous) {
    setIndexerState("contiguous_processed_height", String(next));
  }
});

export function getCachedSettlementBlocks(heights: number[]): Map<number, CachedSettlementBlockRow> {
  const result = new Map<number, CachedSettlementBlockRow>();

  for (let start = 0; start < heights.length; start += 999) {
    const batch = heights.slice(start, start + 999);
    if (batch.length === 0) continue;

    const rows = selectSettlementBlocksStatement.all(...batch, ...Array.from({ length: 999 - batch.length }, () => null)) as CachedSettlementBlockRow[];
    for (const row of rows) {
      if (row?.height) {
        result.set(row.height, row);
      }
    }
  }

  return result;
}

export function saveSettlementBlock(height: number, blockTime: string, eventsJson: string): void {
  insertSettlementBlockStatement.run({
    height,
    block_time: blockTime,
    events_json: eventsJson,
    scanned_at: new Date().toISOString()
  });
}

export function getMeta(key: string): string | null {
  const row = selectMetaStatement.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  upsertMetaStatement.run({
    key,
    value,
    updated_at: new Date().toISOString()
  });
}

export function getDashboardCache(window: string): { payloadJson: string; updatedAt: string } | null {
  const row = selectDashboardCacheStatement.get(window) as { payload_json: string; updated_at: string } | undefined;
  if (!row) {
    return null;
  }

  return {
    payloadJson: row.payload_json,
    updatedAt: row.updated_at
  };
}

export function setDashboardCache(window: string, payloadJson: string): void {
  upsertDashboardCacheStatement.run({
    window,
    payload_json: payloadJson,
    updated_at: new Date().toISOString()
  });
}

export function startJobRun(jobName: string, metadata?: Record<string, unknown>): number {
  const result = insertJobRunStatement.run({
    job_name: jobName,
    status: "running",
    started_at: new Date().toISOString(),
    metadata_json: metadata ? JSON.stringify(metadata) : null
  });
  return Number(result.lastInsertRowid);
}

export function finishJobRun(id: number, status: "success" | "failed", startedAt: number, metadata?: Record<string, unknown>, error?: string): void {
  updateJobRunStatement.run({
    id,
    status,
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    error: error ?? null,
    metadata_json: metadata ? JSON.stringify(metadata) : null
  });
}

export function getIndexerState(key: string): string | null {
  const row = selectIndexerStateStatement.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setIndexerState(key: string, value: string): void {
  upsertIndexerStateStatement.run({ key, value, updated_at: new Date().toISOString() });
}

export function saveIndexedBlock(height: number, facts: IndexedSettlementFact[], blockTime?: number, source = "rpc"): void {
  if (!Number.isFinite(blockTime)) {
    throw new Error(`Cannot save height ${height} without a block timestamp`);
  }
  const day = new Date(blockTime as number).toISOString().slice(0, 10);
  saveBlockHeader(height, blockTime as number, source);
  writeIndexedBlockTransaction(height, facts, blockTime as number, day, source);
  setIndexerState("last_successful_commit", new Date().toISOString());
}

export function markIndexedHeightFailed(height: number, error: string, source = "rpc"): void {
  markIndexedHeightFailedStatement.run({
    height,
    scanned_at: new Date().toISOString(),
    last_error: error.slice(0, 1000),
    source
  });
  const current = Number(getIndexerState("highest_seen_height") ?? 0);
  if (height > current) {
    setIndexerState("highest_seen_height", String(height));
  }
}

export function getEmptyHeightsWithoutMetadata(limit: number): Array<{ height: number; blockTime: number }> {
  try {
    return (selectEmptyHeightsWithoutMetadataStatement.all(limit) as Array<{ height: number; block_time: number }>)
      .map((r) => ({ height: r.height, blockTime: r.block_time }));
  } catch {
    return [];
  }
}

export function updateHeightTimestamp(height: number, blockTime: number, day: string): void {
  try {
    updateHeightTimestampStatement.run({ height, block_time: blockTime, day });
  } catch { /* non-critical */ }
}

export function completeVerifiedEmptyHeight(height: number, blockTime: number, day: string): void {
  try {
    completeVerifiedEmptyHeightStatement.run({ height, block_time: blockTime, day });
  } catch { /* non-critical */ }
}

export type DailyHeightCoverage = {
  day: string;
  expectedHeights: number;
  blockCovered: number;
  workloadCovered: number;
  rewardCovered: number;
  failed: number;
  missing: number;
};

export function saveBlockHeader(height: number, blockTime: number, source: string): void {
  try {
    const day = new Date(blockTime).toISOString().slice(0, 10);
    upsertBlockHeaderStatement.run({ height, block_time: blockTime, day, source, fetched_at: new Date().toISOString() });
  } catch { }
}

export function getDailyHeightCoverage(dayStartMs: number, nextDayStartMs: number): Omit<DailyHeightCoverage, "day"> | null {
  const start = db.prepare("SELECT MIN(height) AS height FROM block_headers WHERE block_time >= ?").get(dayStartMs) as { height: number | null };
  const next = db.prepare("SELECT MIN(height) AS height FROM block_headers WHERE block_time >= ?").get(nextDayStartMs) as { height: number | null };
  if (start.height == null || next.height == null || next.height <= start.height) return null;

  const prev = db.prepare("SELECT block_time FROM block_headers WHERE height = ?").get(start.height - 1) as { block_time: number } | undefined;
  if (!prev || prev.block_time >= dayStartMs) return null;

  const beforeNext = db.prepare("SELECT block_time FROM block_headers WHERE height = ?").get(next.height - 1) as { block_time: number } | undefined;
  if (!beforeNext || beforeNext.block_time >= nextDayStartMs) return null;

  const expectedHeights = next.height - start.height;
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN block_complete = 1 THEN 1 ELSE 0 END) AS block_covered,
      SUM(CASE WHEN workload_complete = 1 THEN 1 ELSE 0 END) AS workload_covered,
      SUM(CASE WHEN reward_complete = 1 THEN 1 ELSE 0 END) AS reward_covered,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      COUNT(*) AS present
    FROM indexed_heights
    WHERE height BETWEEN ? AND ?
  `).get(start.height, next.height - 1) as { block_covered: number | null; workload_covered: number | null; reward_covered: number | null; failed: number | null; present: number };
  return {
    expectedHeights,
    blockCovered: row.block_covered ?? 0,
    workloadCovered: row.workload_covered ?? 0,
    rewardCovered: row.reward_covered ?? 0,
    failed: row.failed ?? 0,
    missing: Math.max(0, expectedHeights - (row.present ?? 0)),
  };
}

export function getEmptyNullTimestampHeights(limit = 100): number[] {
  try {
    const rows = selectEmptyNullTimestampStatement.all(limit) as Array<{ height: number }>;
    return rows.map((r) => r.height);
  } catch {
    return [];
  }
}

export function getEmptyNullTimestampCount(): number {
  try {
    const row = countEmptyNullTimestampStatement.get() as { count: number } | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}
export function insertGraphQLSettlementFacts(
  facts: Array<{
    sourceRecordId: string;
    height: number;
    blockTime: number;
    day: string;
    serviceId: string;
    supplierHash: string;
    ownerHash: string | null;
    relays: number;
    estimatedRelays?: number;
    estimatedComputeUnits?: number;
    claimedAmount: string;
    settledAmount: string;
  }>
): void {
  const now = new Date().toISOString();
  for (const f of facts) {
    insertGraphQLSettlementFactStatement.run({
      source_record_id: f.sourceRecordId,
      height: f.height,
      block_time: f.blockTime,
      day: f.day,
      service_id: f.serviceId,
      supplier_hash: f.supplierHash,
      owner_hash: f.ownerHash,
      relays: f.relays,
      estimated_relays: f.estimatedRelays ?? null,
      estimated_compute_units: f.estimatedComputeUnits ?? null,
      claimed_amount: f.claimedAmount,
      settled_amount: f.settledAmount,
      fetched_at: now,
    });
  }
}

export function deleteGraphQLSettlementFactsForHeight(height: number): void {
  try { db.prepare("DELETE FROM graphql_settlement_facts WHERE height = ?").run(height); } catch { }
}

export function savePartialBlock(height: number, blockTime?: number): void {
  if (!Number.isFinite(blockTime)) {
    throw new Error(`Cannot save partial height ${height} without a block timestamp`);
  }
  const day = blockTime != null ? new Date(blockTime).toISOString().slice(0, 10) : null;
  saveBlockHeader(height, blockTime as number, "graphql");
  upsertIndexedHeightStatement.run({
    height,
    status: "partial",
    scanned_at: new Date().toISOString(),
    event_count: 0,
    failure_count: 0,
    last_error: null,
    block_time: blockTime,
    day,
    source: "graphql",
    block_complete: 1,
    workload_complete: 1,
    reward_complete: 0,
  });
  const currentIngested = Number(getIndexerState("highest_ingested_height") ?? 0);
  if (height > currentIngested) setIndexerState("highest_ingested_height", String(height));
}

export function getEmptyNullTimestampHeightsInRange(
  fromHeight: number,
  toHeight: number,
  limit: number,
  newestFirst: boolean
): number[] {
  try {
    const order = newestFirst ? "DESC" : "ASC";
    const sql = `SELECT height FROM indexed_heights WHERE status='empty' AND block_time IS NULL AND height >= ? AND height <= ? ORDER BY height ${order} LIMIT ?`;
    const rows = db.prepare(sql).all(fromHeight, toHeight, limit) as Array<{ height: number }>;
    return rows.map(r => r.height);
  } catch { return []; }
}

export function getFirstHeightAtOrAfter(timestampMs: number): number | null {
  const row = db.prepare("SELECT MIN(height) AS height FROM indexed_heights WHERE block_time >= ?").get(timestampMs) as { height: number | null };
  return row.height ?? null;
}

export function getBlockHeaderHeight(height: number): { block_time: number } | undefined {
  try {
    return db.prepare("SELECT block_time FROM block_headers WHERE height = ?").get(height) as { block_time: number } | undefined;
  } catch { return undefined; }
}

export function getPartialWorkloadHeights(): number {
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM indexed_heights WHERE workload_complete=0 AND status IN ('empty','indexed','partial')").get() as { c: number };
    return row?.c ?? 0;
  } catch { return 0; }
}

export function getPartialRewardHeights(): number {
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM indexed_heights WHERE reward_complete=0 AND status IN ('empty','indexed','partial')").get() as { c: number };
    return row?.c ?? 0;
  } catch { return 0; }
}

export function getMissingHeightCount(_retentionStartHeight: number, retentionEndHeight: number): number {
  try {
    const present = db.prepare("SELECT COUNT(*) AS c FROM indexed_heights WHERE height BETWEEN ? AND ?").get(_retentionStartHeight, retentionEndHeight) as { c: number };
    return Math.max(0, (retentionEndHeight - _retentionStartHeight + 1) - (present?.c ?? 0));
  } catch { return 0; }
}

export function migrateV3ToV4(): { migratedGraphQLFacts: number; partialHeights: number } {
  return db.transaction(() => {
    const legacyFacts = db.prepare(`
      SELECT height, event_index, block_time, day, service_id, supplier_hash, owner_hash,
        relays, estimated_relays, estimated_compute_units, revenue_upokt, source_record_id
      FROM settlement_facts
      WHERE ingestion_source = 'graphql'
    `).all() as Array<{
      height: number;
      event_index: number;
      block_time: number;
      day: string;
      service_id: string;
      supplier_hash: string;
      owner_hash: string | null;
      relays: number;
      estimated_relays: number | null;
      estimated_compute_units: number | null;
      revenue_upokt: string;
      source_record_id: string | null;
    }>;

    if (legacyFacts.some((fact) => BigInt(fact.revenue_upokt) !== 0n)) {
      throw new Error("Refusing v4 migration: legacy GraphQL facts carry canonical revenue");
    }

    const now = new Date().toISOString();
    for (const fact of legacyFacts) {
      let sourceRecordId = `legacy:${fact.height}:${fact.event_index}`;
      let claimedAmount: string | null = null;
      let settledAmount: string | null = null;
      if (fact.source_record_id) {
        try {
          const source = JSON.parse(fact.source_record_id) as { graphqlId?: string; claimedAmount?: string; settledAmount?: string };
          sourceRecordId = source.graphqlId ?? sourceRecordId;
          claimedAmount = source.claimedAmount ?? null;
          settledAmount = source.settledAmount ?? null;
        } catch {
          sourceRecordId = fact.source_record_id;
        }
      }
      insertGraphQLSettlementFactStatement.run({
        source_record_id: sourceRecordId,
        height: fact.height,
        block_time: fact.block_time,
        day: fact.day,
        service_id: fact.service_id,
        supplier_hash: fact.supplier_hash,
        owner_hash: fact.owner_hash,
        relays: fact.relays,
        estimated_relays: fact.estimated_relays,
        estimated_compute_units: fact.estimated_compute_units,
        claimed_amount: claimedAmount,
        settled_amount: settledAmount,
        fetched_at: now,
      });
    }
    if (legacyFacts.length > 0) {
      db.prepare("DELETE FROM settlement_facts WHERE ingestion_source = 'graphql'").run();
    }

    // Historical RPC and verified GraphQL empties are complete. GraphQL
    // settlement observations remain partial until a canonical RPC repair.
    db.prepare(`
      UPDATE indexed_heights
      SET status = CASE WHEN event_count > 0 THEN 'indexed' ELSE 'empty' END,
        block_complete = 1, workload_complete = 1, reward_complete = 1
      WHERE block_time IS NOT NULL AND source = 'rpc' AND status IN ('indexed', 'empty', 'partial')
    `).run();
    db.prepare(`
      UPDATE indexed_heights
      SET status = 'partial', block_complete = 1, workload_complete = 1, reward_complete = 0
      WHERE source = 'graphql' AND status = 'indexed'
        AND EXISTS (SELECT 1 FROM graphql_settlement_facts g WHERE g.height = indexed_heights.height)
    `).run();
    db.prepare(`
      UPDATE indexed_heights
      SET block_complete = 1, workload_complete = 1, reward_complete = 1
      WHERE block_time IS NOT NULL AND source = 'graphql' AND status = 'empty'
    `).run();
    db.prepare(`
      UPDATE indexed_heights
      SET block_complete = 0, workload_complete = 0, reward_complete = 0
      WHERE status = 'failed' OR block_time IS NULL
    `).run();

    const maxIngested = db.prepare("SELECT MAX(height) AS height FROM indexed_heights WHERE status IN ('indexed', 'empty', 'partial')").get() as { height: number | null };
    const currentIngested = Number(getIndexerState("highest_ingested_height") ?? 0);
    if (maxIngested.height != null && maxIngested.height > currentIngested) {
      setIndexerState("highest_ingested_height", String(maxIngested.height));
    }

    const partial = db.prepare("SELECT COUNT(*) AS count FROM indexed_heights WHERE status = 'partial'").get() as { count: number };
    return { migratedGraphQLFacts: legacyFacts.length, partialHeights: partial.count };
  })();
}

export function getFailedHeights(limit = 100): number[] {
  try {
    const rows = selectFailedHeightsStatement.all(limit) as Array<{ height: number }>;
    return rows.map((r) => r.height);
  } catch {
    return [];
  }
}

export function getIndexedHeightCoverage(fromHeight: number, toHeight: number): IndexedHeightCoverage[] {
  return selectIndexedHeightsStatement.all(fromHeight, toHeight) as IndexedHeightCoverage[];
}

export function pruneIndexedHeightCoverage(minHeight: number): void {
  deleteOldIndexedHeightsStatement.run(minHeight);
}

export function saveIndexedServices(services: IndexedService[]): void {
  const now = new Date().toISOString();
  const transaction = db.transaction((entries: IndexedService[]) => {
    for (const service of entries) {
      upsertServiceStatement.run({
        service_id: service.serviceId,
        service_name: service.serviceName,
        compute_units_per_relay: service.computeUnitsPerRelay,
        updated_at: now
      });
    }
  });
  transaction(services);
}

export function saveIndexedSupplierDomains(domains: IndexedSupplierDomain[]): void {
  const now = new Date().toISOString();
  const transaction = db.transaction((entries: IndexedSupplierDomain[]) => {
    for (const entry of entries) {
      upsertSupplierDomainStatement.run({
        supplier_hash: entry.supplierHash,
        domain_hash: entry.domainHash,
        has_endpoint: entry.hasEndpoint ? 1 : 0,
        updated_at: now
      });
    }
  });
  transaction(domains);
}

export function getIndexedServiceAggregates(sinceUnixMs: number): IndexedServiceAggregate[] {
  return selectServiceAggregatesStatement.all(sinceUnixMs) as IndexedServiceAggregate[];
}

export function getIndexedProviderAggregates(sinceUnixMs: number): IndexedProviderAggregate[] {
  return selectProviderAggregatesStatement.all(sinceUnixMs) as IndexedProviderAggregate[];
}

export function getIndexedDailyAggregates(sinceUnixMs: number): IndexedDailyAggregate[] {
  return selectDailyAggregatesStatement.all(sinceUnixMs) as IndexedDailyAggregate[];
}

export function getGlobalComputeUnitCoverage(sinceUnixMs: number): number {
  const row = selectGlobalComputeUnitCoverageStatement.get(sinceUnixMs) as { coverage: number } | undefined;
  return row?.coverage ?? 0;
}

export function getGlobalRelayCoverage(sinceUnixMs: number): number {
  const row = selectGlobalRelayCoverageStatement.get(sinceUnixMs) as { coverage: number } | undefined;
  return row?.coverage ?? 0;
}

export function getIndexedServiceDailyAggregates(sinceUnixMs: number, serviceId: string): IndexedDailyAggregate[] {
  return selectServiceDailyAggregatesStatement.all(sinceUnixMs, serviceId) as IndexedDailyAggregate[];
}

export function getLatestIndexedFact(): { height: number; block_time: number } | null {
  const row = selectLatestIndexedFactStatement.get() as { height: number; block_time: number } | undefined;
  return row ?? null;
}

export function upsertDailyRollup(rollup: IndexedDailyAggregate & { generated_at: string }): void {
  upsertDailyRollupStatement.run({
    day: rollup.day,
    total_relays: rollup.relays,
    estimated_relays: rollup.estimated_relays,
    estimated_compute_units: rollup.estimated_compute_units,
    revenue_upokt: rollup.revenue_upokt,
    relay_coverage: rollup.relay_coverage,
    generated_at: rollup.generated_at
  });
}

export function getDailyRollups(sinceDay: string): IndexedDailyAggregate[] {
  return selectDailyRollupsStatement.all(sinceDay) as IndexedDailyAggregate[];
}

export function pruneIndexerData(retentionDays: number, maxJobRuns = 500): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  deleteOldSettlementFactsStatement.run(cutoff);
  deleteOldJobRunsStatement.run(maxJobRuns);
}
