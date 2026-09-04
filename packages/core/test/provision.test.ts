import { describe, expect, it } from 'vitest';
import type { ProvisionConfig } from '../src/provision.js';
import { provisioningScript } from '../src/provision.js';

const CONFIG: ProvisionConfig = {
  database: 'app_production',
  analyticsSchema: 'public',
  appOwner: 'app_owner',
  readerRole: 'ik_reader',
  loginRole: 'ik_sdk',
  metaRole: 'ik_meta',
  metadataSchema: 'insightkit',
  connectionLimit: 10,
  validUntil: '2027-01-01',
};

const all = (c: ProvisionConfig = CONFIG): string => {
  const s = provisioningScript(c);
  return [...s.scoped, ...s.clusterWide].join('\n');
};

describe('provisioningScript', () => {
  it('never puts a password in a script that gets printed', () => {
    expect(all()).not.toMatch(/PASSWORD/i);
  });

  it('separates the statements that affect roles other than ours', () => {
    const s = provisioningScript(CONFIG);
    expect(s.clusterWide.every((t) => /PUBLIC/.test(t))).toBe(true);
    expect(s.scoped.some((t) => /FROM PUBLIC/.test(t) && !/insightkit/.test(t))).toBe(false);
  });

  it('strips every attribute that would defeat the other layers, on all three roles', () => {
    const text = all();
    for (const role of ['"ik_reader"', '"ik_sdk"', '"ik_meta"']) {
      expect(text).toContain(
        `ALTER ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
    }
  });

  it('grants the reader select and nothing else', () => {
    const grants = provisioningScript(CONFIG).scoped.filter(
      (t) => t.startsWith('GRANT') && t.includes('ik_reader'),
    );
    for (const g of grants) expect(g).toMatch(/GRANT (SELECT|USAGE|CONNECT)/);
    expect(grants.some((g) => /INSERT|UPDATE|DELETE|ALL PRIVILEGES/.test(g))).toBe(false);
  });

  it('keeps the reader out of the metadata schema', () => {
    expect(all()).toContain('REVOKE ALL ON SCHEMA "insightkit" FROM "ik_reader"');
  });

  it('covers tables created after provisioning', () => {
    expect(all()).toMatch(/ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner".*GRANT SELECT ON TABLES/);
  });

  it('revokes execute on routines rather than only functions', () => {
    expect(all()).toContain('REVOKE EXECUTE ON ALL ROUTINES');
  });

  it('quotes every identifier it interpolates', () => {
    const text = all({ ...CONFIG, analyticsSchema: 'reporting' });
    expect(text).toContain('"reporting"');
  });

  it('refuses an identifier that is not a plain identifier', () => {
    expect(() => provisioningScript({ ...CONFIG, analyticsSchema: 'public"; DROP TABLE users --' })).toThrow(
      /plain SQL identifier/,
    );
    expect(() => provisioningScript({ ...CONFIG, database: 'a b' })).toThrow(/plain SQL identifier/);
  });

  it('refuses a nonsensical connection limit or expiry', () => {
    expect(() => provisioningScript({ ...CONFIG, connectionLimit: 0 })).toThrow(/connectionLimit/);
    expect(() => provisioningScript({ ...CONFIG, validUntil: 'soon' })).toThrow(/validUntil/);
  });
});
