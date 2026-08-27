import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const EVIDENCE = "0x65766964656e6365000000000000000000000000000000000000000000000000";
const MARKETPLACE = "0x6d61726b6574706c616365000000000000000000000000000000000000000000";
const AUDIT = "0x6175646974000000000000000000000000000000000000000000000000000000";

export default buildModule("ProductionDeployment", (module) => {
  const deployer = module.getAccount(0);
  const governance = module.getAccount(1);
  const reviewDelaySeconds = module.getParameter("reviewDelaySeconds", 86_400);
  const acceptanceWindowSeconds = module.getParameter("acceptanceWindowSeconds", 86_400);

  const authorityProfileRegistry = module.contract("AuthorityProfileRegistry", [governance], {
    from: deployer,
  });
  const protectedBundleRegistry = module.contract(
    "ProtectedBundleRegistry",
    [authorityProfileRegistry],
    { from: deployer },
  );
  const batteryOwnershipRegistry = module.contract("BatteryOwnershipRegistry", [governance], {
    from: deployer,
  });
  const deploymentRegistry = module.contract(
    "DeploymentRegistry",
    [
      governance,
      authorityProfileRegistry,
      protectedBundleRegistry,
      batteryOwnershipRegistry,
      reviewDelaySeconds,
    ],
    { from: deployer },
  );
  const evidenceRegistry = module.contract(
    "EvidenceRegistry",
    [authorityProfileRegistry, protectedBundleRegistry],
    { from: deployer },
  );
  const marketplace = module.contract(
    "Marketplace",
    [
      authorityProfileRegistry,
      protectedBundleRegistry,
      batteryOwnershipRegistry,
      deploymentRegistry,
      acceptanceWindowSeconds,
    ],
    { from: deployer },
  );
  const auditAnchor = module.contract("AuditAnchor", [authorityProfileRegistry], {
    from: deployer,
  });

  module.call(batteryOwnershipRegistry, "setMarketplace", [marketplace, true], {
    from: governance,
  });
  module.call(protectedBundleRegistry, "closeBootstrap", [], { from: deployer });
  module.call(deploymentRegistry, "proposeModule", [EVIDENCE, evidenceRegistry], {
    from: governance,
    id: "proposeEvidence",
  });
  module.call(deploymentRegistry, "proposeModule", [MARKETPLACE, marketplace], {
    from: governance,
    id: "proposeMarketplace",
  });
  module.call(deploymentRegistry, "proposeModule", [AUDIT, auditAnchor], {
    from: governance,
    id: "proposeAuditAnchor",
  });

  return {
    auditAnchor,
    authorityProfileRegistry,
    batteryOwnershipRegistry,
    deploymentRegistry,
    evidenceRegistry,
    marketplace,
    protectedBundleRegistry,
  };
});
