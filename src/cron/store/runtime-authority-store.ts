/** Downgrade-stable persistence for runtime-private cron authority. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { ensureColumn, tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  normalizeCronPersistedRuntimeAuthority,
  normalizeCronRuntimeAuthority,
  normalizeCronScheduledToolBindings,
  serializeCronRuntimeAuthority,
} from "../runtime-authority.js";
import { normalizeCronScheduledToolPolicy } from "../scheduled-tool-policy.js";
import { cronJobUsesToolRuntime } from "../tools-allow.js";
import type { CronStoredJob, CronToolsAllowProvenance } from "../types.js";

const CRON_RUNTIME_AUTHORITY_TABLE = "cron_job_runtime_authorities";
const CRON_RUNTIME_AUTHORITY_FINGERPRINT_VERSION = 1;
const CRON_TOOL_BINDINGS_STORAGE_VERSION = 1;

const CRON_RUNTIME_AUTHORITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cron_job_runtime_authorities (
  store_key TEXT NOT NULL,
  job_id TEXT NOT NULL,
  authority_json TEXT,
  tool_bindings_json TEXT,
  authority_input_fingerprint TEXT,
  recovery_required INTEGER NOT NULL,
  PRIMARY KEY (store_key, job_id),
  FOREIGN KEY (store_key, job_id)
    REFERENCES cron_jobs(store_key, job_id) ON DELETE CASCADE,
  CHECK (recovery_required IN (0, 1)),
  CHECK (
    (recovery_required = 0 AND authority_json IS NOT NULL AND authority_input_fingerprint IS NOT NULL)
    OR
    (recovery_required = 1 AND authority_json IS NULL AND authority_input_fingerprint IS NULL)
  )
) STRICT;
`;

type CronAuthorityDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "cron_job_runtime_authorities" | "cron_jobs"
>;
type CronRuntimeAuthorityRow = Selectable<
  OpenClawStateKyselyDatabase["cron_job_runtime_authorities"]
>;

type CronRuntimeAuthorityLoadResult = {
  repairJobIds: string[];
};

function getCronAuthorityKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<CronAuthorityDatabase>(db);
}

function normalizedToolsAllow(job: CronStoredJob): string[] | null {
  const toolsAllow = job.payload.toolsAllow;
  return toolsAllow === undefined ? null : [...toolsAllow].toSorted();
}

function normalizedToolsAllowProvenance(
  value: CronToolsAllowProvenance | undefined,
): CronToolsAllowProvenance | null {
  return value?.version === 1 && value.source === "final-executable-surface"
    ? { version: 1, source: "final-executable-surface" }
    : null;
}

/** Binds authority to only the canonical inputs that can change its authorization meaning. */
function cronRuntimeAuthorityInputFingerprint(job: CronStoredJob): string {
  const scheduledToolPolicy = normalizeCronScheduledToolPolicy(job.scheduledToolPolicy) ?? null;
  const canonical = {
    version: CRON_RUNTIME_AUTHORITY_FINGERPRINT_VERSION,
    usesToolRuntime: cronJobUsesToolRuntime(job),
    toolsAllow: normalizedToolsAllow(job),
    toolsAllowIsDefault: job.payload.toolsAllowIsDefault === true,
    scheduledToolPolicy,
    toolsAllowProvenance: normalizedToolsAllowProvenance(job.toolsAllowProvenance),
  };
  return `v${CRON_RUNTIME_AUTHORITY_FINGERPRINT_VERSION}:${createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex")}`;
}

function authorityJsonSha256(authorityJson: string): string {
  return createHash("sha256").update(authorityJson, "utf8").digest("hex");
}

function parseStoredToolBindings(
  value: unknown,
  authorityJson: string,
): ReturnType<typeof normalizeCronScheduledToolBindings> {
  // Unshipped raw-array prototypes carry no authority association, so accepting
  // them after a downgrade could restore stale exec authority.
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== CRON_TOOL_BINDINGS_STORAGE_VERSION ||
    !("authoritySha256" in value) ||
    value.authoritySha256 !== authorityJsonSha256(authorityJson) ||
    !("bindings" in value) ||
    Object.keys(value).some(
      (key) => key !== "version" && key !== "authoritySha256" && key !== "bindings",
    )
  ) {
    return undefined;
  }
  return normalizeCronScheduledToolBindings(value.bindings);
}

/** Creates the additive table only when authority state is first persisted. */
function ensureCronRuntimeAuthorityTable(db: DatabaseSync): void {
  // sqlite-allow-raw -- feature-local additive schema DDL; data access uses Kysely.
  db.exec(CRON_RUNTIME_AUTHORITY_SCHEMA_SQL);
  ensureColumn(db, CRON_RUNTIME_AUTHORITY_TABLE, "tool_bindings_json TEXT");
}

function loadCronRuntimeAuthorityRows(
  db: DatabaseSync,
  storeKey: string,
): CronRuntimeAuthorityRow[] {
  if (!tableExists(db, CRON_RUNTIME_AUTHORITY_TABLE)) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    getCronAuthorityKysely(db)
      .selectFrom("cron_job_runtime_authorities")
      .selectAll()
      .where("store_key", "=", storeKey),
  ).rows;
}

function applyCronRuntimeAuthorityRow(
  job: CronStoredJob,
  row: CronRuntimeAuthorityRow,
): "ok" | "repair" {
  delete job.runtimeAuthority;
  delete job.runtimeAuthorityRecoveryRequired;
  if (row.recovery_required === 1) {
    job.runtimeAuthorityRecoveryRequired = true;
    return "ok";
  }
  const persistedAuthority = normalizeCronPersistedRuntimeAuthority(
    safeParseJson(row.authority_json ?? ""),
  );
  const authorityJson = row.authority_json ?? "";
  const toolBindings =
    row.tool_bindings_json == null
      ? undefined
      : parseStoredToolBindings(safeParseJson(row.tool_bindings_json), authorityJson);
  const authority =
    persistedAuthority && (row.tool_bindings_json == null || toolBindings)
      ? normalizeCronRuntimeAuthority({
          ...persistedAuthority,
          ...(toolBindings ? { toolBindings } : {}),
        })
      : undefined;
  if (!authority || row.authority_input_fingerprint !== cronRuntimeAuthorityInputFingerprint(job)) {
    job.runtimeAuthorityRecoveryRequired = true;
    return "repair";
  }
  job.runtimeAuthority = authority;
  return "ok";
}

/** Applies stored authority only when its authorization inputs still match exactly. */
export function loadCronRuntimeAuthorities(params: {
  db: DatabaseSync;
  storeKey: string;
  jobs: CronStoredJob[];
}): CronRuntimeAuthorityLoadResult {
  const jobsById = new Map(params.jobs.map((job) => [job.id, job] as const));
  const repairJobIds: string[] = [];
  for (const row of loadCronRuntimeAuthorityRows(params.db, params.storeKey)) {
    const job = jobsById.get(row.job_id);
    if (!job) {
      continue;
    }
    if (applyCronRuntimeAuthorityRow(job, row) === "repair") {
      repairJobIds.push(job.id);
    }
  }
  return { repairJobIds };
}

function writeRecoveryRow(db: DatabaseSync, storeKey: string, jobId: string): void {
  executeSqliteQuerySync(
    db,
    getCronAuthorityKysely(db)
      .insertInto("cron_job_runtime_authorities")
      .values({
        store_key: storeKey,
        job_id: jobId,
        authority_json: null,
        tool_bindings_json: null,
        authority_input_fingerprint: null,
        recovery_required: 1,
      })
      .onConflict((conflict) =>
        conflict.columns(["store_key", "job_id"]).doUpdateSet({
          authority_json: null,
          tool_bindings_json: null,
          authority_input_fingerprint: null,
          recovery_required: 1,
        }),
      ),
  );
}

/** Revalidates downgrade-detected drift before retiring stale authority durably. */
export function repairCronRuntimeAuthorityRows(params: {
  db: DatabaseSync;
  storeKey: string;
  jobs: CronStoredJob[];
  jobIds: readonly string[];
}): boolean {
  if (!tableExists(params.db, CRON_RUNTIME_AUTHORITY_TABLE)) {
    return false;
  }
  const requested = new Set(params.jobIds);
  const jobsById = new Map(params.jobs.map((job) => [job.id, job] as const));
  let repaired = false;
  for (const row of loadCronRuntimeAuthorityRows(params.db, params.storeKey)) {
    if (!requested.has(row.job_id)) {
      continue;
    }
    const job = jobsById.get(row.job_id);
    if (!job) {
      continue;
    }
    if (applyCronRuntimeAuthorityRow(job, row) === "repair") {
      writeRecoveryRow(params.db, params.storeKey, job.id);
      repaired = true;
    }
  }
  return repaired;
}

/** Reconciles child rows inside the same transaction as their owning cron rows. */
export function replaceCronRuntimeAuthorityRows(params: {
  db: DatabaseSync;
  storeKey: string;
  jobs: readonly CronStoredJob[];
}): void {
  const hasPersistedAuthority = params.jobs.some(
    (job) => job.runtimeAuthority || job.runtimeAuthorityRecoveryRequired === true,
  );
  if (!hasPersistedAuthority && !tableExists(params.db, CRON_RUNTIME_AUTHORITY_TABLE)) {
    return;
  }
  ensureCronRuntimeAuthorityTable(params.db);
  const database = getCronAuthorityKysely(params.db);
  for (const job of params.jobs) {
    if (job.runtimeAuthorityRecoveryRequired === true) {
      writeRecoveryRow(params.db, params.storeKey, job.id);
      continue;
    }
    const authority = normalizeCronRuntimeAuthority(job.runtimeAuthority);
    if (authority) {
      const persistedAuthority = serializeCronRuntimeAuthority(authority);
      if (!persistedAuthority) {
        writeRecoveryRow(params.db, params.storeKey, job.id);
        continue;
      }
      const authorityJson = JSON.stringify(persistedAuthority);
      const toolBindingsJson = authority.toolBindings
        ? JSON.stringify({
            version: CRON_TOOL_BINDINGS_STORAGE_VERSION,
            authoritySha256: authorityJsonSha256(authorityJson),
            bindings: authority.toolBindings,
          })
        : null;
      const authorityInputFingerprint = cronRuntimeAuthorityInputFingerprint(job);
      executeSqliteQuerySync(
        params.db,
        database
          .insertInto("cron_job_runtime_authorities")
          .values({
            store_key: params.storeKey,
            job_id: job.id,
            authority_json: authorityJson,
            tool_bindings_json: toolBindingsJson,
            authority_input_fingerprint: authorityInputFingerprint,
            recovery_required: 0,
          })
          .onConflict((conflict) =>
            conflict.columns(["store_key", "job_id"]).doUpdateSet({
              authority_json: authorityJson,
              tool_bindings_json: toolBindingsJson,
              authority_input_fingerprint: authorityInputFingerprint,
              recovery_required: 0,
            }),
          ),
      );
      continue;
    }
    executeSqliteQuerySync(
      params.db,
      database
        .deleteFrom("cron_job_runtime_authorities")
        .where("store_key", "=", params.storeKey)
        .where("job_id", "=", job.id),
    );
  }
}
