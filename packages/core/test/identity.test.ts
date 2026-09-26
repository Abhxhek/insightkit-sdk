import { Buffer } from 'node:buffer';
import type { Guard } from '@insightkit/sql-guard';
import { createGuard } from '@insightkit/sql-guard';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { approve } from '../src/approve.js';
import { runGuardedRead, sessionPreamble } from '../src/execute.js';
import { isIdentityError } from '../src/identity/errors.js';
import { createScopeResolver } from '../src/identity/resolve.js';
import type { ScopeConfig } from '../src/identity/scope.js';
import { tenantScope } from '../src/identity/scope.js';
import type { TokenVerifierConfig } from '../src/identity/verify.js';
import { createTokenVerifier } from '../src/identity/verify.js';
import { asReaderSource } from '../src/source.js';
import type { GuardedQuery, QueryOutcome, SqlClient } from '../src/types.js';

const SECRET = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const secretKey = new TextEncoder().encode(SECRET);

const HS: TokenVerifierConfig = { key: { kind: 'secret', secret: SECRET }, algorithms: ['HS256'] };
const SCOPE: ScopeConfig = { tenantClaim: 'tid' };

const sign = (claims: Record<string, unknown>, key: Uint8Array = secretKey, alg = 'HS256'): Promise<string> =>
  new SignJWT(claims).setProtectedHeader({ alg }).setIssuedAt().setExpirationTime('5m').sign(key);

const failure = async (fn: () => Promise<unknown> | unknown): Promise<[string, string]> => {
  try {
    await fn();
  } catch (err) {
    if (isIdentityError(err)) return [err.code, err.failure];
    throw err;
  }
  throw new Error('expected an IdentityError, nothing was thrown');
};

let rsa: Awaited<ReturnType<typeof generateKeyPair>>;
let spki: string;

beforeAll(async () => {
  rsa = await generateKeyPair('RS256', { extractable: true });
  spki = await exportSPKI(rsa.publicKey);
});

describe('token verification', () => {
  it('verifies a valid token and returns its claims', async () => {
    const verify = await createTokenVerifier(HS);
    const result = await verify(await sign({ tid: 'acme', sub: 'u1' }));
    expect(result.claims.tid).toBe('acme');
    expect(result.subject).toBe('u1');
    expect(result.algorithm).toBe('HS256');
    expect(result.expiresAt).toBeGreaterThan(0);
  });

  it('rejects a token signed with a different key', async () => {
    const verify = await createTokenVerifier(HS);
    const token = await sign({ tid: 'acme' }, new TextEncoder().encode(OTHER));
    expect(await failure(() => verify(token))).toEqual(['E_TOKEN_SIGNATURE', 'authentication']);
  });

  it('rejects an expired token', async () => {
    const verify = await createTokenVerifier(HS);
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ tid: 'acme' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 3600)
      .sign(secretKey);
    expect(await failure(() => verify(token))).toEqual(['E_TOKEN_EXPIRED', 'authentication']);
  });

  it('rejects a token that carries no exp at all, which jose accepts by default', async () => {
    const verify = await createTokenVerifier(HS);
    const token = await new SignJWT({ tid: 'acme' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .sign(secretKey);
    expect(await failure(() => verify(token))).toEqual(['E_TOKEN_CLAIM', 'authentication']);
  });

  it('rejects an unsecured alg: none token', async () => {
    const verify = await createTokenVerifier(HS);
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${b64({ alg: 'none' })}.${b64({ tid: 'acme', exp: 2 ** 31 })}.`;
    expect(await failure(() => verify(token))).toEqual(['E_TOKEN_ALG', 'authentication']);
  });

  it('rejects an HS256 token signed with the RSA public key against an RS256 verifier', async () => {
    const verify = await createTokenVerifier({ key: { kind: 'publicKey', spki }, algorithms: ['RS256'] });
    const forged = await sign({ tid: 'acme' }, new TextEncoder().encode(spki));
    expect(await failure(() => verify(forged))).toEqual(['E_TOKEN_ALG', 'authentication']);
  });

  it('rejects an algorithm off the allowlist even when the signature is good', async () => {
    const verify = await createTokenVerifier(HS);
    const token = await sign({ tid: 'acme' }, secretKey, 'HS512');
    expect(await failure(() => verify(token))).toEqual(['E_TOKEN_ALG', 'authentication']);
  });

  it('enforces issuer and audience when they are configured', async () => {
    const verify = await createTokenVerifier({ ...HS, issuer: 'https://id.test', audience: 'insightkit' });
    const good = await sign({ tid: 'acme', iss: 'https://id.test', aud: 'insightkit' });
    const badIssuer = await sign({ tid: 'acme', iss: 'https://evil.test', aud: 'insightkit' });
    const badAudience = await sign({ tid: 'acme', iss: 'https://id.test', aud: 'other' });
    await expect(verify(good)).resolves.toBeDefined();
    expect(await failure(() => verify(badIssuer))).toEqual(['E_TOKEN_CLAIM', 'authentication']);
    expect(await failure(() => verify(badAudience))).toEqual(['E_TOKEN_CLAIM', 'authentication']);
  });

  it('rejects something that is not a token at all', async () => {
    const verify = await createTokenVerifier(HS);
    expect(await failure(() => verify('not-a-jwt'))).toEqual(['E_TOKEN_MALFORMED', 'authentication']);
    expect(await failure(() => verify(''))).toEqual(['E_TOKEN_MALFORMED', 'authentication']);
  });

  it('rejects an oversized token before doing any crypto', async () => {
    const verify = await createTokenVerifier(HS);
    expect(await failure(() => verify('x'.repeat(9000)))).toEqual(['E_TOKEN_MALFORMED', 'authentication']);
  });

  it('verifies against an RSA public key', async () => {
    const verify = await createTokenVerifier({ key: { kind: 'publicKey', spki }, algorithms: ['RS256'] });
    const token = await new SignJWT({ tid: 'acme' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(rsa.privateKey);
    expect((await verify(token)).claims.tid).toBe('acme');
  });
});

describe('verifier configuration', () => {
  it('refuses an empty algorithm allowlist', async () => {
    expect(await failure(() => createTokenVerifier({ ...HS, algorithms: [] }))).toEqual([
      'E_CONFIG',
      'configuration',
    ]);
  });

  it('refuses an algorithm it does not support, including none', async () => {
    const algorithms = ['none'] as unknown as TokenVerifierConfig['algorithms'];
    expect(await failure(() => createTokenVerifier({ ...HS, algorithms }))).toEqual([
      'E_CONFIG',
      'configuration',
    ]);
  });

  it('refuses a shared secret short enough to brute force, which jose does not', async () => {
    const key = { kind: 'secret', secret: 'hunter2' } as const;
    expect(await failure(() => createTokenVerifier({ ...HS, key }))).toEqual(['E_CONFIG', 'configuration']);
  });

  it('refuses a jwks endpoint that is not https', async () => {
    const key = { kind: 'jwks', url: 'http://id.test/.well-known/jwks.json' } as const;
    expect(await failure(() => createTokenVerifier({ ...HS, key }))).toEqual(['E_CONFIG', 'configuration']);
  });

  it('refuses a public key with more than one algorithm, since the import fixes the hash', async () => {
    const key = { kind: 'publicKey', spki } as const;
    expect(await failure(() => createTokenVerifier({ key, algorithms: ['RS256', 'RS384'] }))).toEqual([
      'E_CONFIG',
      'configuration',
    ]);
  });

  it('refuses key material that is not a PEM', async () => {
    const key = { kind: 'publicKey', spki: 'not a pem' } as const;
    expect(await failure(() => createTokenVerifier({ key, algorithms: ['RS256'] }))).toEqual([
      'E_CONFIG',
      'configuration',
    ]);
  });
});

describe('claims to tenant scope', () => {
  it('carries the configured claim into app.tenant_id', () => {
    const scope = tenantScope({ tid: 'acme' }, SCOPE);
    expect(scope.tenantId).toBe('acme');
    expect(scope.settings).toEqual([{ name: 'app.tenant_id', value: 'acme' }]);
  });

  it('is a hard failure when the tenant claim is missing, never an empty scope', () => {
    expect(failureOf(() => tenantScope({ sub: 'u1' }, SCOPE))).toEqual([
      'E_TENANT_CLAIM_MISSING',
      'authorization',
    ]);
  });

  it('is a hard failure when the tenant claim is present but empty', () => {
    expect(failureOf(() => tenantScope({ tid: '' }, SCOPE))[0]).toBe('E_TENANT_CLAIM_MISSING');
    expect(failureOf(() => tenantScope({ tid: null }, SCOPE))[0]).toBe('E_TENANT_CLAIM_MISSING');
  });

  it('refuses a tenant claim that is not a string or an integer', () => {
    for (const tid of [true, { id: 1 }, ['a'], 1.5]) {
      expect(failureOf(() => tenantScope({ tid }, SCOPE))[0]).toBe('E_TENANT_CLAIM_MISSING');
    }
  });

  it('accepts an integer tenant id and carries it as text', () => {
    expect(tenantScope({ tid: 42 }, SCOPE).settings[0]?.value).toBe('42');
  });

  it('carries extra claims into extra settings', () => {
    const scope = tenantScope(
      { tid: 'acme', uid: 'u1' },
      { ...SCOPE, extra: [{ setting: 'app.user_id', claim: 'uid' }] },
    );
    expect(scope.settings.map((s) => s.name)).toEqual(['app.tenant_id', 'app.user_id']);
    expect(scope.tenantId).toBe('acme');
  });

  it('fails when an extra claim is absent rather than skipping it', () => {
    expect(
      failureOf(() =>
        tenantScope({ tid: 'acme' }, { ...SCOPE, extra: [{ setting: 'app.user_id', claim: 'uid' }] }),
      )[0],
    ).toBe('E_TENANT_CLAIM_MISSING');
  });

  it('refuses to map the same setting twice', () => {
    expect(
      failureOf(() =>
        tenantScope({ tid: 'acme' }, { ...SCOPE, extra: [{ setting: 'app.tenant_id', claim: 'tid' }] }),
      )[0],
    ).toBe('E_CONFIG');
  });

  it('refuses an unsafe setting name rather than escaping it', () => {
    for (const tenantSetting of ["app.x = 'y'; SET ROLE postgres; --", 'app.tenant id', 'a.b.c', 'app."x"']) {
      expect(failureOf(() => tenantScope({ tid: 'acme' }, { ...SCOPE, tenantSetting }))).toEqual([
        'E_SETTING_NAME_UNSAFE',
        'configuration',
      ]);
    }
  });

  it('refuses an unprefixed setting name, so row_security cannot be targeted', () => {
    for (const tenantSetting of ['row_security', 'search_path', 'statement_timeout']) {
      expect(failureOf(() => tenantScope({ tid: 'acme' }, { ...SCOPE, tenantSetting }))[0]).toBe(
        'E_SETTING_NAME_UNSAFE',
      );
    }
  });

  it('refuses an upper case setting name, which postgres would fold', () => {
    expect(failureOf(() => tenantScope({ tid: 'a' }, { ...SCOPE, tenantSetting: 'app.TenantId' }))[0]).toBe(
      'E_SETTING_NAME_UNSAFE',
    );
  });

  it('refuses a value it cannot represent rather than escaping harder', () => {
    const bad = ['back\\slash', 'line\nbreak', 'nul\u0000byte', ' padded', 'padded ', 'x'.repeat(257)];
    for (const tid of bad) {
      expect(failureOf(() => tenantScope({ tid }, SCOPE))).toEqual([
        'E_TENANT_VALUE_UNSAFE',
        'authorization',
      ]);
    }
  });

  it('keeps a value containing a quote and lets the escaper handle it', () => {
    expect(tenantScope({ tid: "o'brien" }, SCOPE).settings[0]?.value).toBe("o'brien");
  });
});

describe('the scope inside the session preamble', () => {
  const scopeOf = (value: string, name = 'app.tenant_id'): readonly string[] =>
    sessionPreamble({ scope: [{ name, value }] });

  it('emits every statement as SET LOCAL, never a bare SET', () => {
    const statements = scopeOf('acme');
    expect(statements.filter((s) => s.startsWith('SET')).length).toBe(statements.length);
    for (const s of statements) expect(s).toMatch(/^SET LOCAL /);
  });

  it('cannot be broken out of by a quote in the tenant id', () => {
    const statement = scopeOf("t1'; SET ROLE postgres; --").at(-1);
    expect(statement).toBe("SET LOCAL app.tenant_id = 't1''; SET ROLE postgres; --'");
    expect(statement).toMatch(/^SET LOCAL /);
  });

  it('puts the scope after row security and the search path, before the query', () => {
    const statements = scopeOf('acme');
    const scope = statements.findIndex((s) => s.includes('app.tenant_id'));
    expect(scope).toBeGreaterThan(statements.indexOf('SET LOCAL row_security = on'));
    expect(scope).toBeGreaterThan(statements.findIndex((s) => s.includes('search_path')));
    expect(scope).toBe(statements.length - 1);
  });

  it('refuses a hand-built setting that never went through tenantScope', () => {
    expect(() => scopeOf('acme', "x = 'y'; SET ROLE postgres")).toThrow(/prefix\.name/);
    expect(() => scopeOf('acme', 'row_security')).toThrow(/prefix\.name/);
    expect(() => scopeOf('back\\slash')).toThrow(/backslash/);
  });

  it('refuses the same setting twice, where the last would silently win', () => {
    expect(() =>
      sessionPreamble({
        scope: [
          { name: 'app.tenant_id', value: 'acme' },
          { name: 'app.tenant_id', value: 'evil' },
        ],
      }),
    ).toThrow(/more than once/);
  });

  it('changes nothing when no scope is passed', () => {
    expect(sessionPreamble({ scope: [] })).toEqual(sessionPreamble());
  });
});

describe('the scope inside the sealed transaction', () => {
  const READ_ONLY_ON: QueryOutcome = { fields: [{ name: 'transaction_read_only' }], rows: [['on']] };
  const EMPTY: QueryOutcome = { fields: [], rows: [] };

  let guard: Guard;
  let query: GuardedQuery;

  beforeAll(async () => {
    guard = await createGuard({ maxRows: 1000 });
    const approval = approve(guard, 'SELECT id FROM users');
    if (!approval.ok) throw new Error('fixture query should be approved');
    query = approval.query;
  });

  it('emits the scope inside the transaction and before the query, and still rolls back', async () => {
    const log: string[] = [];
    const client: SqlClient = {
      async query(text) {
        log.push(text);
        return text === 'SHOW transaction_read_only' ? READ_ONLY_ON : EMPTY;
      },
      release() {},
    };
    const source = asReaderSource({ connect: async () => client });
    const { settings } = tenantScope({ tid: 'acme' }, SCOPE);

    await runGuardedRead(source, query, { scope: settings });

    const scope = log.indexOf("SET LOCAL app.tenant_id = 'acme'");
    expect(log[0]).toBe('BEGIN READ ONLY');
    expect(scope).toBeGreaterThan(0);
    expect(scope).toBeLessThan(log.indexOf(query.sql));
    expect(log.at(-1)).toBe('ROLLBACK');
    expect(log.some((s) => /commit/i.test(s))).toBe(false);
    for (const s of log.filter((t) => t.startsWith('SET'))) expect(s).toMatch(/^SET LOCAL /);
  });
});

describe('token to scope', () => {
  it('turns a verified token into session settings', async () => {
    const resolve = await createScopeResolver({ token: HS, scope: SCOPE });
    const scope = await resolve(await sign({ tid: 'acme' }));
    expect(scope.settings).toEqual([{ name: 'app.tenant_id', value: 'acme' }]);
  });

  it('produces no scope at all when the token does not verify', async () => {
    const resolve = await createScopeResolver({ token: HS, scope: SCOPE });
    const token = await sign({ tid: 'acme' }, new TextEncoder().encode(OTHER));
    expect(await failure(() => resolve(token))).toEqual(['E_TOKEN_SIGNATURE', 'authentication']);
  });

  it('produces no scope when the token verifies but carries no tenant', async () => {
    const resolve = await createScopeResolver({ token: HS, scope: SCOPE });
    const token = await sign({ sub: 'u1' });
    expect(await failure(() => resolve(token))).toEqual(['E_TENANT_CLAIM_MISSING', 'authorization']);
  });
});

function failureOf(fn: () => unknown): [string, string] {
  try {
    fn();
  } catch (err) {
    if (isIdentityError(err)) return [err.code, err.failure];
    throw err;
  }
  throw new Error('expected an IdentityError, nothing was thrown');
}
