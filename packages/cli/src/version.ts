import { readFileSync } from 'node:fs';

const FALLBACK = '0.0.0';

// '../package.json' resolves the same from src/ under vitest and from dist/ when installed.
export function version(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const declared = (parsed as { version?: unknown }).version;
    return typeof declared === 'string' ? declared : FALLBACK;
  } catch {
    return FALLBACK;
  }
}
