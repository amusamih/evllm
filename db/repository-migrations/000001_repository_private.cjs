// Controller-private repository persistence.
const tables = [
  "repository_identity",
  "protected_bundle_manifests",
  "preparation_requests",
  "author_binding_decisions",
  "staging_finalization_states",
  "challenge_delivery_records",
  "local_policy_state",
  "derived_artifacts",
  "access_decisions",
  "key_operation_capabilities",
  "rotation_commands",
  "rotation_item_results",
  "operation_audit",
  "operation_retries",
  "cleanup_recovery_records",
];

function quote(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql('CREATE SCHEMA "repository_private"');
  for (const table of tables) {
    pgm.sql(`
      CREATE TABLE "repository_private".${quote(table)} (
        record_id text NOT NULL,
        record_version bigint NOT NULL CHECK (record_version > 0),
        bundle_id text,
        bundle_version bigint CHECK (bundle_version IS NULL OR bundle_version > 0),
        status text,
        metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
        created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
        PRIMARY KEY (record_id, record_version)
      )
    `);
    pgm.sql(
      `CREATE INDEX ${quote(`${table}_bundle_idx`)} ON "repository_private".${quote(table)} (bundle_id, bundle_version) WHERE bundle_id IS NOT NULL`,
    );
  }
};

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql('DROP SCHEMA "repository_private" CASCADE');
};

exports.tables = tables;
