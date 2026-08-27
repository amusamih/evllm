/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX key_operation_capabilities_nonce_scope_idx
      ON repository_private.key_operation_capabilities ((metadata->>'nonce_scope'))
      WHERE metadata ? 'nonce_scope'
  `);
};

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX repository_private.key_operation_capabilities_nonce_scope_idx
  `);
};
