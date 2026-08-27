export type MigrationDirection = "up" | "down";

export type MigrationPolicyDecision =
  | { allowed: true; direction: MigrationDirection }
  | {
      allowed: false;
      code: "MIGRATION_ROLLBACK_PROHIBITED";
      direction: "down";
      environment: "production";
      message: string;
    };

export function decideMigrationPolicy(
  environment: "development" | "test" | "production",
  direction: MigrationDirection,
): MigrationPolicyDecision {
  if (environment === "production" && direction === "down") {
    return {
      allowed: false,
      code: "MIGRATION_ROLLBACK_PROHIBITED",
      direction,
      environment,
      message: "Destructive database rollback is prohibited in production.",
    };
  }
  return { allowed: true, direction };
}
