/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createExtension("pgcrypto", { ifNotExists: true });
  pgm.createExtension("vector", { ifNotExists: true });
};

/** @param {import("node-pg-migrate").MigrationBuilder} _pgm */
exports.down = (_pgm) => {
  // Extensions can be shared by later migrations and are deliberately retained.
};
