import type {
  ColumnInfo,
  ConnectionSource,
  DatabaseSchema,
  ModelCompletion,
  ModelProvider,
  ModelRequest,
  QueryOutcome,
  ReaderSource,
  ScopeResolver,
  SqlClient,
  TableInfo,
  TenantScope,
} from '@insightkit/core';
import { asReaderSource, IdentityError } from '@insightkit/core';
import type { Guard, InsightKitConfig } from '../src/types.js';
import { SINGLE_TENANT_ACKNOWLEDGEMENT } from '../src/types.js';

const col = (name: string, dataType = 'text'): ColumnInfo => ({
  name,
  dataType,
  typeOid: 25,
  nullable: true,
  comment: null,
});

export const USERS: TableInfo = {
  schema: 'public',
  name: 'users',
  kind: 'table',
  comment: 'people who signed up',
  estimatedRows: 1200,
  primaryKey: ['id'],
  columns: [col('id', 'bigint'), col('email'), col('signup_method'), col('created_at', 'timestamptz')],
};

export const SCHEMA: DatabaseSchema = {
  observedAs: 'ik_reader',
  tables: [USERS],
  foreignKeys: [],
  truncated: false,
};

export const GOOD_SQL =
  'SELECT signup_method AS method, count(*) AS signups FROM users GROUP BY signup_method';

export const draft = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  answerable: true,
  reason: null,
  sql: GOOD_SQL,
  chart_kind: 'bar',
  chart_x: 'method',
  chart_y: ['signups'],
  chart_series: null,
  chart_title: 'Signups by method',
  ...over,
});

const USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

export interface FakeProvider {
  readonly provider: ModelProvider;
  readonly seen: readonly ModelRequest[];
}

export function fakeProvider(script: readonly unknown[]): FakeProvider {
  const seen: ModelRequest[] = [];
  let i = 0;
  const provider: ModelProvider = {
    id: 'fake',
    model: 'fake-1',
    async complete(request: ModelRequest): Promise<ModelCompletion> {
      seen.push(request);
      const next = script[i];
      i += 1;
      if (next === undefined) throw new Error('the handler asked for more replies than were scripted');
      if (next instanceof Error) throw next;
      return { output: next, usage: USAGE, model: 'fake-1' };
    },
  };
  return { provider, seen };
}

/**
 * Structural, because `server` does not depend on `sql-guard`. It denies on the shapes the
 * real kernel denies on, which is all the handler's mapping cares about.
 */
export const fakeGuard = (): Guard => (sql) => {
  const text = sql.trim();
  if (text.includes('\0')) return { ok: false, code: 'E_NUL_BYTE', detail: 'a NUL byte is in the statement' };
  if (text.includes(';')) {
    return { ok: false, code: 'E_MULTI_STATEMENT', detail: 'two statements were submitted as one' };
  }
  if (!/^select\b/i.test(text)) {
    return { ok: false, code: 'E_NOT_SELECT', detail: 'the statement is a DELETE, which is not a SELECT' };
  }
  if (text.includes('pg_sleep')) {
    return { ok: false, code: 'E_FUNCTION_NOT_ALLOWED', detail: 'function pg_sleep is not on the allowlist' };
  }
  return {
    ok: true,
    sql: `${text} LIMIT 1000`,
    tables: [{ schema: 'public', name: 'users' }],
    rowLimit: 1000,
  };
};

export interface FakeDatabaseOptions {
  /** One entry per read. The last one repeats, so a subscription keeps getting rows. */
  readonly results?: readonly (readonly (readonly unknown[])[])[];
  readonly columns?: readonly string[];
  readonly failReads?: boolean;
}

export interface FakeDatabase {
  readonly source: ReaderSource;
  readonly statements: readonly string[];
  readonly reads: () => number;
  readonly released: readonly boolean[];
}

export function fakeDatabase(options: FakeDatabaseOptions = {}): FakeDatabase {
  const statements: string[] = [];
  const released: boolean[] = [];
  const columns = options.columns ?? ['method', 'signups'];
  const results = options.results ?? [[['email', 3]]];
  let reads = 0;

  const client: SqlClient = {
    async query(text: string): Promise<QueryOutcome> {
      statements.push(text);
      if (text === 'SHOW transaction_read_only') {
        return { fields: [{ name: 'transaction_read_only' }], rows: [['on']] };
      }
      if (/^SELECT/i.test(text)) {
        if (options.failReads === true) throw new Error('permission denied for relation users');
        const rows = results[Math.min(reads, results.length - 1)] ?? [];
        reads += 1;
        return { fields: columns.map((name) => ({ name })), rows };
      }
      return { fields: [], rows: [] };
    },
    release(destroy?: boolean) {
      released.push(destroy === true);
    },
  };

  const source: ConnectionSource = {
    async connect() {
      return client;
    },
  };
  return { source: asReaderSource(source), statements, reads: () => reads, released };
}

export const TENANT = 'acme';

export const fakeResolver = (tokens: Readonly<Record<string, TenantScope | Error>>): ScopeResolver => {
  return async (token: string) => {
    const hit = tokens[token];
    if (hit === undefined) throw new IdentityError('E_TOKEN_SIGNATURE', 'token rejected: bad signature');
    if (hit instanceof Error) throw hit;
    return hit;
  };
};

export const scopeFor = (tenantId: string): TenantScope => ({
  tenantId,
  settings: [{ name: 'app.tenant_id', value: tenantId }],
});

export interface BaseOptions {
  readonly script?: readonly unknown[];
  readonly database?: FakeDatabase;
  readonly provider?: FakeProvider;
}

export function singleTenantConfig(
  over: Partial<InsightKitConfig> = {},
  base: BaseOptions = {},
): InsightKitConfig {
  const database = base.database ?? fakeDatabase();
  const model = base.provider ?? fakeProvider(base.script ?? [draft()]);
  return {
    source: database.source,
    guard: fakeGuard(),
    provider: model.provider,
    schema: SCHEMA,
    tenancy: { mode: 'single', acknowledge: SINGLE_TENANT_ACKNOWLEDGEMENT },
    ...over,
  };
}

export const askRequest = (question: string, token?: string): Request =>
  new Request('http://host.test/api/insightkit/ask', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ question }),
  });

export const subscribeRequest = (token: string, bearer?: string, intervalMs?: number): Request =>
  new Request('http://host.test/api/insightkit/subscribe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify({ token, ...(intervalMs === undefined ? {} : { intervalMs }) }),
  });

/** Reads SSE frames until `count` data frames have arrived or the stream ends. */
export async function readFrames(response: Response, count: number): Promise<unknown[]> {
  const body = response.body;
  if (body === null) return [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buffer = '';
  try {
    while (events.length < count) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let at = buffer.indexOf('\n\n');
      while (at !== -1) {
        const chunk = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)) as unknown);
        }
        at = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return events;
}
