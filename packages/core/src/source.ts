import type { AdminSource, ConnectionSource, ReaderSource } from './types.js';
import { ADMIN_BRAND, READER_BRAND } from './types.js';

const wrap = (source: ConnectionSource, brand: symbol): ConnectionSource => {
  const sealed = { connect: () => source.connect() };
  Object.defineProperty(sealed, brand, { value: true, enumerable: false });
  return sealed;
};

export function asReaderSource(source: ConnectionSource): ReaderSource {
  return wrap(source, READER_BRAND) as ReaderSource;
}

export function asAdminSource(source: ConnectionSource): AdminSource {
  return wrap(source, ADMIN_BRAND) as AdminSource;
}

const branded = (value: unknown, brand: symbol): boolean =>
  typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[brand] === true;

export const isReaderSource = (value: unknown): value is ReaderSource => branded(value, READER_BRAND);
export const isAdminSource = (value: unknown): value is AdminSource => branded(value, ADMIN_BRAND);
