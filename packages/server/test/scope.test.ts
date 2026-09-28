import { IdentityError, sessionPreamble } from '@insightkit/core';
import { describe, expect, it } from 'vitest';
import { createInsightKit } from '../src/insightkit.js';
import { isReadScope, runScopedRead, tenantReadScope, unscopedReadScope } from '../src/scope.js';
import type { InsightKitConfig } from '../src/types.js';
import { SINGLE_TENANT_ACKNOWLEDGEMENT } from '../src/types.js';
import {
  askRequest,
  draft,
  fakeDatabase,
  fakeGuard,
  fakeProvider,
  fakeResolver,
  SCHEMA,
  scopeFor,
  singleTenantConfig,
  TENANT,
} from './fake.js';

const multiConfig = (
  over: Partial<InsightKitConfig> = {},
  tokens: Readonly<Record<string, ReturnType<typeof scopeFor> | Error>> = { good: scopeFor(TENANT) },
  script: readonly unknown[] = [draft()],
): {
  config: InsightKitConfig;
  database: ReturnType<typeof fakeDatabase>;
  model: ReturnType<typeof fakeProvider>;
} => {
  const database = fakeDatabase();
  const model = fakeProvider(script);
  return {
    database,
    model,
    config: {
      source: database.source,
      guard: fakeGuard(),
      provider: model.provider,
      schema: SCHEMA,
      tenancy: { mode: 'multi', resolve: fakeResolver(tokens) },
      ...over,
    },
  };
};

describe('an unscoped read cannot happen by accident', () => {
  it('refuses a configuration with no tenancy at all', () => {
    const base = singleTenantConfig();
    const { tenancy: _dropped, ...rest } = base;
    expect(() => createInsightKit(rest as InsightKitConfig)).toThrow(/tenancy is required/);
  });

  it('refuses a single-tenant declaration that does not say the words', () => {
    expect(() =>
      createInsightKit(singleTenantConfig({ tenancy: { mode: 'single', acknowledge: 'sure' } as never })),
    ).toThrow(/acknowledgement/);
  });

  it('refuses a scope object that was not minted here', async () => {
    const database = fakeDatabase();
    const fake = { settings: [], identity: 'nobody', unscoped: true };
    await expect(runScopedRead(database.source, { sql: 'SELECT 1' } as never, fake as never)).rejects.toThrow(
      /scope produced by/,
    );
  });

  it('refuses an empty scope that was not declared', () => {
    expect(() => tenantReadScope({ tenantId: 'acme', settings: [] })).toThrow(/refusing to read unscoped/);
  });

  it('mints an unscoped scope only for the exact acknowledgement', () => {
    expect(isReadScope(unscopedReadScope(SINGLE_TENANT_ACKNOWLEDGEMENT, 'host'))).toBe(true);
    expect(() => unscopedReadScope('every user may read every row', 'host')).toThrow();
  });

  it('runs no query at all when a multi-tenant request carries no token', async () => {
    const { config, database, model } = multiConfig();
    const ik = createInsightKit(config);

    const response = await ik.ask(askRequest('how many users'));

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(database.statements).toEqual([]);
    expect(model.seen).toEqual([]);
  });

  it('sets the tenant setting inside the sealed transaction for a verified token', async () => {
    const { config, database } = multiConfig();
    const ik = createInsightKit(config);

    const response = await ik.ask(askRequest('how many users', 'good'));

    expect(response.status).toBe(200);
    expect(database.statements).toContain("SET LOCAL app.tenant_id = 'acme'");
    expect(database.statements[0]).toBe('BEGIN READ ONLY');
    expect(database.statements.at(-1)).toBe('ROLLBACK');
    expect(database.statements).not.toContain('COMMIT');
  });

  it('runs with no scope statement for a host that declared single-tenant mode', async () => {
    const database = fakeDatabase();
    const ik = createInsightKit(singleTenantConfig({}, { database }));

    const response = await ik.ask(askRequest('how many users'));

    expect(response.status).toBe(200);
    const preamble = database.statements.filter((s) => s.startsWith('SET LOCAL'));
    expect(preamble).toEqual(sessionPreamble().filter((s) => s.startsWith('SET LOCAL')));
    expect(preamble.some((s) => s.includes('tenant'))).toBe(false);
    expect(preamble).toContain('SET LOCAL row_security = on');
  });
});

describe('mapping an identity failure to a status', () => {
  it('answers 401 for an expired token and runs nothing', async () => {
    const { config, database } = multiConfig(
      {},
      {
        stale: new IdentityError('E_TOKEN_EXPIRED', 'token rejected: "exp" claim timestamp check failed'),
      },
    );
    const ik = createInsightKit(config);

    const response = await ik.ask(askRequest('how many users', 'stale'));

    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain('E_TOKEN_EXPIRED');
    expect(database.statements).toEqual([]);
  });

  it('answers 401 for a signature that does not verify', async () => {
    const { config } = multiConfig();
    const ik = createInsightKit(config);
    expect((await ik.ask(askRequest('how many users', 'forged'))).status).toBe(401);
  });

  it('answers 403 for a verified token with no tenant claim', async () => {
    const { config, database } = multiConfig(
      {},
      {
        anonymous: new IdentityError('E_TENANT_CLAIM_MISSING', 'claim "org" is missing or unusable (absent)'),
      },
    );
    const ik = createInsightKit(config);

    const response = await ik.ask(askRequest('how many users', 'anonymous'));

    expect(response.status).toBe(403);
    expect(database.statements).toEqual([]);
  });

  it('answers 500 for a misconfigured setting name, never a read', async () => {
    const { config, database } = multiConfig(
      {},
      {
        broken: new IdentityError('E_SETTING_NAME_UNSAFE', 'unsafe session setting name: row_security'),
      },
    );
    const ik = createInsightKit(config);

    const response = await ik.ask(askRequest('how many users', 'broken'));

    expect(response.status).toBe(500);
    expect(database.statements).toEqual([]);
  });
});
