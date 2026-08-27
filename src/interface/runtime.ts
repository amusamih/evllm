import { getAddress, verifyMessage } from "ethers";

import {
  AssistantAuditLedger,
  AssistantRequestStore,
  AssistantToolRegistry,
  GovernedAssistantService,
  OpenAIAssistantModel,
  ProtectedSearchTool,
  TypedQueryTool,
  WalletSessionManager,
  type AssistantModelProvider,
  type AssistantToolContext,
} from "../assistant/index.js";
import {
  CONTROLLED_ACTOR_ID,
  CONTROLLED_CREDENTIAL_ID,
  CONTROLLED_ORGANIZATION_ID,
  ControlledCaseCatalog,
  controlledActorSession,
} from "./cases.js";
import { createResearchInterfaceService, type ResearchInterfaceService } from "./service.js";

export interface ResearchRuntimeOptions {
  readonly controlledWalletAddress: string;
  readonly corpusPath: string;
  readonly apiKey?: string;
  readonly modelName: string;
  readonly modelProvider?: AssistantModelProvider;
  readonly now?: () => number;
}

export interface ResearchRuntime {
  readonly assistant: GovernedAssistantService;
  readonly audit: AssistantAuditLedger;
  readonly cases: ControlledCaseCatalog;
  readonly interfaceService: ResearchInterfaceService;
  readonly requests: AssistantRequestStore;
  readonly sessions: WalletSessionManager;
  readonly tools: AssistantToolRegistry;
}

export function createResearchRuntime(options: ResearchRuntimeOptions): ResearchRuntime {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  const controlledWalletAddress = getAddress(options.controlledWalletAddress).toLowerCase();
  const cases = ControlledCaseCatalog.load(options.corpusPath);
  const audit = new AssistantAuditLedger();
  const requests = new AssistantRequestStore();
  const tools = controlledToolRegistry(cases);
  const model = options.modelProvider ?? openAIModel(options);
  const assistant = new GovernedAssistantService(tools, model, audit, requests, now);
  const session = Object.freeze({
    ...controlledActorSession(now()),
    address: controlledWalletAddress,
  });
  const sessions = controlledWalletSessions(controlledWalletAddress, now);
  const interfaceService = createResearchInterfaceService({ assistant, cases, session, now });
  return { assistant, audit, cases, interfaceService, requests, sessions, tools };
}

function openAIModel(options: ResearchRuntimeOptions): OpenAIAssistantModel {
  if (options.apiKey === undefined) {
    throw new Error("OPENAI_API_KEY is required for the governed research runtime");
  }
  return new OpenAIAssistantModel(options.apiKey, options.modelName);
}

function controlledToolRegistry(cases: ControlledCaseCatalog): AssistantToolRegistry {
  const query = (name: "facts" | "history" | "rules" | "assessment" | "audit") =>
    new TypedQueryTool(name, (context) =>
      Promise.resolve(cases.supports(context.arguments.case_id, name)),
    );
  const protectedSearch = new ProtectedSearchTool((context: AssistantToolContext) =>
    Promise.resolve({
      authorizationAllowed: false,
      repositoryAvailable: false,
      envelopeDigestVerified: false,
      packageCommitmentsVerified: false,
      domainSignatureVerified: false,
      keyReleaseAllowed: false,
      decryptedInsideCustodyBoundary: false,
      supports: cases.supports(context.arguments.case_id, "protected-search"),
    }),
  );
  return new AssistantToolRegistry(
    [
      query("facts"),
      query("history"),
      query("rules"),
      query("assessment"),
      query("audit"),
      protectedSearch,
    ],
    (session, purposeId, tool, arguments_) =>
      Promise.resolve(cases.authorizes(session, purposeId, tool, arguments_)),
  );
}

function controlledWalletSessions(
  configuredWalletAddress: string,
  now: () => number,
): WalletSessionManager {
  const expectedWalletAddress = getAddress(configuredWalletAddress);
  return new WalletSessionManager(
    (challenge, signature) => {
      try {
        return Promise.resolve(
          getAddress(verifyMessage(challenge.message, signature)) === getAddress(challenge.address),
        );
      } catch {
        return Promise.resolve(false);
      }
    },
    (identity) =>
      Promise.resolve(
        identity.actorId === CONTROLLED_ACTOR_ID &&
          identity.organizationId === CONTROLLED_ORGANIZATION_ID &&
          identity.credentialId === CONTROLLED_CREDENTIAL_ID &&
          getAddress(identity.address) === expectedWalletAddress,
      ),
    now,
  );
}
