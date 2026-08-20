const DECIMAL_PATTERN = /^(?:0|-?(?:[1-9][0-9]*)(?:\.[0-9]*[1-9])?|-?0\.[0-9]*[1-9])$/u;

export class ExactDecimalError extends Error {
  public constructor(public readonly code: "divide-by-zero" | "invalid" | "overflow") {
    super("Exact decimal operation failed");
    this.name = "ExactDecimalError";
  }
}

export class ExactDecimal {
  private constructor(
    private readonly coefficient: bigint,
    private readonly scale: number,
  ) {}

  public static parse(value: string): ExactDecimal {
    if (!DECIMAL_PATTERN.test(value)) throw new ExactDecimalError("invalid");
    const negative = value.startsWith("-");
    const unsigned = negative ? value.slice(1) : value;
    const [integer = "0", fraction = ""] = unsigned.split(".");
    if (`${integer}${fraction}`.replace(/^0+/u, "").length > 38 || fraction.length > 18) {
      throw new ExactDecimalError("overflow");
    }
    const coefficient = BigInt(`${integer}${fraction}`) * (negative ? -1n : 1n);
    return ExactDecimal.create(coefficient, fraction.length);
  }

  public static fromInteger(value: bigint | number): ExactDecimal {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new ExactDecimalError("invalid");
    }
    return ExactDecimal.create(BigInt(value), 0);
  }

  public add(other: ExactDecimal): ExactDecimal {
    const scale = Math.max(this.scale, other.scale);
    return ExactDecimal.create(
      this.coefficient * power10(scale - this.scale) +
        other.coefficient * power10(scale - other.scale),
      scale,
    );
  }

  public subtract(other: ExactDecimal): ExactDecimal {
    return this.add(ExactDecimal.create(-other.coefficient, other.scale));
  }

  public multiply(other: ExactDecimal): ExactDecimal {
    return ExactDecimal.create(this.coefficient * other.coefficient, this.scale + other.scale);
  }

  public divide(other: ExactDecimal, outputScale = 18): ExactDecimal {
    if (other.coefficient === 0n) throw new ExactDecimalError("divide-by-zero");
    if (!Number.isSafeInteger(outputScale) || outputScale < 0 || outputScale > 18) {
      throw new ExactDecimalError("invalid");
    }
    const exponent = outputScale + other.scale - this.scale;
    const numerator = exponent >= 0 ? this.coefficient * power10(exponent) : this.coefficient;
    const denominator = exponent >= 0 ? other.coefficient : other.coefficient * power10(-exponent);
    return ExactDecimal.create(roundHalfEven(numerator, denominator), outputScale);
  }

  public round(outputScale: number): ExactDecimal {
    if (!Number.isSafeInteger(outputScale) || outputScale < 0 || outputScale > 18) {
      throw new ExactDecimalError("invalid");
    }
    if (outputScale >= this.scale) return this;
    return ExactDecimal.create(
      roundHalfEven(this.coefficient, power10(this.scale - outputScale)),
      outputScale,
    );
  }

  public compare(other: ExactDecimal): number {
    const difference = this.subtract(other).coefficient;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }

  public toCanonical(): string {
    if (this.coefficient === 0n) return "0";
    const negative = this.coefficient < 0n;
    const digits = (negative ? -this.coefficient : this.coefficient)
      .toString()
      .padStart(this.scale + 1, "0");
    const integer = this.scale === 0 ? digits : digits.slice(0, -this.scale);
    const fraction = this.scale === 0 ? "" : digits.slice(-this.scale).replace(/0+$/u, "");
    return `${negative ? "-" : ""}${integer}${fraction.length === 0 ? "" : `.${fraction}`}`;
  }

  private static create(coefficient: bigint, scale: number): ExactDecimal {
    let normalized = coefficient;
    let normalizedScale = scale;
    while (normalizedScale > 0 && normalized % 10n === 0n) {
      normalized /= 10n;
      normalizedScale -= 1;
    }
    const digits = (normalized < 0n ? -normalized : normalized).toString().length;
    if (digits > 80) throw new ExactDecimalError("overflow");
    return new ExactDecimal(normalized, normalizedScale);
  }
}

function power10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  const denominatorMagnitude = denominator < 0n ? -denominator : denominator;
  const signedNumerator = denominator < 0n ? -numerator : numerator;
  const quotient = signedNumerator / denominatorMagnitude;
  const remainder = signedNumerator % denominatorMagnitude;
  const remainderMagnitude = remainder < 0n ? -remainder : remainder;
  const doubled = remainderMagnitude * 2n;
  if (doubled < denominatorMagnitude) return quotient;
  const direction = signedNumerator < 0n ? -1n : 1n;
  if (doubled > denominatorMagnitude) return quotient + direction;
  return quotient % 2n === 0n ? quotient : quotient + direction;
}
