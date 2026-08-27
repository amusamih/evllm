// Canonical central persistence groups.
const groups = {
  governance_identity: [
    "organizations",
    "actors",
    "actor_credentials",
    "organization_encryption_keys",
    "service_credentials",
    "recipient_rotation_campaigns",
    "capability_grants",
    "role_assignments",
    "unit_currency_profiles",
    "repositories",
    "schemas",
    "deployments",
    "effective_status_history",
  ],
  protected_bundles: [
    "bundle_domain_links",
    "command_references",
    "domain_signature_records",
    "activation_attempts",
    "content_commitments",
    "access_authorization_decisions",
    "key_operation_capabilities",
    "access_grants",
    "recipient_envelopes",
    "criticality_history",
    "replica_receipts",
    "replica_transitions",
  ],
  battery_evidence: [
    "battery_subjects",
    "battery_hierarchy",
    "ownership_history",
    "identifier_bindings",
    "claims",
    "evidence_versions",
    "verification_assertions",
    "evidence_manifests",
    "disputes",
    "admissibility_history",
  ],
  chain_projection: [
    "canonical_blocks",
    "canonical_logs",
    "checkpoints",
    "contract_deployments",
    "contract_abis",
    "reducer_versions",
    "projection_transactions",
    "reorganization_journal",
  ],
  sources_rules_assessment: [
    "authoritative_sources",
    "rule_profiles",
    "method_versions",
    "assessment_inputs",
    "assessment_results",
    "assessment_summaries",
    "reproduction_references",
  ],
  marketplace: [
    "listings",
    "offers",
    "agreements",
    "deliveries",
    "disputes",
    "settlements",
    "state_history",
  ],
  retrieval_audit: [
    "public_documents",
    "public_chunks",
    "repository_search_references",
    "assistant_requests",
    "tool_validation_events",
    "audit_events",
    "audit_batches",
    "audit_anchors",
    "jobs",
    "retries",
    "dead_letters",
    "protected_retention_links",
  ],
  evaluation: [
    "fixture_manifests",
    "case_versions",
    "configuration_versions",
    "runs",
    "metrics",
    "result_references",
  ],
};

function quote(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
exports.up = (pgm) => {
  for (const [schema, tables] of Object.entries(groups)) {
    pgm.sql(`CREATE SCHEMA ${quote(schema)}`);
    for (const table of tables) {
      pgm.sql(`
        CREATE TABLE ${quote(schema)}.${quote(table)} (
          record_id text NOT NULL,
          record_version bigint NOT NULL CHECK (record_version > 0),
          schema_id text NOT NULL,
          schema_version text NOT NULL,
          status text,
          controller_organization_id text,
          payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
          created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
          PRIMARY KEY (record_id, record_version)
        )
      `);
      pgm.sql(
        `CREATE INDEX ${quote(`${table}_status_idx`)} ON ${quote(schema)}.${quote(table)} (status) WHERE status IS NOT NULL`,
      );
    }
  }
};

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
exports.down = (pgm) => {
  for (const schema of Object.keys(groups).reverse()) {
    pgm.sql(`DROP SCHEMA ${quote(schema)} CASCADE`);
  }
};

exports.groups = groups;
