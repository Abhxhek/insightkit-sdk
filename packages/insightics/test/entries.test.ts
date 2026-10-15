import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Manifest {
  readonly exports: Readonly<Record<string, { readonly default: string }>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly bin: Readonly<Record<string, string>>;
}

const ROOT = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as Manifest;

type Loader = () => Promise<Record<string, unknown>>;

const PAIRS: Readonly<Record<string, readonly [Loader, Loader]>> = {
  './server': [() => import('../src/server.js'), () => import('insightics-server')],
  './react': [() => import('../src/react.js'), () => import('insightics-react')],
  './core': [() => import('../src/core.js'), () => import('insightics-core')],
  './core/pg': [() => import('../src/core-pg.js'), () => import('insightics-core/pg')],
  './sql-guard': [() => import('../src/sql-guard.js'), () => import('insightics-sql-guard')],
  './protocol': [() => import('../src/protocol.js'), () => import('insightics-protocol')],
  './llm': [() => import('../src/llm.js'), () => import('insightics-llm')],
  './llm/anthropic': [() => import('../src/llm-anthropic.js'), () => import('insightics-llm/anthropic')],
  './llm/openai': [() => import('../src/llm-openai.js'), () => import('insightics-llm/openai')],
};

const packageFor = (subpath: string): string => `insightics-${subpath.slice(2)}`;
const sourceFor = (subpath: string): URL => new URL(`src/${subpath.slice(2).replace('/', '-')}.ts`, ROOT);

describe('the umbrella package', () => {
  it('has no root entry, so one import can never mix browser and server code', () => {
    expect(Object.keys(manifest.exports)).not.toContain('.');
  });

  it('declares exactly the entries this test checks', () => {
    expect(Object.keys(manifest.exports).sort()).toEqual(Object.keys(PAIRS).sort());
  });

  it('gives every library package an entry', () => {
    for (const dependency of Object.keys(manifest.dependencies)) {
      if (dependency === 'insightics-cli') continue;
      expect(manifest.exports, dependency).toHaveProperty(`./${dependency.slice('insightics-'.length)}`);
    }
  });

  it('does nothing in an entry but re-export the one package it names', () => {
    for (const subpath of Object.keys(manifest.exports)) {
      expect(readFileSync(sourceFor(subpath), 'utf8').trim(), subpath).toBe(
        `export * from '${packageFor(subpath)}';`,
      );
    }
  });

  it('exposes the very same bindings as the package underneath', async () => {
    for (const [subpath, [umbrella, underlying]] of Object.entries(PAIRS)) {
      const [ours, theirs] = await Promise.all([umbrella(), underlying()]);
      expect(Object.keys(ours).sort(), subpath).toEqual(Object.keys(theirs).sort());
      for (const name of Object.keys(theirs)) expect(ours[name], `${subpath} ${name}`).toBe(theirs[name]);
    }
  });

  it('ships the ik command', () => {
    expect(manifest.bin).toEqual({ ik: './dist/bin.js' });
    expect(readFileSync(new URL('src/bin.ts', ROOT), 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });
});
