import type { EvidenceLedger, EvidenceRecord } from "../evidence/index.js";
import type { AssessmentResult } from "./assessment.js";
import type { DatedRuleRegistry, RegisteredSource } from "./rules.js";

export interface AssessmentRecord {
  readonly createdAt: number;
  readonly result: AssessmentResult;
  readonly status: "active" | "revoked" | "superseded";
}

export class AssessmentLedger {
  readonly #records = new Map<string, AssessmentRecord[]>();

  public issue(result: AssessmentResult, createdAt: number): AssessmentRecord {
    const history = this.#records.get(result.assessmentInputId) ?? [];
    if (
      history.some(
        ({ result: prior }) => prior.reproductionHash.value === result.reproductionHash.value,
      )
    ) {
      throw new Error("Assessment result already exists");
    }
    const prior = history.at(-1);
    if (prior !== undefined) history[history.length - 1] = { ...prior, status: "superseded" };
    const record: AssessmentRecord = { createdAt, result, status: "active" };
    history.push(record);
    this.#records.set(result.assessmentInputId, history);
    return structuredClone(record);
  }

  public current(inputId: string): AssessmentRecord {
    const record = this.#records.get(inputId)?.at(-1);
    if (record === undefined) throw new Error("Assessment not found");
    return structuredClone(record);
  }

  public history(inputId: string): readonly AssessmentRecord[] {
    return structuredClone(this.#records.get(inputId) ?? []);
  }
}

export class DecisionQueryService {
  public constructor(
    private readonly evidence: EvidenceLedger,
    private readonly assessments: AssessmentLedger,
    private readonly rules: DatedRuleRegistry,
  ) {}

  public evidenceCurrent(claimId: string): EvidenceRecord {
    return this.evidence.current(claimId);
  }

  public evidenceHistory(claimId: string): readonly EvidenceRecord[] {
    return this.evidence.history(claimId);
  }

  public assessmentCurrent(inputId: string): AssessmentRecord {
    return this.assessments.current(inputId);
  }

  public assessmentHistory(inputId: string): readonly AssessmentRecord[] {
    return this.assessments.history(inputId);
  }

  public authoritativeSource(sourceId: string, version: number): RegisteredSource {
    return this.rules.source(sourceId, version);
  }
}
