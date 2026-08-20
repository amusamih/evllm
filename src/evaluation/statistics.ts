export interface Interval {
  readonly lower: number;
  readonly upper: number;
}

export interface BootstrapEffect extends Interval {
  readonly estimate: number;
  readonly p_value: number;
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
  let nonPositive = 0;
  let nonNegative = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < differences.length; index += 1) {
      total += differences[Math.floor(random() * differences.length)]!;
    }
    const value = total / differences.length;
    samples[iteration] = value;
    if (value <= 0) nonPositive += 1;
    if (value >= 0) nonNegative += 1;
  }
  samples.sort((left, right) => left - right);
  return {
    estimate,
    lower: percentileSorted(samples, 0.025),
    upper: percentileSorted(samples, 0.975),
    p_value: Math.min(1, (2 * (Math.min(nonPositive, nonNegative) + 1)) / (iterations + 1)),
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
  let nonPositive = 0;
  let nonNegative = 0;
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
    if (value <= 0) nonPositive += 1;
    if (value >= 0) nonNegative += 1;
  }
  samples.sort((leftValue, rightValue) => leftValue - rightValue);
  return {
    estimate,
    lower: percentileSorted(samples, 0.025),
    upper: percentileSorted(samples, 0.975),
    p_value: Math.min(1, (2 * (Math.min(nonPositive, nonNegative) + 1)) / (iterations + 1)),
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

function percentileSorted(values: readonly number[], probability: number): number {
  const position = (values.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower]!;
  const weight = position - lower;
  return values[lower]! * (1 - weight) + values[upper]! * weight;
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
