import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sustainabilityValidationEvidence } from "./lib/sustainability-evidence.js";

const output = sustainabilityValidationEvidence();
if (Object.values(output.assertions).some((value) => !value))
  throw new Error("A sustainability validation assertion failed");

await mkdir(resolve("evaluation/final"), { recursive: true });
await Promise.all([
  writeFile(
    resolve("evaluation/final/sustainability-validation.json"),
    `${JSON.stringify(output, null, 2)}\n`,
  ),
  writeFile(resolve("evaluation/final/SUSTAINABILITY_RESULTS.md"), markdown(output)),
]);
process.stdout.write(
  `${JSON.stringify({ assertions: output.assertions, reproductionHash: output.scenarios.nominal.reproductionHash }, null, 2)}\n`,
);

function markdown(result: ReturnType<typeof sustainabilityValidationEvidence>): string {
  const routeNames: Record<string, string> = {
    "continued-compatible-ev-use": "Continued compatible EV use",
    "stationary-storage-repurposing": "Stationary-storage repurposing",
    recycling: "Recycling",
  };
  const categoryNames: Record<string, string> = {
    gwp: "Climate change",
    "mineral-depletion": "Mineral depletion",
  };
  const unitNames: Record<string, string> = {
    "kg-co2e/service": "kg CO2e/service",
    "kg-sb-e/service": "kg Sb-e/service",
  };
  const checkNames: Record<string, string> = {
    nominalAnswers: "Nominal case returns a supported route preference",
    failedGateCannotBePreferred:
      "A route that does not meet technical and safety eligibility is not selected",
    missingCriticalEvidenceAbstains: "Missing critical information produces abstention",
    conflictRequiresExternalDecision:
      "Conflicting critical information requires an external decision",
    contextChangesEnvironmentalIndicator:
      "A changed context factor changes the environmental indicator",
    contextPreservesCircularity: "The same context change preserves circularity",
    contextPreservesEconomics: "The same context change preserves economics",
    unstableRankingAbstains: "An unstable scenario ranking produces abstention",
    deterministicReplay: "Exact replay reproduces the complete result",
  };
  const nominalRows = result.scenarios.nominal.routes
    .map(
      (route) =>
        `| ${routeNames[route.routeId] ?? route.routeId} | ${route.G} | ${route.C.value ?? `${route.C.lower}-${route.C.upper}`} | ${route.I.map(({ category, value, unit }) => `${categoryNames[category] ?? category}: ${value} ${unitNames[unit] ?? unit}`).join("; ")} | ${route.E.netPresentValue} ${route.E.currency} | ${route.A.coverage} | ${route.U.rankStable ? "stable" : "unstable"} |`,
    )
    .join("\n");
  const checks = Object.entries(result.assertions)
    .map(([name, passed]) => `| ${checkNames[name] ?? name} | ${passed ? "PASS" : "FAIL"} |`)
    .join("\n");
  const preferredRoute = result.scenarios.nominal.preferredRoute;
  const preferredRouteName =
    typeof preferredRoute === "string"
      ? (routeNames[preferredRoute] ?? preferredRoute)
      : "no route preference";
  return `# Contextual battery route-assessment results

The deterministic service evaluates three second-life routes through six separate components:
technical and safety eligibility (\`G\`), circularity (\`C\`), environmental indicators (\`I\`),
economics (\`E\`), information adequacy (\`A\`), and uncertainty and rank stability (\`U\`).

## Worked three-route result

| Route | Technical and safety eligibility (G) | Circularity (C, 0 to 100) | Environmental indicators (I) | Net present value (E) | Information adequacy (A) | Rank stability (U) |
|---|---|---:|---|---:|---:|---|
${nominalRows}

The nominal case returns **${preferredRouteName}** under the declared stable scenario ranking. The complete output has reproduction hash
\`${result.scenarios.nominal.reproductionHash.value}\`.

## Deterministic validation

| Check | Result |
|---|---|
${checks}

The eligibility-failure case prevents the ineligible route from being selected. Missing critical evidence
produces abstention, and conflicting critical evidence requires an accountable external decision.
Changing the environmental factor changes \`I\` while leaving circularity and economics unchanged.
Changing the preferred route's rank across scenarios produces abstention.
An exact replay produces the same complete output and reproduction hash.

These controlled cases verify the implemented calculations and decision behavior. Their values are
scenario-specific and should not be interpreted as universal sustainability certification or as an
empirical lifecycle assessment of all batteries.
`;
}
