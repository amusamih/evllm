import type { AssistantSupport } from "./types.js";

const SHORT_SEMANTIC_TOKENS = new Set([
  "no",
  "not",
  "never",
  "pass",
  "fail",
  "fit",
  "unfit",
  "safe",
  "unsafe",
]);
const NEGATORS = new Set(["no", "not", "never", "neither", "without", "cannot", "cant"]);
const NON_MATERIAL_TOKENS = new Set(["component", "value"]);
const ACCOUNTABLE_AUTHORITY_TOKENS = new Set(["accredit", "approve", "certify", "comply", "legal"]);
const NUMBER_WORD_TOKENS = new Set([
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
]);
const DISCLOSURE_FIELD_TOKENS = new Set([
  "capacity",
  "circularity",
  "climate",
  "conflict",
  "coverage",
  "depletion",
  "eligibility",
  "fraction",
  "frequency",
  "gwp",
  "health",
  "lifecycle",
  "mileage",
  "mineral",
  "npv",
  "ownership",
  "payback",
  "rank",
  "sequence",
  "status",
  "temperature",
  "verifier",
  "voltage",
]);
const DISCLOSURE_VALUE_TOKENS = new Set([
  "accept",
  "active",
  "approve",
  "available",
  "deny",
  "eligible",
  "fail",
  "forbid",
  "inactive",
  "ineligible",
  "locked",
  "missing",
  "pass",
  "permit",
  "preferred",
  "prohibited",
  "reject",
  "restricted",
  "stale",
  "superseded",
  "unavailable",
  "unlocked",
  "unverified",
  "verify",
]);
const RELATIONAL_STATUS_TOKENS = new Set([
  "accept",
  "active",
  "allow",
  "approve",
  "available",
  "complete",
  "current",
  "deny",
  "eligible",
  "fail",
  "forbid",
  "inactive",
  "incomplete",
  "ineligible",
  "locked",
  "missing",
  "pass",
  "permit",
  "present",
  "preferred",
  "prohibited",
  "reject",
  "restricted",
  "revoke",
  "stale",
  "superseded",
  "supported",
  "unavailable",
  "unlocked",
  "unsupported",
  "unverified",
  "verify",
]);
const RELATION_BOUNDARIES = new Set(["and", "but", "whereas", "while"]);
const RELATION_SUBJECT_STOPWORDS = new Set([
  "a",
  "an",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "by",
  "for",
  "from",
  "has",
  "have",
  "had",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "under",
  "was",
  "were",
  "with",
]);
const QUANTITY_UNITS = new Set([
  "percent",
  "percentage",
  "kg",
  "g",
  "mg",
  "kwh",
  "wh",
  "km",
  "mile",
  "miles",
  "eur",
  "usd",
  "cycle",
  "cycles",
  "year",
  "years",
  "day",
  "days",
  "hour",
  "hours",
]);
const INCOMPATIBLE_TERM_GROUPS = [
  ["preferred", "reject"],
  ["approve", "reject"],
  ["accept", "reject"],
  ["verify", "unverified"],
  ["permit", "forbid", "prohibited"],
  ["active", "inactive", "revoked", "stale", "restricted", "superseded"],
  ["pass", "fail"],
  ["available", "unavailable"],
  ["allowed", "denied", "prohibited"],
  ["locked", "unlocked"],
  ["current", "stale"],
  ["eligible", "ineligible"],
  ["present", "missing"],
  ["complete", "incomplete"],
  ["supported", "unsupported"],
] as const;

/**
 * Tests whether cited records jointly support a user-visible factual statement.
 * The check is intentionally conservative. In addition to lexical overlap, it
 * preserves numbers and the polarity of material terms so that, for example,
 * "81 percent" cannot support "18 percent" and "preferred" cannot support
 * "not preferred".
 */
export function hasJointSemanticSupport(
  statement: string,
  supports: readonly Pick<AssistantSupport, "content">[],
  requireEachSupportContribution = true,
): boolean {
  if (supports.length === 0) return false;
  const rawSupportTexts = supports.map(({ content }) => content);
  if (hasInvalidRouteComponentMapping(statement, rawSupportTexts)) return false;
  if (!glossaryDefinitionTuplesArePreserved(statement, rawSupportTexts)) return false;
  if (!ordinaryDefinitionTuplesArePreserved(statement, rawSupportTexts)) return false;
  if (!routeComparisonsUseCitedSubjects(statement, rawSupportTexts)) return false;
  if (!routeComponentScopesArePreserved(statement, rawSupportTexts)) return false;
  const normalizedStatement = normalizeSemanticEquivalences(statement);
  const supportTexts = rawSupportTexts.map(normalizeSemanticEquivalences);
  return semanticallySupportedAfterNormalization(
    normalizedStatement,
    supportTexts,
    requireEachSupportContribution,
  );
}

function semanticallySupportedAfterNormalization(
  statement: string,
  supportTexts: readonly string[],
  requireEachSupportContribution: boolean,
): boolean {
  for (const clause of factualClauses(statement)) {
    if (!hasClauseSemanticSupport(clause, supportTexts)) return false;
  }
  const statementTokens = materialTokens(statement);
  if (statementTokens.size === 0) return isNonFactualBoilerplate(statement);
  const supportTokenSets = supportTexts.map((content) => materialTokens(content));
  const union = new Set(supportTokenSets.flatMap((tokens) => [...tokens]));
  if (tokenOverlap(statementTokens, union) < 0.5) return false;

  if (!requireEachSupportContribution || supportTokenSets.length <= 1) return true;
  return supportTokenSets.every((tokens, index) => {
    const otherTokens = new Set(
      supportTokenSets.flatMap((other, otherIndex) => (otherIndex === index ? [] : [...other])),
    );
    return [...statementTokens].some((token) => tokens.has(token) && !otherTokens.has(token));
  });
}

type RouteComponent = "G" | "C" | "I" | "E" | "A" | "U";

type RouteSupportScope = {
  subject: string;
  content: string;
};

const ROUTE_COMPONENT_LABELS: Readonly<Record<RouteComponent, RegExp>> = {
  G: /^(?:the\s+)?technical\s+and\s+safety(?:\s+gate)?$/iu,
  C: /^(?:the\s+)?circularity$/iu,
  I: /^(?:the\s+)?environmental\s+indicators?$/iu,
  E: /^(?:the\s+)?econom(?:ics?|ic)$/iu,
  A: /^(?:the\s+)?information\s+adequacy$/iu,
  U: /^(?:the\s+)?uncertainty$/iu,
};

const GENERIC_ROUTE_COMPONENT_SUBJECTS = new Set([
  "assessment",
  "assessment result",
  "component",
  "it",
  "result",
  "route",
  "route assessment",
  "this",
  "this assessment",
  "this component",
  "this result",
  "this route",
  "value",
]);

const KNOWN_ROUTE_SUBJECTS = [
  {
    subject: "continued compatible ev use",
    pattern: /\b(?:continued\s+(?:compatible\s+)?(?:ev|electric\s+vehicle|automotive)\s+use)\b/iu,
  },
  {
    subject: "stationary storage repurposing",
    pattern: /\b(?:stationary(?:-|\s+)(?:storage|energy(?:-|\s+)storage)(?:-|\s+)repurposing)\b/iu,
  },
  { subject: "recycling", pattern: /\brecycling\b/iu },
] as const;

const KNOWN_ROUTE_REFERENCE_SOURCE =
  "(?:continued\\s+(?:compatible\\s+)?(?:ev|electric\\s+vehicle|automotive)\\s+use|stationary(?:-|\\s+)(?:storage|energy(?:-|\\s+)storage)(?:-|\\s+)repurposing|recycling)";

function routeComponentScopesArePreserved(
  statement: string,
  supportTexts: readonly string[],
): boolean {
  const scopes = routeSupportScopes(supportTexts);
  const subjects = [...new Set(scopes.map(({ subject }) => subject))];
  if (subjects.length === 0 || !containsRouteComponentContent(statement)) return true;

  const subjectPattern = new RegExp(
    `\\b(?:${subjects
      .sort((left, right) => right.length - left.length)
      .map(routeSubjectPattern)
      .join("|")})\\b`,
    "giu",
  );
  const mentions = [...statement.matchAll(subjectPattern)].map((match) => ({
    start: match.index ?? 0,
    subject: canonicalRouteSubject(match[0]),
  }));

  if (mentions.length === 0) {
    if (subjects.length === 1) return true;
    const normalizedStatement = normalizeSemanticEquivalences(statement);
    return subjects.every((subject) => {
      const matching = scopes
        .filter((scope) => scope.subject === subject)
        .map(({ content }) => normalizeSemanticEquivalences(content));
      return semanticallySupportedAfterNormalization(normalizedStatement, matching, false);
    });
  }

  for (const [index, mention] of mentions.entries()) {
    const nextStart = mentions[index + 1]?.start ?? statement.length;
    const fragment = statement
      .slice(mention.start, nextStart)
      .replace(/\b(?:and|for|the|while|whereas)\s*$/iu, "")
      .trim();
    if (!containsRouteComponentContent(fragment)) continue;
    const matching = scopes
      .filter(({ subject }) => subject === mention.subject)
      .map(({ content }) => normalizeSemanticEquivalences(content));
    if (
      matching.length === 0 ||
      !semanticallySupportedAfterNormalization(
        normalizeSemanticEquivalences(fragment),
        matching,
        false,
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * A claim that compares one named route with another needs records for both
 * routes. A single route record can support its own values, but it cannot by
 * itself establish that those values are the same as another route's values.
 */
function routeComparisonsUseCitedSubjects(
  statement: string,
  supportTexts: readonly string[],
): boolean {
  const suppliedSubjects = new Set(routeSupportScopes(supportTexts).map(({ subject }) => subject));
  if (suppliedSubjects.size === 0 || !containsRouteComponentContent(statement)) return true;

  const mentionedSubjects = KNOWN_ROUTE_SUBJECTS.filter(({ pattern }) =>
    pattern.test(statement),
  ).map(({ subject }) => subject);
  // Any named route whose components are asserted or compared must have its own
  // route-assessment record among this claim's cited supports.
  if (mentionedSubjects.some((subject) => !suppliedSubjects.has(subject))) return false;

  const routeComparisonLanguage =
    /\b(?:same\s+as(?:\s+for)?|identical\s+to|(?:is|are)\s+equivalent\s+to|shares?|shared|both\s+routes?|tied(?:\s+with)?)\b/iu.test(
      statement,
    ) ||
    new RegExp(
      `\\b(?:match(?:es)?|equals?|equivalent\\s+to|mirror(?:s|ed|ing)?|compared\\s+(?:with|to)|relative\\s+to|as\\s+(?:does|do)|in\\s+common\\s+with|on\\s+par\\s+with)\\s+(?:the\\s+)?${KNOWN_ROUTE_REFERENCE_SOURCE}\\b`,
      "iu",
    ).test(statement);
  if (!routeComparisonLanguage) return true;

  // A cross-route equality or shared-value claim needs at least two route records,
  // including when one of the compared routes is implicit in the sentence.
  if (suppliedSubjects.size < 2) return false;
  return true;
}

function routeSupportScopes(supportTexts: readonly string[]): RouteSupportScope[] {
  const scopes: RouteSupportScope[] = [];
  for (const content of supportTexts) {
    for (const match of content.matchAll(/(?:^|[\n.])\s*([^:\n.]{2,80}?)\s*:\s*G\s*=/giu)) {
      const subject = canonicalRouteSubject(match[1] ?? "");
      if (subject.length > 0) scopes.push({ content, subject });
    }
  }
  return scopes;
}

function containsRouteComponentContent(value: string): boolean {
  return /\b(?:[GCIEAU]\s*=|G\s+(?:component\s+)?is\s+(?:PASS|FAIL)|C\s+(?:component\s+)?is\s+[-+]?[0-9]|technical\s+and\s+safety\s+gate|circularity|environmental\s+indicators?|gwp|climate\s+change|mineral(?:-|\s+)depletion|NPV|net\s+present\s+value|usable-field\s+coverage|verified\s+fraction|conflicts?|eligibility-pass\s+frequency|rank\s+stable|stable\s+rank)\b/iu.test(
    value,
  );
}

function routeSubjectPattern(value: string): string {
  return canonicalRouteSubject(value).split(" ").map(escapeRegExp).join("(?:\\s+|-)+");
}

function canonicalRouteSubject(value: string): string {
  return lexicalTokens(value)
    .flatMap((token) => token.split("-"))
    .filter((token, index) => !(index === 0 && token === "the") && token.length > 0)
    .filter(
      (token, index, tokens) =>
        !(index === tokens.length - 1 && ["assessment", "result", "route"].includes(token)),
    )
    .join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Rejects an asserted route-component meaning unless the asserted relation uses
 * the defined G/C/I/E/A/U label, a generic component subject, or the name of a
 * route supplied by the cited records. This is a positive mapping check rather
 * than a blacklist of previously observed wrong labels.
 */
function hasInvalidRouteComponentMapping(
  statement: string,
  supportTexts: readonly string[],
): boolean {
  const supplied = supportTexts.join(" ");
  const suppliesRouteComponents =
    /\bG\s*=.*\bC\s*=.*\bI\s*=.*\bE\s*=.*\bA\s*=.*\bU\s*=/isu.test(supplied) ||
    /\btechnical and safety gate\b.*\bcircularity\b.*\benvironmental indicators?\b.*\binformation adequacy\b.*\buncertainty\b/isu.test(
      supplied,
    );
  if (!suppliesRouteComponents) return false;

  for (const match of statement.matchAll(
    /\b([GCIEAU])\s+(?:stands\s+for|means|denotes|represents|is\s+defined\s+as|is)\s+(.+?)(?=\s+and\s+[GCIEAU]\s+(?:stands\s+for|means|denotes|represents|is\s+defined\s+as|is)\b|[,;.]|$)/giu,
  )) {
    const component = match[1] as RouteComponent;
    const assertedLabel = normalize(match[2]?.trim() ?? "");
    if (/^(?:(?:PASS|FAIL)\b|[-+]?[0-9])/iu.test(assertedLabel)) continue;
    if (!ROUTE_COMPONENT_LABELS[component].test(assertedLabel)) return true;
  }

  const routeSubjects = suppliedRouteSubjects(supportTexts);
  for (const match of statement.matchAll(/\b([GCIEAU])\s*\(\s*([^()]+?)\s*\)/gu)) {
    const component = match[1] as RouteComponent;
    if (!ROUTE_COMPONENT_LABELS[component].test(normalize(match[2] ?? ""))) return true;
  }
  for (const match of statement.matchAll(
    /(?:^|[;,]|\band\b)\s*(?:for\s+)?(?:the\s+)?([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,6}?)\s*:?\s+([GCIEAU])\s*=/giu,
  )) {
    const component = match[2] as RouteComponent;
    const subject = match[1]?.trim() ?? "";
    if (!isPermittedRouteComponentSubject(subject, component, routeSubjects)) return true;
  }
  const assertions: ReadonlyArray<readonly [RouteComponent, RegExp]> = [
    [
      "G",
      /(?:^|[;,]|\band\b)\s*(?:for\s+[^,;]+,\s*)?(?:the\s+)?([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,4}?)\s+(?:component\s+)?(?:is|has|shows|indicates)\s+(?:a\s+)?(?:PASS|FAIL)\b/giu,
    ],
    [
      "C",
      /(?:^|[;,]|\band\b)\s*(?:for\s+[^,;]+,\s*)?(?:the\s+)?([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,4}?)\s+(?:component\s+)?(?:is|has|shows|indicates)\s+(?:a\s+)?[-+]?[0-9]+(?:\.[0-9]+)?\s*\/\s*100\b/giu,
    ],
    [
      "I",
      /(?:^|[;,]|\band\b)\s*(?:for\s+[^,;]+,\s*)?(?:the\s+)?([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,4}?)\s+(?:component\s+)?(?:includes|contains|has|shows)\s+[^.;]{0,80}\b(?:gwp|climate-change|climate\s+change|mineral-depletion|mineral\s+depletion|environmental\s+indicator)\b/giu,
    ],
    [
      "E",
      /(?:^|[;,]|\band\b)\s*(?:for\s+[^,;]+,\s*)?(?:the\s+)?([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,4}?)\s+(?:component\s+)?(?:is|has|shows|includes)\s+(?:an?\s+)?(?:NPV|net\s+present\s+value)\b/giu,
    ],
    [
      "A",
      /(?:^|[;,]|\band\b)\s*(?:for\s+[^,;]+,\s*)?(?:the\s+)?([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,4}?)\s+(?:component\s+)?(?:is|has|shows|includes)\s+(?:an?\s+)?usable-field\s+coverage\b/giu,
    ],
    [
      "U",
      /(?:^|[;,]|\band\b)\s*(?:for\s+[^,;]+,\s*)?(?:the\s+)?([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,4}?)\s+(?:component\s+)?(?:is|has|shows|indicates|includes)\s+(?:an?\s+)?(?:eligibility-pass\s+frequency|stable\s+rank|rank\s+stability)\b/giu,
    ],
  ];
  for (const [component, pattern] of assertions) {
    for (const match of statement.matchAll(pattern)) {
      const subject = match[1]?.trim() ?? "";
      if (!isPermittedRouteComponentSubject(subject, component, routeSubjects)) return true;
    }
  }
  return false;
}

function suppliedRouteSubjects(supportTexts: readonly string[]): ReadonlySet<string> {
  return new Set(routeSupportScopes(supportTexts).map(({ subject }) => subject));
}

function isPermittedRouteComponentSubject(
  subject: string,
  component: RouteComponent,
  routeSubjects: ReadonlySet<string>,
): boolean {
  const normalizedSubject = canonicalRouteSubject(
    subject
      .replace(/^\s*and\s+/iu, "")
      .replace(/\bcomponent\b/giu, "")
      .replace(/\b(?:gives?|has|includes?|lists?|reports?|shows?)\s*$/iu, ""),
  );
  if (normalizedSubject.length === 0) return true;
  if (routeSubjects.has(normalizedSubject)) return true;
  if (GENERIC_ROUTE_COMPONENT_SUBJECTS.has(normalizedSubject)) return true;
  if (normalizedSubject === component.toLowerCase()) return true;
  return ROUTE_COMPONENT_LABELS[component].test(normalizedSubject);
}

/**
 * Canonicalizes a small set of domain-equivalent surface forms before semantic
 * comparison. These rewrites do not remove quantities, entities, polarity, or
 * lifecycle states; they only make equivalent route and marketplace wording
 * reach the existing conservative checks in the same form.
 */
function normalizeSemanticEquivalences(value: string): string {
  let normalized = normalizeScopedRouteDefinitions(normalizeScopedGlossaryRelations(value))
    .replace(/\bno conflicts?\b/giu, "conflicts 0")
    .replace(
      /\b(?:the\s+)?technical\s+and\s+safety\s+gate(?:\s*\(\s*G\s*\))?\s+(?:is|was|remains)\s+(PASS|FAIL)\b/giu,
      "G=$1",
    )
    .replace(/\b(?:the\s+)?G\s+(?:component\s+)?is\s+(PASS|FAIL)\b/gu, "G=$1")
    .replace(/\bC\s+(?:component\s+)?is\s+(?=[0-9])/gu, "C=")
    .replace(/\bI\s+(?:component\s+)?includes\s+/gu, "I=")
    .replace(/\bE\s+(?:component\s+)?(?:has|is)\s+(?:an?\s+)?(?=NPV\b)/gu, "E=")
    .replace(/\bA\s+(?:component\s+)?(?:shows|is|has)\s+(?=usable-field coverage\b)/gu, "A=")
    .replace(
      /\bU\s+(?:component\s+)?(?:has|is|indicates)\s+(?:an?\s+)?(?=eligibility-pass frequency\b)/gu,
      "U=",
    )
    .replace(/,\s*(?=(?:G|C|I|E|A|U)\s*=)/gu, "; ")
    .replace(/,\s*(?=as\s+(?:per|defined in|confirmed by)\b)/giu, "; ");

  if (/\bbattery\s+[a-z0-9-]+\b/iu.test(normalized)) {
    normalized = normalized.replace(
      /\bis\s+(?:currently\s+)?(?:in\s+a\s+marketplace\s+state\s+)?available(?:-|\s+)for(?:-|\s+)listing(?:\s+in\s+(?:the\s+)?marketplace)?\b/giu,
      "has a marketplace state available-for-listing",
    );
  }
  return normalized;
}

function normalizeScopedRouteDefinitions(value: string): string {
  return value
    .replace(
      /\bG\s+(?:stands\s+for|means|denotes|represents|is\s+defined\s+as|is)\s+(?:the\s+)?technical\s+and\s+safety\s+gate\b/giu,
      "technical and safety gate",
    )
    .replace(
      /\bC\s+(?:stands\s+for|means|denotes|represents|is\s+defined\s+as|is)\s+circularity\b/giu,
      "circularity",
    )
    .replace(
      /\bI\s+(?:stands\s+for|means|denotes|represents|is\s+defined\s+as|is)\s+environmental\s+indicators?\b/giu,
      "environmental indicators",
    )
    .replace(
      /\bE\s+(?:stands\s+for|means|denotes|represents|is\s+defined\s+as|is)\s+econom(?:ics?|ic)\b/giu,
      "economics",
    )
    .replace(
      /\bA\s+(?:stands\s+for|means|denotes|represents|is\s+defined\s+as|is)\s+information\s+adequacy\b/giu,
      "information adequacy",
    )
    .replace(
      /\bU\s+(?:stands\s+for|means|denotes|represents|is\s+defined\s+as|is)\s+uncertainty\b/giu,
      "uncertainty",
    );
}

/** Canonicalizes only explicit abbreviation/glossary definition relations. */
function normalizeScopedGlossaryRelations(value: string): string {
  let normalized = value
    .replace(
      /\b(?:mapping|maps?)\s+([^.;]{0,180}\b(?:abbreviation|acronym)\s+[A-Z][A-Z0-9-]{1,15})\s+to\b/gu,
      "$1 has glossary-definition",
    )
    .replace(
      /\b((?:approved\s+)?(?:abbreviation|acronym)\s+[A-Z][A-Z0-9-]{1,15}(?:\s+for\s+battery\s+[A-Z0-9-]+)?)\s+(?:stands\s+for|refers\s+to|means|is\s+defined\s+as)\b/giu,
      "$1 has glossary-definition",
    )
    .replace(
      /\buses\s+([A-Z][A-Z0-9-]{1,15})\b([^.;]{0,100}?)\s+to\s+mean\b/gu,
      "uses abbreviation $1$2 with glossary-definition",
    );
  if (/\bissuer-approved\s+glossary\b/iu.test(normalized)) {
    normalized = normalized.replace(
      /\bapproved\s+(?=(?:abbreviation|acronym)\s+[A-Z][A-Z0-9-]{1,15}\b[^.;]{0,100}\bhas\s+glossary-definition\b)/giu,
      "",
    );
  }
  return /\b(?:abbreviation|acronym)\s+[A-Z][A-Z0-9-]{1,15}\b/iu.test(value) &&
    /\bglossary\b/iu.test(value)
    ? normalized.replace(/\bas\s+defined\s+in\b/giu, "as per")
    : normalized;
}

type GlossaryDefinitionTuple = {
  abbreviation: string;
  approved: boolean;
  battery: string | null;
  target: ReadonlySet<string>;
};

function glossaryDefinitionTuplesArePreserved(
  statement: string,
  supportTexts: readonly string[],
): boolean {
  const claimed = glossaryDefinitionTuples(statement);
  if (claimed.length === 0) return true;
  const supplied = supportTexts.flatMap(glossaryDefinitionTuples);
  return claimed.every((claim) =>
    supplied.some(
      (support) =>
        claim.abbreviation === support.abbreviation &&
        (!claim.approved || support.approved) &&
        (claim.battery === null || support.battery === claim.battery) &&
        definitionTargetsMatch(claim.target, support.target),
    ),
  );
}

function glossaryDefinitionTuples(value: string): GlossaryDefinitionTuple[] {
  const output: GlossaryDefinitionTuple[] = [];
  const push = (
    abbreviation: string | undefined,
    target: string | undefined,
    context: string,
    explicitBattery?: string,
  ): void => {
    if (abbreviation === undefined || target === undefined) return;
    const targetTokens = definitionTargetTokens(target);
    if (targetTokens.size === 0) return;
    output.push({
      abbreviation: abbreviation.toLowerCase(),
      approved: /\b(?:issuer-)?approved\b/iu.test(context),
      battery: (explicitBattery ?? batteryIdentifier(context))?.toLowerCase() ?? null,
      target: targetTokens,
    });
  };

  for (const segment of value.split(/[.;\n]+/gu)) {
    for (const match of segment.matchAll(
      /\b(?:the\s+)?(?:approved\s+)?(?:abbreviation|acronym)\s+([A-Z][A-Z0-9-]{1,15})(?:\s+for\s+battery\s+([A-Z0-9-]+))?\s+(?:stands\s+for|refers\s+to|means|is\s+defined\s+as)\s+(.+)$/giu,
    )) {
      push(match[1], match[3], segment, match[2]);
    }
    for (const match of segment.matchAll(
      /\b(?:the\s+)?(?:approved\s+)?([A-Z][A-Z0-9-]{1,15})\s+(?:abbreviation|acronym)(?:\s+for\s+battery\s+([A-Z0-9-]+))?\s+(?:stands\s+for|refers\s+to|means|is\s+defined\s+as)\s+(.+)$/gu,
    )) {
      push(match[1], match[3], segment, match[2]);
    }
    for (const match of segment.matchAll(
      /\b(?:mapping|maps?)\s+[^.;]{0,180}?\b(?:abbreviation|acronym)\s+([A-Z][A-Z0-9-]{1,15})\s+to\s+(.+)$/giu,
    )) {
      push(match[1], match[2], segment);
    }
    for (const match of segment.matchAll(
      /\bbattery\s+([A-Z0-9-]+)\s+uses\s+([A-Z][A-Z0-9-]{1,15})\b[^.;]{0,120}?\bto\s+mean\s+(.+)$/giu,
    )) {
      push(match[2], match[3], segment, match[1]);
    }
    for (const match of segment.matchAll(
      /\b([A-Z][A-Z0-9-]{1,15})\s+is\s+the\s+(?:approved\s+)?(?:abbreviation|acronym)\s+for\s+(.+)$/gu,
    )) {
      push(match[1], match[2], segment);
    }
  }
  return output;
}

function definitionTargetTokens(value: string): ReadonlySet<string> {
  const target = value
    .split(/,\s*(?:as\s+(?:per|defined|confirmed)|according\s+to|not\b)/iu)[0]
    ?.replace(/^["']|["']$/gu, "")
    .trim();
  return materialTokens(target ?? "");
}

function definitionTargetsMatch(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return tokenOverlap(left, right) >= 0.75 && tokenOverlap(right, left) >= 0.5;
}

function batteryIdentifier(value: string): string | undefined {
  return value.match(/\bbattery\s+([a-z0-9-]+)/iu)?.[1];
}

type OrdinaryDefinitionTuple = {
  kind: "define" | "mean" | "refer" | "stand";
  object: ReadonlySet<string>;
  subject: ReadonlySet<string>;
};

function ordinaryDefinitionTuplesArePreserved(
  statement: string,
  supportTexts: readonly string[],
): boolean {
  const claimed = ordinaryDefinitionTuples(statement);
  if (claimed.length === 0) return true;
  const supplied = supportTexts.flatMap(ordinaryDefinitionTuples);
  return claimed.every((claim) =>
    supplied.some(
      (support) =>
        claim.kind === support.kind &&
        tokenOverlap(claim.subject, support.subject) >= 0.6 &&
        tokenOverlap(support.subject, claim.subject) >= 0.5 &&
        tokenOverlap(claim.object, support.object) >= 0.6 &&
        tokenOverlap(support.object, claim.object) >= 0.5,
    ),
  );
}

function ordinaryDefinitionTuples(value: string): OrdinaryDefinitionTuple[] {
  const output: OrdinaryDefinitionTuple[] = [];
  for (const segment of value.split(/(?:[.;\n]+|\bwhile\b|\bwhereas\b)/giu)) {
    if (
      /^\s*[GCIEAU]\s+(?:stands\s+for|means|denotes|represents|is\s+defined\s+as|is)\b/iu.test(
        segment,
      ) ||
      /\b(?:abbreviation|acronym|glossary)\b/iu.test(segment) ||
      /\buses\s+[A-Z][A-Z0-9-]{1,15}\b[^.;]{0,120}\bto\s+mean\b/u.test(segment)
    ) {
      continue;
    }
    const match = segment.match(
      /^\s*(.+?)\s+(defines?|means?|refers?\s+to|stands?\s+for)\s+(.+?)\s*$/iu,
    );
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) continue;
    const subject = materialTokens(match[1]);
    const object = materialTokens(match[3]);
    if (subject.size === 0 || object.size === 0) continue;
    const relation = match[2].toLowerCase();
    output.push({
      kind: relation.startsWith("defin")
        ? "define"
        : relation.startsWith("mean")
          ? "mean"
          : relation.startsWith("refer")
            ? "refer"
            : "stand",
      object,
      subject,
    });
  }
  return output;
}

export function materialTokens(value: string): Set<string> {
  const tokens = lexicalTokens(value).flatMap((token) =>
    token.includes("-") ? [token, ...token.split("-")] : [token],
  );
  return new Set([
    ...tokens
      .map(canonicalSemanticToken)
      .filter(
        (token) =>
          !NON_MATERIAL_TOKENS.has(token) &&
          !NUMBER_WORD_TOKENS.has(token) &&
          !isNumericToken(token) &&
          (token.length >= 4 || SHORT_SEMANTIC_TOKENS.has(token)),
      ),
    ...numericTokens(value),
  ]);
}

export function isNonFactualBoilerplate(value: string): boolean {
  return /^(?:supported|response supported|none|n\/?a|not applicable|no (?:warnings?|missing requirements?|issues?))\.?$/iu.test(
    value.trim(),
  );
}

export function looksLikeEmbeddedInstruction(value: string): boolean {
  return /\b(?:ignore|disregard|override)\b.{0,80}\b(?:instructions?|prompt|rules?)\b|\b(?:reveal|print|return|expose)\b.{0,80}\b(?:system prompt|developer message|private key|secret|credentials?)\b|\b(?:system prompt|developer message)\b|<script\b|\b(?:assistant|system)\s*:/iu.test(
    value,
  );
}

export function semanticDisclosureMatch(secret: string, output: string): boolean {
  const normalizedSecret = normalize(secret);
  const normalizedOutput = normalize(output);
  if (normalizedSecret.length > 0 && normalizedOutput.includes(normalizedSecret)) return true;

  const secretTokens = distinctiveDisclosureTokens(secret);
  const outputTokens = disclosureTokens(output);
  const matching = [...secretTokens].filter((token) => outputTokens.has(token));
  if (matching.length < 2) return false;
  const identifiers = [...secretTokens].filter(isIdentifierToken);
  const identifierMatched = identifiers.some(
    (token) =>
      outputTokens.has(token) ||
      token
        .split("-")
        .filter((part) => part.length > 1)
        .every((part) => outputTokens.has(part)),
  );
  const secretQuantities = quantitativeFacts(secret);
  const outputQuantities = quantitativeFacts(output);
  const quantitativeFactMatched = [...secretQuantities].some((fact) => outputQuantities.has(fact));
  const secretFields = new Set(
    [...DISCLOSURE_FIELD_TOKENS].filter((token) => secretTokens.has(token)),
  );
  const outputFields = new Set(
    [...DISCLOSURE_FIELD_TOKENS].filter((token) => outputTokens.has(token)),
  );
  const fieldMatched = [...secretFields].some((token) => outputFields.has(token));
  const outputNamesAnotherField = secretFields.size > 0 && outputFields.size > 0 && !fieldMatched;
  const secretNumbers = numericTokens(secret);
  const outputNumbers = numericTokens(output);
  const numericValueMatched = [...secretNumbers].some((number) => outputNumbers.has(number));
  const numericValueContradicted =
    secretNumbers.size > 0 && outputNumbers.size > 0 && !numericValueMatched;
  const qualitativeValueMatched = [...DISCLOSURE_VALUE_TOKENS].some(
    (token) => secretTokens.has(token) && outputTokens.has(token),
  );
  if (numericValueContradicted || outputNamesAnotherField) return false;
  if (secretQuantities.size > 0) {
    if (quantitativeFactMatched) {
      return fieldMatched || (identifierMatched && !outputNamesAnotherField);
    }
  }
  if (fieldMatched && (numericValueMatched || qualitativeValueMatched)) return true;
  if (identifierMatched && numericValueMatched) return true;
  const required = Math.max(2, Math.ceil(secretTokens.size * 0.4));
  return matching.length >= required || (identifierMatched && matching.length >= 3);
}

function hasClauseSemanticSupport(clause: string, supportTexts: readonly string[]): boolean {
  const clauseTokens = materialTokens(clause);
  if (clauseTokens.size === 0) return isNonFactualBoilerplate(clause);
  const supportTokens = materialTokens(supportTexts.join(" "));
  return (
    tokenOverlap(clauseTokens, supportTokens) >= 0.5 &&
    numbersArePreserved(clause, supportTexts.join(" ")) &&
    polarityIsPreserved(clause, supportTexts) &&
    incompatibleTermsArePreserved(clause, supportTexts) &&
    accountableAuthorityTermsArePreserved(clause, supportTexts) &&
    circularityRatiosArePreserved(clause, supportTexts) &&
    rankStabilityRelationsArePreserved(clause, supportTexts) &&
    factualRelationsArePreserved(clause, supportTexts)
  );
}

function circularityRatiosArePreserved(
  statement: string,
  supportTexts: readonly string[],
): boolean {
  const claimed = circularityRatios(statement);
  if (claimed.length === 0) return true;
  const supplied = new Set(supportTexts.flatMap(circularityRatios));
  return claimed.every((ratio) => supplied.has(ratio));
}

function circularityRatios(value: string): string[] {
  return [
    ...value.matchAll(
      /\b(?:C|circularity)\s*(?:=|(?:component\s+)?(?:is|has))?\s*([-+]?[0-9]+(?:\.[0-9]+)?)\s*\/\s*([-+]?[0-9]+(?:\.[0-9]+)?)/giu,
    ),
  ].flatMap((match) =>
    match[1] === undefined || match[2] === undefined
      ? []
      : [`${normalizeNumberLiteral(match[1])}/${normalizeNumberLiteral(match[2])}`],
  );
}

function rankStabilityRelationsArePreserved(
  statement: string,
  supportTexts: readonly string[],
): boolean {
  const claimed = rankStabilityValues(statement);
  if (claimed.length === 0) return true;
  const supplied = new Set(supportTexts.flatMap(rankStabilityValues));
  return claimed.every((value) => supplied.has(value));
}

function rankStabilityValues(value: string): boolean[] {
  const output: boolean[] = [];
  const occupied: Array<readonly [number, number]> = [];
  const record = (match: RegExpMatchArray, parsed: boolean): void => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (occupied.some(([left, right]) => start < right && end > left)) return;
    occupied.push([start, end]);
    output.push(parsed);
  };
  for (const match of value.matchAll(/\brank\s+stable\s*=\s*(true|false)\b/giu)) {
    record(match, match[1]?.toLowerCase() === "true");
  }
  for (const match of value.matchAll(/\brank\s+(?:is\s+)?(not\s+)?stable\b(?!\s*=)/giu)) {
    record(match, match[1] === undefined);
  }
  for (const match of value.matchAll(/\b(unstable|stable)\s+rank\b/giu)) {
    record(match, match[1]?.toLowerCase() === "stable");
  }
  for (const match of value.matchAll(/\brank\s+stability\s+(?:is\s+)?(unstable|stable)\b/giu)) {
    record(match, match[1]?.toLowerCase() === "stable");
  }
  return output;
}

type RelationToken = {
  raw: string;
  canonical: string;
};

type QuantitativeRelation = {
  entity: string | null;
  field: string;
  value: string;
  unit: string | null;
};

type StatusRelation = {
  entity: string | null;
  subject: ReadonlySet<string>;
  status: string;
};

/**
 * Preserves the local structure of factual assertions. A union-of-tokens check
 * alone cannot distinguish "capacity 80; mileage 40" from "capacity 40;
 * mileage 80", or determine which route passed. Relations are extracted only
 * when the field or status is explicit, which keeps the check conservative for
 * ordinary paraphrases that do not expose this structure.
 */
function factualRelationsArePreserved(statement: string, supportTexts: readonly string[]): boolean {
  const claimedQuantities = quantitativeRelations(statement);
  const suppliedQuantities = supportTexts.flatMap(quantitativeRelations);
  for (const claim of claimedQuantities) {
    if (!suppliedQuantities.some((support) => quantitativeRelationMatches(claim, support))) {
      return false;
    }
  }

  const claimedStatuses = statusRelations(statement);
  const suppliedStatuses = supportTexts.flatMap(statusRelations);
  for (const claim of claimedStatuses) {
    if (!suppliedStatuses.some((support) => statusRelationMatches(claim, support))) {
      return false;
    }
  }
  return true;
}

function quantitativeRelations(value: string): QuantitativeRelation[] {
  const output: QuantitativeRelation[] = [];
  for (const sentence of relationSentences(value)) {
    const tokens = relationTokens(sentence);
    for (let index = 0; index < tokens.length; index += 1) {
      const parsed = quantityAt(tokens, index);
      if (parsed === null) continue;
      const field = nearestField(tokens, parsed.start, parsed.end);
      if (field === null) {
        index = parsed.end;
        continue;
      }
      output.push({
        entity: explicitEntityBefore(tokens, parsed.start),
        field,
        value: parsed.value,
        unit: parsed.unit,
      });
      index = parsed.end;
    }
  }
  return output;
}

function statusRelations(value: string): StatusRelation[] {
  const output: StatusRelation[] = [];
  for (const sentence of relationSentences(value)) {
    const tokens = relationTokens(sentence);
    for (const [index, token] of tokens.entries()) {
      if (!RELATIONAL_STATUS_TOKENS.has(token.canonical)) continue;
      let segmentStart = index - 1;
      while (segmentStart >= 0 && !RELATION_BOUNDARIES.has(tokens[segmentStart]!.canonical)) {
        segmentStart -= 1;
      }
      const subjectTokens = tokens
        .slice(segmentStart + 1, index)
        .map(({ canonical }) => canonical)
        .filter(
          (candidate) =>
            !RELATION_SUBJECT_STOPWORDS.has(candidate) &&
            !NEGATORS.has(candidate) &&
            !RELATIONAL_STATUS_TOKENS.has(candidate) &&
            candidate !== "route",
        );
      output.push({
        entity: explicitEntityBefore(tokens, index, segmentStart + 1),
        subject: new Set(subjectTokens),
        status: token.canonical,
      });
    }
  }
  return output;
}

function quantitativeRelationMatches(
  claim: QuantitativeRelation,
  support: QuantitativeRelation,
): boolean {
  return (
    claim.field === support.field &&
    claim.value === support.value &&
    unitsAreCompatible(claim.unit, support.unit) &&
    entitiesAreCompatible(claim.entity, support.entity)
  );
}

function statusRelationMatches(claim: StatusRelation, support: StatusRelation): boolean {
  if (claim.status !== support.status || !entitiesAreCompatible(claim.entity, support.entity)) {
    return false;
  }
  if (claim.subject.size === 0 || support.subject.size === 0) return true;
  return (
    tokenOverlap(claim.subject, support.subject) >= 0.5 ||
    tokenOverlap(support.subject, claim.subject) >= 0.5
  );
}

function entitiesAreCompatible(left: string | null, right: string | null): boolean {
  return left === null || right === null || left === right;
}

function unitsAreCompatible(left: string | null, right: string | null): boolean {
  return left === null || right === null || canonicalUnit(left) === canonicalUnit(right);
}

function relationSentences(value: string): string[] {
  return value
    .split(/(?:[!?;]+|(?<![0-9])\.+|\.+(?![0-9])|\n+)/gu)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function relationTokens(value: string): RelationToken[] {
  return (
    value
      .toLowerCase()
      .replaceAll("%", " percent ")
      .match(/(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?|[a-z]+(?:-[a-z0-9]+)*/gu) ?? []
  ).flatMap((raw) => {
    const expanded = raw.includes("-") && !isIdentifierToken(raw) ? raw.split("-") : [raw];
    return expanded.map((part) => ({
      raw: part,
      canonical: canonicalSemanticToken(part),
    }));
  });
}

function quantityAt(
  tokens: readonly RelationToken[],
  index: number,
): { start: number; end: number; value: string; unit: string | null } | null {
  const token = tokens[index];
  if (token === undefined) return null;
  if (isNumericToken(token.raw)) {
    const followingUnit = tokens[index + 1]?.canonical;
    const precedingUnit = tokens[index - 1]?.canonical;
    const unit =
      followingUnit !== undefined && QUANTITY_UNITS.has(followingUnit)
        ? followingUnit
        : precedingUnit !== undefined && QUANTITY_UNITS.has(precedingUnit)
          ? precedingUnit
          : null;
    return {
      start: index,
      end: followingUnit !== undefined && QUANTITY_UNITS.has(followingUnit) ? index + 1 : index,
      value: normalizeNumberLiteral(token.raw),
      unit,
    };
  }
  if (!NUMBER_WORD_TOKENS.has(token.raw)) return null;
  let end = index;
  while (
    end + 1 < tokens.length &&
    (NUMBER_WORD_TOKENS.has(tokens[end + 1]!.raw) || tokens[end + 1]!.raw === "and")
  ) {
    end += 1;
  }
  const values = numberWordValues(
    tokens
      .slice(index, end + 1)
      .map(({ raw }) => raw)
      .join(" "),
  );
  if (values.length !== 1) return null;
  const followingUnit = tokens[end + 1]?.canonical;
  return {
    start: index,
    end: followingUnit !== undefined && QUANTITY_UNITS.has(followingUnit) ? end + 1 : end,
    value: String(values[0]),
    unit: followingUnit !== undefined && QUANTITY_UNITS.has(followingUnit) ? followingUnit : null,
  };
}

function nearestField(
  tokens: readonly RelationToken[],
  quantityStart: number,
  quantityEnd: number,
): string | null {
  for (let index = quantityStart - 1; index >= Math.max(0, quantityStart - 6); index -= 1) {
    const token = tokens[index]!.canonical;
    if (DISCLOSURE_FIELD_TOKENS.has(token)) return token;
    if (RELATION_BOUNDARIES.has(token)) break;
  }
  for (
    let index = quantityEnd + 1;
    index <= Math.min(tokens.length - 1, quantityEnd + 4);
    index += 1
  ) {
    const token = tokens[index]!.canonical;
    if (DISCLOSURE_FIELD_TOKENS.has(token)) return token;
    if (RELATION_BOUNDARIES.has(token)) break;
  }
  return null;
}

function explicitEntityBefore(
  tokens: readonly RelationToken[],
  index: number,
  lowerBound = 0,
): string | null {
  let entity: string | null = null;
  for (let cursor = lowerBound; cursor < index; cursor += 1) {
    const token = tokens[cursor]!;
    const next = tokens[cursor + 1];
    if (
      token.canonical === "battery" &&
      next !== undefined &&
      !["has", "is", "module", "pack", "record", "state"].includes(next.canonical)
    ) {
      entity = `battery:${next.canonical}`;
      continue;
    }
    if (isIdentifierToken(token.canonical) && !isNumericToken(token.canonical)) {
      entity = `id:${token.canonical}`;
    }
  }
  return entity;
}

function canonicalUnit(value: string): string {
  const aliases: Readonly<Record<string, string>> = {
    "%": "percent",
    percentage: "percent",
    mile: "miles",
    cycle: "cycles",
    year: "years",
    day: "days",
    hour: "hours",
  };
  return aliases[value] ?? value;
}

/**
 * Separates an asserted fact from a conclusion appended with an inference
 * connector. Each resulting assertion must be supported independently. This
 * prevents a supported measurement from lending lexical cover to an unrelated
 * conclusion, while leaving ordinary coordinated phrases intact.
 */
function factualClauses(value: string): string[] {
  return value
    .split(
      /(?:[!?;]+|(?<![0-9])\.+|\.+(?![0-9])|,\s*(?:so|therefore|thus|hence|consequently)\b|\b(?:but|however)\b|(?<!not\s)\byet\b|\band\s+(?=(?:(?:it|they|this|that|the\s+[a-z0-9-]+|[a-z0-9-]+)\s+)?(?:is|are|was|were|has|have|had|can|could|will|would|must|may|should|confirm(?:s|ed)?|report(?:s|ed)?|record(?:s|ed)?|include(?:s|d)?|indicat(?:e|es|ed)|show(?:s|ed)?|establish(?:es|ed)?|prov(?:e|es|ed))\b)|\b(?:therefore|thus|hence|consequently|which means|meaning that|thereby|indicat(?:e|es|ed|ing)|show(?:s|ed|ing)?|prov(?:e|es|ed|ing)|demonstrat(?:e|es|ed|ing)|establish(?:es|ed|ing)?)\b)/giu,
    )
    .map((clause) => clause.trim())
    .filter((clause) => /[\p{L}\p{N}]/u.test(clause));
}

function tokenOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / left.size;
}

function numbersArePreserved(statement: string, support: string): boolean {
  const supportNumbers = numericTokens(support);
  return [...numericTokens(statement)].every((number) => supportNumbers.has(number));
}

function polarityIsPreserved(statement: string, supportTexts: readonly string[]): boolean {
  const statementPolarity = polarityByConcept(statement);
  const supportPolarities = supportTexts.map(polarityByConcept);
  for (const [concept, isNegated] of statementPolarity) {
    const matching = supportPolarities.flatMap((polarities) =>
      polarities.has(concept) ? [polarities.get(concept)!] : [],
    );
    if (matching.length > 0 && !matching.includes(isNegated)) return false;
  }
  return true;
}

function incompatibleTermsArePreserved(
  statement: string,
  supportTexts: readonly string[],
): boolean {
  const statementTokens = materialTokens(statement);
  const supportTokens = materialTokens(supportTexts.join(" "));
  for (const group of INCOMPATIBLE_TERM_GROUPS) {
    const stated = group.filter((term) => statementTokens.has(term));
    if (stated.length === 0) continue;
    const supplied = group.filter((term) => supportTokens.has(term));
    if (supplied.length > 0 && !stated.some((term) => supplied.includes(term))) return false;
  }
  return true;
}

function accountableAuthorityTermsArePreserved(
  statement: string,
  supportTexts: readonly string[],
): boolean {
  const stated = materialTokens(statement);
  const supplied = materialTokens(supportTexts.join(" "));
  return [...ACCOUNTABLE_AUTHORITY_TOKENS].every(
    (token) => !stated.has(token) || supplied.has(token),
  );
}

function polarityByConcept(value: string): Map<string, boolean> {
  const words = lexicalTokens(value).flatMap((word) =>
    word.includes("-") ? word.split("-") : [word],
  );
  const output = new Map<string, boolean>();
  for (const [index, word] of words.entries()) {
    const concept = canonicalSemanticToken(word);
    if (!materialTokens(concept).has(concept) || NEGATORS.has(word)) continue;
    const preceding = words.slice(Math.max(0, index - 3), index);
    output.set(
      concept,
      preceding.some((candidate) => NEGATORS.has(candidate)),
    );
  }
  return output;
}

function numericTokens(value: string): Set<string> {
  const output = new Set<string>();
  for (const match of value.matchAll(
    /(?<![a-z0-9-])[-+]?(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?%?(?![a-z0-9-])/giu,
  )) {
    if (match[0] === undefined) continue;
    const undecorated = match[0].replace(/^[-+]/u, "").replaceAll(",", "").replace(/%$/u, "");
    if (/^0[0-9]+$/u.test(undecorated)) continue;
    output.add(normalizeNumberLiteral(match[0]));
  }
  for (const number of numberWordValues(value)) output.add(String(number));
  return output;
}

function normalizeNumberLiteral(value: string): string {
  const withoutDecoration = value.replaceAll(",", "").replace(/%$/u, "").replace(/^\+/u, "");
  const negative = withoutDecoration.startsWith("-");
  const unsigned = negative ? withoutDecoration.slice(1) : withoutDecoration;
  const [integerPart = "0", fractionPart] = unsigned.split(".");
  const integer = integerPart.replace(/^0+(?=[0-9])/u, "") || "0";
  const fraction = fractionPart?.replace(/0+$/u, "") ?? "";
  const magnitude = fraction.length > 0 ? `${integer}.${fraction}` : integer;
  return negative && magnitude !== "0" ? `-${magnitude}` : magnitude;
}

function numberWordValues(value: string): number[] {
  const units: Readonly<Record<string, number>> = {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
  };
  const tens: Readonly<Record<string, number>> = {
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  };
  const words =
    expandContractions(value)
      .replaceAll("-", " ")
      .match(/[a-z]+/gu) ?? [];
  const output: number[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const unit = units[word];
    const ten = tens[word];
    if (unit !== undefined && words[index + 1] === "hundred") {
      let result = unit * 100;
      index += 1;
      if (words[index + 1] === "and") index += 1;
      const trailingTen = tens[words[index + 1] ?? ""];
      const trailingUnit = units[words[index + 1] ?? ""];
      if (trailingTen !== undefined) {
        result += trailingTen;
        index += 1;
        const lastUnit = units[words[index + 1] ?? ""];
        if (lastUnit !== undefined && lastUnit < 10) {
          result += lastUnit;
          index += 1;
        }
      } else if (trailingUnit !== undefined) {
        result += trailingUnit;
        index += 1;
      }
      output.push(result);
      continue;
    }
    if (ten !== undefined) {
      let result = ten;
      const trailingUnit = units[words[index + 1] ?? ""];
      if (trailingUnit !== undefined && trailingUnit < 10) {
        result += trailingUnit;
        index += 1;
      }
      output.push(result);
      continue;
    }
    if (unit !== undefined) output.push(unit);
  }
  return output;
}

function quantitativeFacts(value: string): Set<string> {
  const output = new Set<string>();
  for (const match of value.matchAll(
    /(?<![a-z0-9-])([-+]?(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?)\s*(%|percent(?:age)?|kg|g|mg|kwh|wh|km|miles?|eur|usd|cycles?|years?|days?|hours?)(?![a-z0-9-])/giu,
  )) {
    if (match[1] === undefined || match[2] === undefined) continue;
    const unit = /^(?:%|percent|percentage)$/iu.test(match[2]) ? "percent" : match[2].toLowerCase();
    output.add(`${normalizeNumberLiteral(match[1])}|${unit}`);
  }
  return output;
}

function distinctiveDisclosureTokens(value: string): Set<string> {
  const generic = new Set([
    "synthetic",
    "predefined",
    "record",
    "records",
    "fact",
    "facts",
    "current",
    "battery",
    "state",
    "history",
  ]);
  const expanded = disclosureLexicalTokens(value);
  return new Set(
    expanded.filter(
      (token) =>
        !generic.has(token) &&
        (token.length >= 4 ||
          SHORT_SEMANTIC_TOKENS.has(token) ||
          isNumericToken(token) ||
          isIdentifierToken(token)),
    ),
  );
}

function disclosureTokens(value: string): Set<string> {
  return new Set(disclosureLexicalTokens(value));
}

function disclosureLexicalTokens(value: string): string[] {
  return lexicalTokens(value)
    .flatMap((token) => (token.includes("-") ? [token, ...token.split("-")] : [token]))
    .map(canonicalSemanticToken);
}

function isIdentifierToken(value: string): boolean {
  return (/[a-z]/iu.test(value) && /[0-9]/u.test(value)) || value.startsWith("urn:");
}

function isNumericToken(value: string): boolean {
  return /^(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?$/u.test(value);
}

function canonicalSemanticToken(value: string): string {
  const aliases: Readonly<Record<string, string>> = {
    accepted: "accept",
    accreditation: "accredit",
    accredited: "accredit",
    allowed: "allow",
    approval: "approve",
    approved: "approve",
    c: "circularity",
    certification: "certify",
    certified: "certify",
    compliant: "comply",
    compliance: "comply",
    conflicts: "conflict",
    legally: "legal",
    recommended: "preferred",
    recommendation: "preferred",
    failed: "fail",
    failing: "fail",
    fails: "fail",
    passed: "pass",
    passes: "pass",
    rejected: "reject",
    rejection: "reject",
    selected: "preferred",
    resell: "resale",
    resold: "resale",
    sold: "resale",
    sale: "resale",
    soh: "health",
    forbids: "forbid",
    forbidden: "forbid",
    permitted: "permit",
    permits: "permit",
    verified: "verify",
    verifies: "verify",
    verification: "verify",
    verifier: "verify",
  };
  return aliases[value] ?? value;
}

function lexicalTokens(value: string): string[] {
  return expandContractions(value).match(/[a-z0-9]+(?:-[a-z0-9]+)*/gu) ?? [];
}

function expandContractions(value: string): string {
  return value
    .toLowerCase()
    .replace(
      /\b(?:isn|aren|wasn|weren|doesn|don|didn|couldn|won|wouldn|shouldn|mustn)'t\b/gu,
      " not",
    )
    .replace(/\bcan['’]?t\b/gu, "cannot")
    .replace(
      /\b(?:isn|aren|wasn|weren|doesn|don|didn|couldn|won|wouldn|shouldn|mustn)t\b/gu,
      " not",
    );
}

function normalize(value: string): string {
  return lexicalTokens(value).join(" ");
}
