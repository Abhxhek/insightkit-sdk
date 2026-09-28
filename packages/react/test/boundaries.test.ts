import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const files = walk(SRC).filter((path) => path.endsWith('.ts') || path.endsWith('.tsx'));

const IMPORT = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

const specifiersOf = (source: string): string[] => {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT)) if (match[1] !== undefined) found.push(match[1]);
  return found;
};

describe('the browser package stays in the browser', () => {
  it('has source to check', () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it('imports no @insightkit package but protocol', () => {
    for (const path of files) {
      for (const specifier of specifiersOf(readFileSync(path, 'utf8'))) {
        if (specifier.startsWith('@insightkit/')) {
          expect(`${path}: ${specifier}`).toBe(`${path}: @insightkit/protocol`);
        }
      }
    }
  });

  it('never names core, cli or server anywhere in its source', () => {
    for (const path of files) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toContain('@insightkit/core');
      expect(source).not.toContain('@insightkit/cli');
      expect(source).not.toContain('@insightkit/server');
    }
  });

  it('reaches for no Node builtin and no database driver', () => {
    for (const path of files) {
      for (const specifier of specifiersOf(readFileSync(path, 'utf8'))) {
        expect(specifier.startsWith('node:')).toBe(false);
        expect(['fs', 'net', 'http', 'https', 'child_process', 'tls', 'dns', 'pg']).not.toContain(specifier);
      }
    }
  });

  it('never bypasses React escaping', () => {
    for (const path of files) {
      expect(readFileSync(path, 'utf8')).not.toContain('dangerouslySetInnerHTML');
    }
  });
});
