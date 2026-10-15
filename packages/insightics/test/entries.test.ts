import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Manifest {
  readonly private?: boolean;
  readonly exports: Readonly<Record<string, { readonly default: string }>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly bin?: Readonly<Record<string, string>>;
}

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = join(ROOT, 'dist');
const PARTS = ['sql-guard', 'protocol', 'core', 'llm', 'server', 'react', 'cli'] as const;

const manifestAt = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
const manifest = manifestAt(ROOT);
const partManifest = (part: string): Manifest => manifestAt(join(ROOT, '..', part));

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const modulesIn = (dir: string): string[] =>
  walk(dir).filter((file) => file.endsWith('.js') || file.endsWith('.d.ts'));

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
const specifiersIn = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(IMPORT)].map((match) => match[1] ?? '');

type Loader = () => Promise<Record<string, unknown>>;

const PAIRS: Readonly<Record<string, readonly [Loader, Loader]>> = {
  './server': [() => import('../dist/server/index.js'), () => import('insightics-server')],
  './react': [() => import('../dist/react/index.js'), () => import('insightics-react')],
  './core': [() => import('../dist/core/index.js'), () => import('insightics-core')],
  './core/pg': [() => import('../dist/core/pg.js'), () => import('insightics-core/pg')],
  './sql-guard': [() => import('../dist/sql-guard/index.js'), () => import('insightics-sql-guard')],
  './protocol': [() => import('../dist/protocol/index.js'), () => import('insightics-protocol')],
  './llm': [() => import('../dist/llm/index.js'), () => import('insightics-llm')],
  './llm/anthropic': [() => import('../dist/llm/anthropic.js'), () => import('insightics-llm/anthropic')],
  './llm/openai': [() => import('../dist/llm/openai.js'), () => import('insightics-llm/openai')],
};

describe('insightics, the one published package', () => {
  it('has no root entry, so one import can never mix browser and server code', () => {
    expect(Object.keys(manifest.exports)).not.toContain('.');
  });

  it('declares exactly the entries this test checks', () => {
    expect(Object.keys(manifest.exports).sort()).toEqual(Object.keys(PAIRS).sort());
  });

  it('gives every part an entry, and the CLI the ik command', () => {
    for (const part of PARTS) {
      if (part !== 'cli') expect(manifest.exports, part).toHaveProperty(`./${part}`);
    }
    expect(manifest.bin).toEqual({ ik: './dist/cli/bin.js' });
    expect(readFileSync(join(DIST, 'cli', 'bin.js'), 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('is the only package that can be published', () => {
    expect(manifest.private).toBeUndefined();
    for (const part of PARTS) expect(partManifest(part).private, part).toBe(true);
  });

  it('depends on no part, and carries every dependency and peer the parts declare', () => {
    expect(Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith('insightics'))).toEqual(
      [],
    );
    for (const part of PARTS) {
      const own = partManifest(part);
      for (const [name, range] of Object.entries(own.dependencies ?? {})) {
        if (!name.startsWith('insightics-'))
          expect(manifest.dependencies?.[name], `${part} needs ${name}`).toBe(range);
      }
      for (const [name, range] of Object.entries(own.peerDependencies ?? {})) {
        expect(manifest.peerDependencies?.[name], `${part} peers on ${name}`).toBe(range);
      }
    }
  });

  it('ships no import of a separately installed part', () => {
    for (const file of modulesIn(DIST)) {
      for (const specifier of specifiersIn(file)) {
        expect(specifier.startsWith('insightics-'), `${file}: ${specifier}`).toBe(false);
      }
    }
  });

  it('keeps the browser entry away from anything holding connection material or a model key', () => {
    const allowed = [join(DIST, 'react') + sep, join(DIST, 'protocol') + sep];
    for (const file of modulesIn(join(DIST, 'react'))) {
      for (const specifier of specifiersIn(file)) {
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier);
          expect(
            allowed.some((dir) => target.startsWith(dir)),
            `${file}: ${specifier}`,
          ).toBe(true);
        } else {
          expect(/^(node:|pg$|pg\/)/.test(specifier), `${file}: ${specifier}`).toBe(false);
        }
      }
    }
  });

  it('exposes the same names as the part it packs', async () => {
    for (const [subpath, [packed, part]] of Object.entries(PAIRS)) {
      const [ours, theirs] = await Promise.all([packed(), part()]);
      expect(Object.keys(ours).sort(), subpath).toEqual(Object.keys(theirs).sort());
    }
  });
});
