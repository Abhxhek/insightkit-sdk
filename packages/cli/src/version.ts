import { readFileSync } from 'node:fs';

const FALLBACK = '0.0.0';
const NAMES: ReadonlySet<string> = new Set(['insightics-cli', 'insightics']);

// One level up from src/ and from this package's dist/; two levels up once the build has
// packed this package into insightics as dist/cli/.
const CANDIDATES = ['../package.json', '../../package.json'];

const read = (candidate: string): { name?: unknown; version?: unknown } | null => {
  try {
    return JSON.parse(readFileSync(new URL(candidate, import.meta.url), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
  } catch {
    return null;
  }
};

export function version(): string {
  for (const candidate of CANDIDATES) {
    const parsed = read(candidate);
    if (typeof parsed?.name === 'string' && NAMES.has(parsed.name) && typeof parsed.version === 'string') {
      return parsed.version;
    }
  }
  return FALLBACK;
}
