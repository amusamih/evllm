export interface ReadinessCheck {
  readonly name: string;
  readonly probe: () => Promise<void>;
}

export interface ReadinessResult {
  readonly checks: readonly {
    readonly name: string;
    readonly status: "ready" | "unavailable";
  }[];
  readonly status: "ready" | "unavailable";
}

const defaultProbeTimeoutMs = 5_000;

export async function evaluateReadiness(
  checks: readonly ReadinessCheck[],
  timeoutMs = defaultProbeTimeoutMs,
): Promise<ReadinessResult> {
  const results = await Promise.allSettled(
    checks.map(async (check) => probeWithin(check, timeoutMs)),
  );
  const evaluated = checks.map((check, index) => ({
    name: check.name,
    status: results[index]?.status === "fulfilled" ? ("ready" as const) : ("unavailable" as const),
  }));
  const ready = evaluated.every((check) => check.status === "ready");

  return {
    checks: evaluated,
    status: ready ? "ready" : "unavailable",
  };
}

async function probeWithin(check: ReadinessCheck, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${check.name} readiness probe timed out.`)),
      timeoutMs,
    );
  });

  try {
    await Promise.race([check.probe(), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
