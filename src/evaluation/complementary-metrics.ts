export const COMPLEMENTARY_RAW_GENERATION_DIAGNOSTICS = [
  "raw_required_record_coverage",
  "raw_all_required_records_covered",
  "raw_decision_metadata_fidelity",
  "raw_decision_code_fidelity",
  "raw_outcome_fidelity",
  "raw_reason_code_fidelity",
  "raw_explanation_validation",
  "raw_complete_explanatory_synthesis",
] as const;

export type ComplementaryRawGenerationDiagnostic =
  (typeof COMPLEMENTARY_RAW_GENERATION_DIAGNOSTICS)[number];

export type ComplementaryRawGenerationArtifactField =
  | "required_record_coverage"
  | "all_required_records_covered"
  | "deterministic_record_binding"
  | "decision_code_accuracy"
  | "structured_outcome_accuracy"
  | "required_reason_accuracy"
  | "raw_candidate_validation_accuracy"
  | "generation_success";

/**
 * Keeps reader-facing fidelity terminology explicitly bound to the retained
 * machine-artifact fields while retaining stable machine keys.
 */
export const COMPLEMENTARY_RAW_DIAGNOSTIC_FIELD_MAP = {
  raw_required_record_coverage: "required_record_coverage",
  raw_all_required_records_covered: "all_required_records_covered",
  raw_decision_metadata_fidelity: "deterministic_record_binding",
  raw_decision_code_fidelity: "decision_code_accuracy",
  raw_outcome_fidelity: "structured_outcome_accuracy",
  raw_reason_code_fidelity: "required_reason_accuracy",
  raw_explanation_validation: "raw_candidate_validation_accuracy",
  raw_complete_explanatory_synthesis: "generation_success",
} as const satisfies Readonly<
  Record<ComplementaryRawGenerationDiagnostic, ComplementaryRawGenerationArtifactField>
>;

export function assertComplementaryRawDiagnosticFreeze(value: {
  readonly rawGenerationDiagnostics: unknown;
  readonly rawGenerationDiagnosticFieldMap: unknown;
}): void {
  const diagnostics = value.rawGenerationDiagnostics;
  if (
    !Array.isArray(diagnostics) ||
    JSON.stringify(diagnostics) !== JSON.stringify(COMPLEMENTARY_RAW_GENERATION_DIAGNOSTICS)
  ) {
    throw new Error("Complementary raw-generation diagnostic labels do not match the freeze");
  }

  const fieldMap = value.rawGenerationDiagnosticFieldMap;
  if (
    typeof fieldMap !== "object" ||
    fieldMap === null ||
    Array.isArray(fieldMap) ||
    JSON.stringify(fieldMap) !== JSON.stringify(COMPLEMENTARY_RAW_DIAGNOSTIC_FIELD_MAP)
  ) {
    throw new Error("Complementary raw-generation diagnostic field mapping does not match");
  }
}
