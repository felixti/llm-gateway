export const MICRODOLLAR_SCALE = 1_000_000;

const USD_PATTERN = /^\d+(\.\d{1,6})?$/;

export function toMicrodollars(usd: string): bigint {
  const trimmed = usd.trim();
  if (!USD_PATTERN.test(trimmed)) {
    throw new Error(`invalid USD amount: ${usd}`);
  }

  const [whole, frac = ''] = trimmed.split('.');
  const microFrac = (frac + '000000').slice(0, 6);
  return BigInt(whole!) * BigInt(MICRODOLLAR_SCALE) + BigInt(microFrac);
}

export function fromMicrodollars(micro: bigint): string {
  const sign = micro < 0n ? '-' : '';
  const abs = micro < 0n ? -micro : micro;
  const whole = abs / BigInt(MICRODOLLAR_SCALE);
  const frac = abs % BigInt(MICRODOLLAR_SCALE);
  return `${sign}${whole}.${frac.toString().padStart(6, '0')}`;
}

export function multiplyMicro(micro: bigint, factor: number): bigint {
  if (factor <= 0) return 0n;
  const scaled = Math.round(factor * 1_000);
  return (micro * BigInt(scaled) + 999n) / 1_000n;
}
