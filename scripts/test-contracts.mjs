import assert from "node:assert/strict";

import { network } from "hardhat";

const { ethers } = await network.create();
const [governance, controller, other, registrar, marketplace] = await ethers.getSigners();
const id = (value) => ethers.keccak256(ethers.toUtf8Bytes(value));

async function confirmed(transaction) {
  await (await transaction).wait();
}

async function rejects(action, label) {
  await assert.rejects(action, undefined, label);
}

const authority = await ethers.deployContract("AuthorityProfileRegistry", [governance.address]);
await authority.waitForDeployment();
const organizationId = id("organization:controller");
const replicaOrganizationId = id("organization:replica");
const replicaCredentialId = id("credential:replica");
await rejects(
  () => authority.connect(other).setOrganizationStatus(organizationId, 1),
  "only governance changes organization status",
);
await confirmed(authority.setOrganizationStatus(organizationId, 1));
await confirmed(authority.setOrganizationStatus(replicaOrganizationId, 1));
await confirmed(
  authority.setCredential(replicaCredentialId, replicaOrganizationId, other.address, true, true),
);
assert.equal(await authority.isOrganizationActive(organizationId), true);

const bundleRegistry = await ethers.deployContract("ProtectedBundleRegistry", [
  await authority.getAddress(),
]);
await bundleRegistry.waitForDeployment();
const commit = [
  id("bundle:1"),
  id("domain:evidence:1"),
  organizationId,
  id("bundle-type:evidence"),
  id("payload-commitment"),
  id("envelope-digest"),
  512,
  id("replica-policy"),
  0,
];
await confirmed(bundleRegistry.connect(governance).commitProtectedBundle(...commit));
await rejects(
  () => bundleRegistry.connect(governance).commitProtectedBundle(...commit),
  "bundle and domain keys are globally one-time",
);
await rejects(
  () => bundleRegistry.connect(other).promoteToDecisionCritical(commit[0]),
  "only the recorded controller promotes",
);
await confirmed(
  bundleRegistry
    .connect(other)
    .submitReplicaReceipt(
      commit[0],
      id("repository:replica"),
      replicaOrganizationId,
      replicaCredentialId,
      commit[5],
      commit[6],
      id("receipt:1"),
    ),
);
await confirmed(bundleRegistry.connect(governance).promoteToDecisionCritical(commit[0]));
await rejects(
  () => bundleRegistry.connect(governance).promoteToDecisionCritical(commit[0]),
  "promotion is irreversible",
);

const ownership = await ethers.deployContract("BatteryOwnershipRegistry", [governance.address]);
await ownership.waitForDeployment();
const batteryId = id("battery:1");
await rejects(
  () => ownership.connect(other).registerBattery(batteryId, organizationId),
  "unapproved registrars are rejected",
);
await confirmed(ownership.setRegistrar(registrar.address, true));
await confirmed(ownership.setMarketplace(marketplace.address, true));
await confirmed(ownership.connect(registrar).registerBattery(batteryId, organizationId));
await rejects(
  () => ownership.connect(other).lockForMarketplace(batteryId),
  "unapproved marketplaces cannot lock batteries",
);
await confirmed(ownership.connect(marketplace).lockForMarketplace(batteryId));
const buyerOrganizationId = id("organization:buyer");
await confirmed(
  ownership.connect(marketplace).transferRecordedOwnership(batteryId, buyerOrganizationId),
);
const battery = await ownership.batteries(batteryId);
assert.equal(battery.recordedOwnerOrganizationId, buyerOrganizationId);
assert.equal(battery.marketplaceLock, ethers.ZeroAddress);

const deployment = await ethers.deployContract("DeploymentRegistry", [
  governance.address,
  await authority.getAddress(),
  await bundleRegistry.getAddress(),
  await ownership.getAddress(),
  0,
]);
await deployment.waitForDeployment();
assert.equal(await deployment.authorityProfileRegistry(), await authority.getAddress());
assert.equal(await deployment.protectedBundleRegistry(), await bundleRegistry.getAddress());
assert.equal(await deployment.batteryOwnershipRegistry(), await ownership.getAddress());

const evidenceType = ethers.encodeBytes32String("evidence");
const module = await ethers.deployContract("TestDomainModule", [evidenceType, 1]);
await module.waitForDeployment();
const moduleAddress = await module.getAddress();
await rejects(
  () => deployment.connect(other).proposeModule(evidenceType, moduleAddress),
  "only governance proposes modules",
);
await rejects(
  () => deployment.proposeModule(ethers.encodeBytes32String("assessment"), moduleAddress),
  "module type mismatch is rejected",
);
await confirmed(deployment.proposeModule(evidenceType, moduleAddress));
await confirmed(deployment.activateModule(evidenceType));
assert.equal(await deployment.activeModules(evidenceType), moduleAddress);

const aggregateId = id("evidence-root:1");
const deploymentAddress = await deployment.getAddress();
await rejects(
  () => deployment.connect(other).bindAggregateOrigin(aggregateId),
  "only an active module binds its aggregate origin",
);
await confirmed(module.bindOrigin(deploymentAddress, aggregateId));
await rejects(
  () => module.bindOrigin(deploymentAddress, aggregateId),
  "aggregate origin cannot be rebound",
);

process.stdout.write("Contract assurance checks passed: 4 stable registries, 18 assertions.\n");
