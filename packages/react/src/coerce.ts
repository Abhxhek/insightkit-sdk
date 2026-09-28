import type { Cell } from '@insightkit/protocol';

/**
 * Decimal or scientific notation only: `Number` would also accept `0x1f`, `0b1`, `Infinity`
 * and whitespace, none of which Postgres emits for a numeric column.
 */
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** No UTC offset on purpose: `2026-01-01T00:00+05:30` sorts before `2025-12-31T23:00Z` lexically. */
const ISOISH = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?$/;

export const toNumber = (cell: Cell): number | null => {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
  if (typeof cell !== 'string') return null;
  const text = cell.trim();
  if (!NUMERIC.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

export const isNumericText = (cell: Cell): boolean => toNumber(cell) !== null;

export const isIsoish = (text: string): boolean => ISOISH.test(text);

export const toLabel = (cell: Cell): string => {
  if (cell === null) return '—';
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
  return JSON.stringify(cell) ?? '—';
};

export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });

export const formatNumber = (value: number): string =>
  Math.abs(value) >= 1_000_000 ? compact.format(value) : plain.format(value);

/** A 30-digit `numeric` does not survive a double, so the exact text Postgres sent is shown instead. */
export const formatValue = (cell: Cell): string => {
  const value = toNumber(cell);
  if (value === null) return toLabel(cell);
  if (typeof cell === 'string' && Number(cell.trim()).toString() !== cell.trim()) return cell.trim();
  return formatNumber(value);
};

/** 12px system sans, averaged over mixed-case text. Used only to decide whether a label fits. */
export const estimateTextWidth = (text: string, size: number): number => text.length * size * 0.56;
