import type { ActorSession, AssistantQuery, AssistantSupport, AssistantToolName } from "./types.js";

export interface AssistantToolContext {
  readonly session: ActorSession;
  readonly purposeId: string;
  readonly asOf: number;
  readonly arguments: Readonly<Record<string, boolean | number | string>>;
}

export interface AssistantTool {
  readonly name: AssistantToolName;
  execute(context: AssistantToolContext): Promise<readonly AssistantSupport[]>;
}

export interface ToolExecution {
  readonly supports: readonly AssistantSupport[];
  readonly toolNames: readonly AssistantToolName[];
  readonly injectionDetected: boolean;
}

export class ToolAuthorizationError extends Error {}
export class ProtectedRetrievalError extends Error {}

export interface ProtectedRetrievalResult {
  readonly authorizationAllowed: boolean;
  readonly repositoryAvailable: boolean;
  readonly envelopeDigestVerified: boolean;
  readonly packageCommitmentsVerified: boolean;
  readonly domainSignatureVerified: boolean;
  readonly keyReleaseAllowed: boolean;
  readonly decryptedInsideCustodyBoundary: boolean;
  readonly supports: readonly AssistantSupport[];
}

export class ProtectedSearchTool implements AssistantTool {
  public readonly name = "protected-search" as const;

  public constructor(
    private readonly retrieve: (context: AssistantToolContext) => Promise<ProtectedRetrievalResult>,
  ) {}

  public async execute(context: AssistantToolContext): Promise<readonly AssistantSupport[]> {
    const result = await this.retrieve(context);
    if (
      !result.authorizationAllowed ||
      !result.repositoryAvailable ||
      !result.envelopeDigestVerified ||
      !result.packageCommitmentsVerified ||
      !result.domainSignatureVerified ||
      !result.keyReleaseAllowed ||
      !result.decryptedInsideCustodyBoundary
    ) {
      throw new ProtectedRetrievalError("Protected retrieval verification failed");
    }
    return result.supports;
  }
}

export class TypedQueryTool implements AssistantTool {
  public constructor(
    public readonly name: Exclude<AssistantToolName, "protected-search">,
    private readonly query: (context: AssistantToolContext) => Promise<readonly AssistantSupport[]>,
  ) {}

  public execute(context: AssistantToolContext): Promise<readonly AssistantSupport[]> {
    return this.query(context);
  }
}

export class AssistantToolRegistry {
  readonly #tools = new Map<AssistantToolName, AssistantTool>();

  public constructor(
    tools: readonly AssistantTool[],
    private readonly authorize: (
      session: ActorSession,
      purposeId: string,
      tool: AssistantToolName,
      arguments_: Readonly<Record<string, boolean | number | string>>,
    ) => Promise<boolean>,
  ) {
    for (const tool of tools) {
      if (this.#tools.has(tool.name)) throw new Error(`Duplicate assistant tool ${tool.name}`);
      this.#tools.set(tool.name, tool);
    }
  }

  public names(): readonly AssistantToolName[] {
    return [...this.#tools.keys()].sort();
  }

  public async execute(query: AssistantQuery, session: ActorSession): Promise<ToolExecution> {
    const supports: AssistantSupport[] = [];
    let injectionDetected = false;
    for (const request of query.requests) {
      const tool = this.#tools.get(request.tool);
      if (tool === undefined) throw new ToolAuthorizationError("Tool is not registered");
      if (!(await this.authorize(session, query.purpose_id, request.tool, request.arguments))) {
        throw new ToolAuthorizationError("Tool access denied");
      }
      const result = await tool.execute({
        session,
        purposeId: query.purpose_id,
        asOf: query.as_of,
        arguments: request.arguments,
      });
      for (const support of result) {
        const unsafe = containsInstructionLikeContent(support.content);
        injectionDetected ||= unsafe;
        supports.push(
          unsafe ? { ...support, content: "[UNTRUSTED_INSTRUCTION_REMOVED]" } : support,
        );
      }
    }
    return { supports, toolNames: query.requests.map(({ tool }) => tool), injectionDetected };
  }
}

function containsInstructionLikeContent(value: string): boolean {
  return /(?:ignore (?:all |the )?(?:previous|prior) instructions|system prompt|developer message|reveal (?:a |the )?(?:secret|key|token)|<script|\bassistant\s*:|\bsystem\s*:)/iu.test(
    value,
  );
}
