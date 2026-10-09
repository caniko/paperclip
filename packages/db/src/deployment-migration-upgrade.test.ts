import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations, assertDeploymentSchemaCompatible, ensurePostgresDatabase, inspectMigrations } from "./client.js";
import { connectPostgres } from "./postgres-connection.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

type TestSql = ReturnType<typeof connectPostgres>;
type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };
const nativeFile = "0319_exotic_spiral.sql";
const nativeHash = "ac20d3f6626b23aaf07e7bc7f6502bbcd728a2808d4b4adb56b2116bb30e6412";
// Authentic entry and SQL from 843bb5b, whose upstream prefix through 0288 is unchanged.
const oldEntry: JournalEntry = { idx: 289, version: "7", when: 1790713813737, tag: "0289_messy_vivisector", breakpoints: true };
const oldSqlUrl = new URL("./__tests__/fixtures/deployment-history/0289_messy_vivisector.sql", import.meta.url);
const pendingFiles = [
  "0289_drop_user_keyboard_shortcuts.sql", "0290_browser_use_cloud.sql",
  "0291_conscious_secret_warriors.sql", "0292_powerful_devos.sql",
  "0293_broad_rattler.sql", "0294_chilly_marvel_apes.sql",
  "0295_public_captain_cross.sql", "0296_stiff_thaddeus_ross.sql",
  "0297_foamy_swordsman.sql", "0298_connection_agent_instructions.sql",
  "0299_absent_ser_duncan.sql", "0300_chunky_chamber.sql",
  "0301_lumpy_maria_hill.sql", "0302_colossal_otto_octavius.sql",
  "0303_supreme_garia.sql", "0304_curvy_shadow_king.sql",
  "0305_chubby_vin_gonzales.sql", "0306_familiar_titania.sql",
  "0307_cool_naoko.sql", "0308_whole_steel_serpent.sql",
  "0309_loving_the_hood.sql", "0310_agent_commentary.sql",
  "0311_mcp_file_transfers.sql", "0312_easy_eternity.sql",
  "0313_private_task_access.sql", "0314_private_task_draft_assets.sql",
  "0315_rapid_emma_frost.sql", "0316_premium_slayback.sql",
  "0317_messy_famine.sql", "0318_strong_blacklash.sql",
];
const browserTables = ["browser_use_browsers", "browser_use_runs", "browser_use_sessions", "browser_use_settings"];
const guardedTables = ["agent_api_keys", "agents", "companies", "company_secret_versions", "company_secrets", "project_workspaces", "projects", "routine_triggers", "routines"];
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const migrationUrl = (file: string) => new URL(`./migrations/${file}`, import.meta.url);
const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as Journal;
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping deployment migration upgrade tests: ${support.reason ?? "unsupported environment"}`);

async function withEmptyDatabase(action: (sql: TestSql, url: string) => Promise<void>) {
  const cluster = await startEmbeddedPostgresTestDatabase("paperclip-deployment-upgrade-");
  let sql: TestSql | undefined;
  try {
    // The helper's returned database is CURRENT-migrated; history needs a genuinely empty sibling.
    const adminUrl = new URL(cluster.connectionString);
    adminUrl.pathname = "/postgres";
    const name = `deployment_${randomUUID().replaceAll("-", "")}`;
    expect(await ensurePostgresDatabase(adminUrl.toString(), name)).toBe("created");
    const url = new URL(cluster.connectionString);
    url.pathname = `/${name}`;
    sql = connectPostgres(url.toString(), { max: 1, onnotice: () => {} });
    expect(await inspectMigrations(url.toString())).toMatchObject({
      status: "needsMigrations", reason: "no-migration-journal-empty-db", tableCount: 0, journalEntryCount: 0,
    });
    await action(sql, url.toString());
  } finally {
    try { await sql?.end({ timeout: 1 }); }
    finally { await cluster.cleanup(); }
  }
}

async function applyOldHistory(sql: TestSql, url: string) {
  const bytes = await readFile(oldSqlUrl);
  expect(sha256(bytes)).toBe(nativeHash);
  expect(await readFile(migrationUrl(nativeFile))).toEqual(bytes);
  const prefix = journal.entries.filter((entry) => entry.idx <= 288);
  expect(prefix.at(-1)?.tag).toBe("0288_glorious_jamie_braddock");
  const history = { ...journal, entries: [...prefix, oldEntry] };
  const folder = await mkdtemp(join(tmpdir(), "paperclip-deployment-history-"));
  try {
    await mkdir(join(folder, "meta"));
    await Promise.all(prefix.map((entry) => copyFile(migrationUrl(`${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))));
    await copyFile(oldSqlUrl, join(folder, `${oldEntry.tag}.sql`));
    await writeFile(join(folder, "meta", "_journal.json"), JSON.stringify(history));
    // Drizzle installs its own JSON serializers on the client. Keep the raw SQL
    // fixture client separate so its postgres.js JSON encoding stays intact.
    const migrator = connectPostgres(url, { max: 1, onnotice: () => {} });
    try { await migrate(drizzle(migrator), { migrationsFolder: folder }); }
    finally { await migrator.end({ timeout: 1 }); }
    // IDs follow journal array order, including its historical gaps and repeated idx.
    const expected = await Promise.all(history.entries.map(async (entry, index) => ({
      id: index + 1, hash: entry === oldEntry ? nativeHash : sha256(await readFile(migrationUrl(`${entry.tag}.sql`))),
      created_at: String(entry.when),
    })));
    expect(await readHistory(sql)).toEqual(expected);
  } finally { await rm(folder, { recursive: true, force: true }); }
}

async function readHistory(sql: TestSql) {
  return sql<{ id: number; hash: string; created_at: string }[]>`
    SELECT id, hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`;
}

async function readSchema(sql: TestSql) {
  const tables = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${sql.array([...browserTables, "deployment_resources"])}::text[]) ORDER BY table_name`;
  const [keyboard] = await sql`SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user' AND column_name = 'keyboard_shortcuts') AS present`;
  const guards = await sql`SELECT c.relname AS table_name, t.tgenabled AS enabled,
    pg_get_triggerdef(t.oid) AS trigger_definition, pg_get_functiondef(t.tgfoid) AS function_definition
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND t.tgname = 'deployment_guard' AND NOT t.tgisinternal ORDER BY c.relname`;
  expect(guards.map((row) => row.table_name)).toEqual(guardedTables);
  expect(guards.every((row) => row.enabled === "O")).toBe(true);
  return { tables: tables.map((row) => row.table_name), keyboard: keyboard.present, guards };
}

async function seed(sql: TestSql) {
  const ids = { user: `migration-user-${randomUUID()}`, company: randomUUID(), agent: randomUUID(), secret: randomUUID(), version: randomUUID() };
  // Valid local_encrypted_v1 material, using only disposable in-memory key/plaintext.
  // Production secret resolution, old-binary startup and backup/restore are separate qualification.
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const plaintext = "disposable migration secret";
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const material = { scheme: "local_encrypted_v1", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  const adapterConfig = { command: "fixture-worker", env: { TOKEN: { type: "secret_ref", secretId: ids.secret, version: "latest" } } };
  await sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (${ids.user}, 'Migration board', ${`${ids.user}@example.test`}, true, now(), now())`;
  await sql`INSERT INTO instance_user_roles (user_id, role) VALUES (${ids.user}, 'instance_admin')`;
  await sql`INSERT INTO companies (id, name, issue_prefix, default_responsible_user_id, budget_monthly_cents)
    VALUES (${ids.company}, 'Declared company', 'MIG', ${ids.user}, 12345)`;
  await sql`INSERT INTO company_memberships (company_id, principal_type, principal_id, membership_role)
    VALUES (${ids.company}, 'user', ${ids.user}, 'owner')`;
  await sql`INSERT INTO agents (id, company_id, name, role, adapter_type, adapter_config, budget_monthly_cents)
    VALUES (${ids.agent}, ${ids.company}, 'Declared worker', 'engineer', 'process', ${sql.json(adapterConfig)}, 2345)`;
  await sql`INSERT INTO company_secrets (id, company_id, key, name, provider, created_by_user_id)
    VALUES (${ids.secret}, ${ids.company}, 'worker-token', 'Worker token', 'local_encrypted', ${ids.user})`;
  await sql`INSERT INTO company_secret_versions (id, secret_id, version, material, value_sha256, fingerprint_sha256, created_by_user_id)
    VALUES (${ids.version}, ${ids.secret}, 1, ${sql.json(material)}, ${sha256(plaintext)}, ${sha256(plaintext)}, ${ids.user})`;
  for (const [kind, resourceId, fields] of [
    ["company", ids.company, { name: "Declared company", issuePrefix: "MIG" }],
    ["agent", ids.agent, { name: "Declared worker", adapterConfig }],
    ["secret", ids.secret, {}],
  ] as const) {
    await sql`INSERT INTO deployment_resources (owner, kind, key, resource_id, company_id, fields)
      VALUES ('migration-fixture', ${kind}, ${kind}, ${resourceId}, ${ids.company}, ${sql.json(fields)})`;
  }
  return { ids, key, plaintext, material };
}

async function preservedRows(sql: TestSql, row: Awaited<ReturnType<typeof seed>>) {
  const { ids } = row;
  return Promise.all([
    sql`SELECT id, name, email, email_verified, created_at, updated_at FROM "user" WHERE id = ${ids.user}`,
    sql`SELECT * FROM instance_user_roles WHERE user_id = ${ids.user}`,
    sql`SELECT * FROM company_memberships WHERE company_id = ${ids.company}`,
    sql`SELECT * FROM companies WHERE id = ${ids.company}`,
    sql`SELECT * FROM agents WHERE id = ${ids.agent}`,
    sql`SELECT * FROM company_secrets WHERE id = ${ids.secret}`,
    sql`SELECT *, material::text AS material_bytes FROM company_secret_versions WHERE id = ${ids.version}`,
    sql`SELECT * FROM deployment_resources WHERE owner = 'migration-fixture' ORDER BY kind, key`,
  ]);
}

async function assertGuardsAndCipher(sql: TestSql, row: Awaited<ReturnType<typeof seed>>) {
  await expect(sql`UPDATE companies SET name = 'Unauthorized edit' WHERE id = ${row.ids.company}`)
    .rejects.toMatchObject({ code: "23514", message: "Declaratively owned field cannot be changed" });
  await expect(sql`UPDATE agents SET name = 'Unauthorized edit' WHERE id = ${row.ids.agent}`)
    .rejects.toMatchObject({ code: "23514", message: "Declaratively owned field cannot be changed" });
  await expect(sql`UPDATE company_secret_versions SET material = '{}'::jsonb WHERE id = ${row.ids.version}`)
    .rejects.toMatchObject({ code: "23514", message: "Declaratively owned secret versions cannot be changed" });
  const [version] = await sql`SELECT material FROM company_secret_versions WHERE id = ${row.ids.version}`;
  expect(version.material).toEqual(row.material);
  const decipher = createDecipheriv("aes-256-gcm", row.key, Buffer.from(version.material.iv, "base64"));
  decipher.setAuthTag(Buffer.from(version.material.tag, "base64"));
  expect(Buffer.concat([decipher.update(Buffer.from(version.material.ciphertext, "base64")), decipher.final()]).toString("utf8"))
    .toBe(row.plaintext);
}

describePostgres("deployment migration upgrade from authentic native history", () => {
  it("backfills upstream gaps without rewriting native history, ownership or ciphertext", async () => {
    await withEmptyDatabase(async (sql, url) => {
      await applyOldHistory(sql, url);
      const row = await seed(sql);
      await sql`UPDATE "user" SET keyboard_shortcuts = false WHERE id = ${row.ids.user}`;
      const beforeRows = await preservedRows(sql, row);
      const beforeHistory = await readHistory(sql);
      const beforeSchema = await readSchema(sql);
      expect(beforeSchema).toMatchObject({ tables: ["deployment_resources"], keyboard: true });
      await assertGuardsAndCipher(sql, row);
      await expect(assertDeploymentSchemaCompatible(url)).resolves.toBeUndefined();
      expect(await readHistory(sql)).toEqual(beforeHistory);
      const pending = await inspectMigrations(url);
      expect(pending).toMatchObject({ status: "needsMigrations", reason: "pending-migrations", pendingMigrations: pendingFiles });
      expect(pending.appliedMigrations).toContain(nativeFile);
      await applyPendingMigrations(url);
      const afterHistory = await readHistory(sql);
      expect(afterHistory.slice(0, beforeHistory.length)).toEqual(beforeHistory);
      const appended = await Promise.all(pendingFiles.map(async (file, index) => ({
        id: beforeHistory.at(-1)!.id + index + 1, hash: sha256(await readFile(migrationUrl(file))),
        created_at: String(journal.entries.find((entry) => `${entry.tag}.sql` === file)!.when),
      })));
      expect(afterHistory.slice(beforeHistory.length)).toEqual(appended);
      expect(afterHistory.filter((entry) => entry.hash === nativeHash)).toEqual(beforeHistory.filter((entry) => entry.hash === nativeHash));
      expect(afterHistory.filter((entry) => entry.hash === nativeHash)).toHaveLength(1);
      expect(await preservedRows(sql, row)).toEqual(beforeRows);
      expect(await readSchema(sql)).toEqual({ tables: [...browserTables, "deployment_resources"], keyboard: false, guards: beforeSchema.guards });
      await assertGuardsAndCipher(sql, row);
       expect(await inspectMigrations(url)).toMatchObject({ status: "upToDate", journalEntryCount: beforeHistory.length + pendingFiles.length });
      await applyPendingMigrations(url);
      expect(await readHistory(sql)).toEqual(afterHistory);
      expect(await preservedRows(sql, row)).toEqual(beforeRows);
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("bootstraps current migrations on an empty database and has nothing to reapply", async () => {
    await withEmptyDatabase(async (sql, url) => {
      await assertDeploymentSchemaCompatible(url);
      const [empty] = await sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NULL AS journal_absent`;
      expect(empty.journal_absent).toBe(true);
      await applyPendingMigrations(url);
      const history = await readHistory(sql);
      expect(history).toHaveLength(journal.entries.length);
      expect(history.filter((entry) => entry.hash === nativeHash)).toHaveLength(1);
      expect(await readSchema(sql)).toMatchObject({ tables: [...browserTables, "deployment_resources"], keyboard: false });
      expect(await sql`SELECT * FROM deployment_resources`).toHaveLength(0);
      const row = await seed(sql);
      await assertGuardsAndCipher(sql, row);
      const beforeRows = await preservedRows(sql, row);
      const state = await inspectMigrations(url);
      expect(state).toMatchObject({ status: "upToDate", journalEntryCount: journal.entries.length });
      expect("pendingMigrations" in state ? state.pendingMigrations : []).toEqual([]);
      await applyPendingMigrations(url);
      expect(await readHistory(sql)).toEqual(history);
      expect(await preservedRows(sql, row)).toEqual(beforeRows);
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
