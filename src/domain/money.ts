/**
 * Money in this system is ALWAYS an integer number of cents.
 *
 * Floating point is not allowed anywhere near an amount: 0.1 + 0.2 !== 0.3,
 * and a ledger that loses a cent loses the trust of the people using it.
 * $12.34 is stored, passed around and calculated as 1234.
 *
 * The same discipline applies to anything else that could tempt us into
 * decimals — percentages, weights — which is why the helpers here are about
 * whole numbers in general, not only about cents.
 */

/** Fails if the value is not a whole, non-negative number of cents. */
export function assertAmountCents(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer number of cents, got ${value}`);
  }
  if (value < 0) {
    throw new Error(`${label} cannot be negative, got ${value}`);
  }
}

/** Fails if the value is not a whole number greater than zero. */
export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer, got ${value}`);
  }
  if (value <= 0) {
    throw new Error(`${label} must be greater than zero, got ${value}`);
  }
}

/** Adds up whole numbers. Exact, because nothing here is a decimal. */
export function sumIntegers(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
