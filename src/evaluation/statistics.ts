export interface Interval {
  readonly lower: number;
  readonly upper: number;
}

export interface BootstrapEffect extends Interval {
  readonly estimate: number;
  readonly p_value: number;
}

export interface BootstrapEstimate extends Interval {
  readonly estimate: number;
}

export function wilsonInterval(successes: number, total: number, z = 1.959963984540054): Interval {
  if (
    !Number.isInteger(successes) ||
    !Number.isInteger(total) ||
    successes < 0 ||
    total <= 0 ||
    successes > total
  )
    throw new Error("Invalid Wilson interval counts");
  const proportion = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (proportion + z2 / (2 * total)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((proportion * (1 - proportion)) / total + z2 / (4 * total * total));
  return {
    lower: successes === 0 ? 0 : Math.max(0, center - margin),
    upper: successes === total ? 1 : Math.min(1, center + margin),
  };
}

export function pairedBootstrapMeanDifference(
  pairs: ReadonlyArray<readonly [number, number]>,
  iterations = 10_000,
  seed = 0x45564c4c,
): BootstrapEffect {
  if (pairs.length === 0 || iterations < 100) throw new Error("Insufficient bootstrap input");
  const differences = pairs.map(([left, right]) => left - right);
  const estimate = mean(differences);
  const random = xorshift32(seed);
  const samples = new Array<number>(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < differences.length; index += 1) {
      total += differences[Math.floor(random() * differences.length)]!;
    }
    const value = total / differences.length;
    samples[iteration] = value;
  }
  samples.sort((left, right) => left - right);
  return {
    estimate,
    lower: percentileSorted(samples, 0.025),
    upper: percentileSorted(samples, 0.975),
    p_value: pairedRandomizationPValue(pairs, mean, iterations, seed ^ 0x9e3779b9),
  };
}

export function pairedBootstrapStatisticDifference<T>(
  pairs: ReadonlyArray<readonly [T, T]>,
  statistic: (values: readonly T[]) => number,
  iterations = 10_000,
  seed = 0x45564c4c,
): BootstrapEffect {
  if (pairs.length === 0 || iterations < 100) throw new Error("Insufficient bootstrap input");
  const left = pairs.map(([value]) => value);
  const right = pairs.map(([, value]) => value);
  const estimate = statistic(left) - statistic(right);
  const random = xorshift32(seed);
  const samples = new Array<number>(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampledLeft = new Array<T>(pairs.length);
    const sampledRight = new Array<T>(pairs.length);
    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[Math.floor(random() * pairs.length)]!;
      sampledLeft[index] = pair[0];
      sampledRight[index] = pair[1];
    }
    const value = statistic(sampledLeft) - statistic(sampledRight);
    samples[iteration] = value;
  }
  samples.sort((leftValue, rightValue) => leftValue - rightValue);
  return {
    estimate,
    lower: percentileSorted(samples, 0.025),
    upper: percentileSorted(samples, 0.975),
    p_value: pairedRandomizationPValue(pairs, statistic, iterations, seed ^ 0x9e3779b9),
  };
}

export function clusteredBootstrapMean(
  clusters: ReadonlyArray<readonly number[]>,
  iterations = 10_000,
  seed = 0x45564c4c,
): BootstrapEstimate {
  return clusteredBootstrapStatistic(clusters, mean, iterations, seed);
}

export function clusteredBootstrapStatistic<T>(
  clusters: ReadonlyArray<readonly T[]>,
  statistic: (values: readonly T[]) => number,
  iterations = 10_000,
  seed = 0x45564c4c,
): BootstrapEstimate {
  validateClusters(clusters, iterations);
  const estimate = statistic(clusters.flat());
  const random = xorshift32(seed);
  const samples = new Array<number>(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampled: T[] = [];
    for (let index = 0; index < clusters.length; index += 1) {
      sampled.push(...clusters[Math.floor(random() * clusters.length)]!);
    }
    samples[iteration] = statistic(sampled);
  }
  samples.sort((left, right) => left - right);
  return {
    estimate,
    lower: percentileSorted(samples, 0.025),
    upper: percentileSorted(samples, 0.975),
  };
}

export function pairedClusterBootstrapMeanDifference(
  clusters: ReadonlyArray<readonly [readonly number[], readonly number[]]>,
  iterations = 10_000,
  seed = 0x45564c4c,
): BootstrapEffect {
  return pairedClusterBootstrapStatisticDifference(clusters, mean, iterations, seed);
}

export function pairedClusterBootstrapStatisticDifference<T>(
  clusters: ReadonlyArray<readonly [readonly T[], readonly T[]]>,
  statistic: (values: readonly T[]) => number,
  iterations = 10_000,
  seed = 0x45564c4c,
): BootstrapEffect {
  validatePairedClusters(clusters, iterations);
  const left = clusters.flatMap(([values]) => values);
  const right = clusters.flatMap(([, values]) => values);
  const estimate = statistic(left) - statistic(right);
  const random = xorshift32(seed);
  const samples = new Array<number>(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampledLeft: T[] = [];
    const sampledRight: T[] = [];
    for (let index = 0; index < clusters.length; index += 1) {
      const [leftCluster, rightCluster] = clusters[Math.floor(random() * clusters.length)]!;
      sampledLeft.push(...leftCluster);
      sampledRight.push(...rightCluster);
    }
    const value = statistic(sampledLeft) - statistic(sampledRight);
    samples[iteration] = value;
  }
  samples.sort((leftValue, rightValue) => leftValue - rightValue);
  return {
    estimate,
    lower: percentileSorted(samples, 0.025),
    upper: percentileSorted(samples, 0.975),
    p_value: pairedClusterRandomizationPValue(clusters, statistic, iterations, seed ^ 0x9e3779b9),
  };
}

export function holmAdjust(values: readonly number[]): number[] {
  const ordered = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value);
  const adjusted = new Array<number>(values.length);
  let running = 0;
  for (const [rank, item] of ordered.entries()) {
    running = Math.max(running, Math.min(1, item.value * (values.length - rank)));
    adjusted[item.index] = running;
  }
  return adjusted;
}

export function quantiles(values: readonly number[]): {
  median: number;
  p50: number;
  p95: number;
  q1: number;
  q3: number;
  iqr: number;
} {
  if (values.length === 0) throw new Error("Cannot summarize an empty sample");
  const sorted = [...values].sort((left, right) => left - right);
  const q1 = percentileSorted(sorted, 0.25);
  const median = percentileSorted(sorted, 0.5);
  const q3 = percentileSorted(sorted, 0.75);
  return {
    median,
    p50: median,
    p95: percentileSorted(sorted, 0.95),
    q1,
    q3,
    iqr: q3 - q1,
  };
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Cannot average an empty sample");
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function validateClusters<T>(clusters: ReadonlyArray<readonly T[]>, iterations: number): void {
  if (clusters.length === 0 || clusters.some((cluster) => cluster.length === 0) || iterations < 100)
    throw new Error("Insufficient clustered bootstrap input");
}

function validatePairedClusters<T>(
  clusters: ReadonlyArray<readonly [readonly T[], readonly T[]]>,
  iterations: number,
): void {
  if (
    clusters.length === 0 ||
    clusters.some(
      ([left, right]) => left.length === 0 || right.length === 0 || left.length !== right.length,
    ) ||
    iterations < 100
  )
    throw new Error("Insufficient paired clustered bootstrap input");
}

function percentileSorted(values: readonly number[], probability: number): number {
  const position = (values.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower]!;
  const weight = position - lower;
  return values[lower]! * (1 - weight) + values[upper]! * weight;
}

function pairedRandomizationPValue<T>(
  pairs: ReadonlyArray<readonly [T, T]>,
  statistic: (values: readonly T[]) => number,
  iterations: number,
  seed: number,
): number {
  const observed = Math.abs(
    statistic(pairs.map(([left]) => left)) - statistic(pairs.map(([, right]) => right)),
  );
  if (observed === 0) return 1;
  if (pairs.length <= 16) {
    return exactPairedRandomizationPValue(pairs, statistic, observed);
  }
  const random = xorshift32(seed);
  let asOrMoreExtreme = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const left: T[] = [];
    const right: T[] = [];
    for (const pair of pairs) {
      const swap = random() < 0.5;
      left.push(pair[swap ? 1 : 0]);
      right.push(pair[swap ? 0 : 1]);
    }
    if (Math.abs(statistic(left) - statistic(right)) >= observed - Number.EPSILON) {
      asOrMoreExtreme += 1;
    }
  }
  return (asOrMoreExtreme + 1) / (iterations + 1);
}

function pairedClusterRandomizationPValue<T>(
  clusters: ReadonlyArray<readonly [readonly T[], readonly T[]]>,
  statistic: (values: readonly T[]) => number,
  iterations: number,
  seed: number,
): number {
  const observed = Math.abs(
    statistic(clusters.flatMap(([left]) => left)) -
      statistic(clusters.flatMap(([, right]) => right)),
  );
  if (observed === 0) return 1;
  if (clusters.length <= 16) {
    return exactPairedClusterRandomizationPValue(clusters, statistic, observed);
  }
  const random = xorshift32(seed);
  let asOrMoreExtreme = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const left: T[] = [];
    const right: T[] = [];
    for (const [leftCluster, rightCluster] of clusters) {
      if (random() < 0.5) {
        left.push(...leftCluster);
        right.push(...rightCluster);
      } else {
        left.push(...rightCluster);
        right.push(...leftCluster);
      }
    }
    if (Math.abs(statistic(left) - statistic(right)) >= observed - Number.EPSILON) {
      asOrMoreExtreme += 1;
    }
  }
  return (asOrMoreExtreme + 1) / (iterations + 1);
}

function exactPairedRandomizationPValue<T>(
  pairs: ReadonlyArray<readonly [T, T]>,
  statistic: (values: readonly T[]) => number,
  observed: number,
): number {
  const assignmentCount = 2 ** pairs.length;
  let asOrMoreExtreme = 0;
  for (let assignment = 0; assignment < assignmentCount; assignment += 1) {
    const left: T[] = [];
    const right: T[] = [];
    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[index]!;
      const swap = (assignment & (2 ** index)) !== 0;
      left.push(pair[swap ? 1 : 0]);
      right.push(pair[swap ? 0 : 1]);
    }
    if (Math.abs(statistic(left) - statistic(right)) >= observed - Number.EPSILON) {
      asOrMoreExtreme += 1;
    }
  }
  return asOrMoreExtreme / assignmentCount;
}

function exactPairedClusterRandomizationPValue<T>(
  clusters: ReadonlyArray<readonly [readonly T[], readonly T[]]>,
  statistic: (values: readonly T[]) => number,
  observed: number,
): number {
  const assignmentCount = 2 ** clusters.length;
  let asOrMoreExtreme = 0;
  for (let assignment = 0; assignment < assignmentCount; assignment += 1) {
    const left: T[] = [];
    const right: T[] = [];
    for (let index = 0; index < clusters.length; index += 1) {
      const [leftCluster, rightCluster] = clusters[index]!;
      if ((assignment & (2 ** index)) === 0) {
        left.push(...leftCluster);
        right.push(...rightCluster);
      } else {
        left.push(...rightCluster);
        right.push(...leftCluster);
      }
    }
    if (Math.abs(statistic(left) - statistic(right)) >= observed - Number.EPSILON) {
      asOrMoreExtreme += 1;
    }
  }
  return asOrMoreExtreme / assignmentCount;
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}
