export interface LinearScale {
  readonly min: number;
  readonly max: number;
  readonly ticks: readonly number[];
}

const niceStep = (rough: number): number => {
  const power = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / power;
  if (normalised <= 1) return power;
  if (normalised <= 2) return 2 * power;
  if (normalised <= 5) return 5 * power;
  return 10 * power;
};

export const linearScale = (
  values: readonly number[],
  options: { readonly includeZero: boolean; readonly tickCount?: number },
): LinearScale => {
  const target = options.tickCount ?? 5;
  let low = options.includeZero ? 0 : Number.POSITIVE_INFINITY;
  let high = options.includeZero ? 0 : Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return { min: 0, max: 1, ticks: [0, 1] };
  if (low === high) {
    if (low === 0) return { min: 0, max: 1, ticks: [0, 0.5, 1] };
    const pad = Math.abs(low) * 0.5;
    low = Math.min(low, low - pad);
    high = Math.max(high, high + pad);
  }
  const step = niceStep((high - low) / target);
  const min = Math.floor(low / step) * step;
  const max = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  const count = Math.round((max - min) / step);
  for (let i = 0; i <= count; i += 1) ticks.push(Number((min + i * step).toPrecision(12)));
  return { min, max, ticks };
};

export const project = (value: number, scale: LinearScale, from: number, to: number): number => {
  const span = scale.max - scale.min;
  if (span === 0) return from;
  return from + ((value - scale.min) / span) * (to - from);
};

export const round = (value: number): number => Math.round(value * 100) / 100;

/** 4px rounded data-end, square at the baseline. A plain `rx` would round all four corners. */
export const horizontalBarPath = (x0: number, x1: number, y: number, height: number): string => {
  const r = Math.max(0, Math.min(4, height / 2, Math.abs(x1 - x0)));
  const a = round(x0);
  const b = round(x1);
  const c = round(y);
  const d = round(y + height);
  if (r === 0) return `M${a},${c}H${b}V${d}H${a}Z`;
  const sweep = b >= a ? 1 : 0;
  const tip = b >= a ? b - r : b + r;
  return `M${a},${c}H${round(tip)}A${r},${r} 0 0 ${sweep} ${b},${round(c + r)}V${round(d - r)}A${r},${r} 0 0 ${sweep} ${round(tip)},${d}H${a}Z`;
};
