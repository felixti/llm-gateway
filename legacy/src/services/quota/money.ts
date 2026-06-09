import { Decimal } from 'decimal.js';

export const MICRODOLLAR_SCALE = 1_000_000;

export function toMicrodollars(d: Decimal): string {
  return d.mul(MICRODOLLAR_SCALE).round().toString();
}

export function fromMicrodollars(s: string): Decimal {
  return new Decimal(s).div(MICRODOLLAR_SCALE);
}
