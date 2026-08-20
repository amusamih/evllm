export const SEPOLIA_CHAIN_ID = 11_155_111n;
export const SEPOLIA_WORKFLOW_ID = "paper-public-workflow-v1";
export const SEPOLIA_WORKFLOW_CONFIRMATION = "SUBMIT_ONE_PUBLIC_WORKFLOW";
export const SEPOLIA_WORKFLOW_PURCHASE_WEI = 1_000_000_000_000n;

export const sepoliaWorkflowRoles = [
  {
    role: "deployer",
    environment: "SEPOLIA_DEPLOYER_PRIVATE_KEY",
    gasBudget: 0n,
    transferredValue: 0n,
  },
  {
    role: "governance",
    environment: "SEPOLIA_GOVERNANCE_PRIVATE_KEY",
    gasBudget: 3_000_000n,
    transferredValue: 0n,
  },
  {
    role: "issuer",
    environment: "SEPOLIA_ISSUER_PRIVATE_KEY",
    gasBudget: 500_000n,
    transferredValue: 0n,
  },
  {
    role: "controller",
    environment: "SEPOLIA_CONTROLLER_PRIVATE_KEY",
    gasBudget: 1_200_000n,
    transferredValue: 0n,
  },
  {
    role: "registrar",
    environment: "SEPOLIA_REGISTRAR_PRIVATE_KEY",
    gasBudget: 300_000n,
    transferredValue: 0n,
  },
  {
    role: "verifier",
    environment: "SEPOLIA_VERIFIER_PRIVATE_KEY",
    gasBudget: 500_000n,
    transferredValue: 0n,
  },
  {
    role: "seller",
    environment: "SEPOLIA_SELLER_PRIVATE_KEY",
    gasBudget: 2_500_000n,
    transferredValue: 0n,
  },
  {
    role: "buyer",
    environment: "SEPOLIA_BUYER_PRIVATE_KEY",
    gasBudget: 800_000n,
    transferredValue: SEPOLIA_WORKFLOW_PURCHASE_WEI,
  },
  {
    role: "replica_attester",
    environment: "SEPOLIA_REPLICA_ATTESTER_PRIVATE_KEY",
    gasBudget: 1_200_000n,
    transferredValue: 0n,
  },
  {
    role: "logistics_provider",
    environment: "SEPOLIA_LOGISTICS_PRIVATE_KEY",
    gasBudget: 1_800_000n,
    transferredValue: 0n,
  },
  {
    role: "audit_anchor",
    environment: "SEPOLIA_AUDIT_ANCHOR_PRIVATE_KEY",
    gasBudget: 400_000n,
    transferredValue: 0n,
  },
] as const;

export type SepoliaWorkflowRole = (typeof sepoliaWorkflowRoles)[number]["role"];

export const sepoliaContractNames = [
  "AuthorityProfileRegistry",
  "ProtectedBundleRegistry",
  "BatteryOwnershipRegistry",
  "DeploymentRegistry",
  "EvidenceRegistry",
  "Marketplace",
  "AuditAnchor",
] as const;

export type SepoliaContractName = (typeof sepoliaContractNames)[number];
