import { loadModule, parseSync } from 'pgsql-parser';
import { beforeAll, describe, expect, it } from 'vitest';
import { introspectionQueries } from '../src/introspect/queries.js';
import { introspectSchema } from '../src/introspect/run.js';
import type { IntrospectOptions } from '../src/introspect/types.js';
import type { QueryOutcome, SqlClient } from '../src/types.js';

type Rows = readonly (readonly unknown[])[];

const NEEDLES = {
  whoami: 'current_user()',
  tables: 'GREATEST(c.reltuples',
  columns: 'format_type',
  primaryKeys: "contype = 'p'",
  foreignKeys: "contype = 'f'",
} as const;

interface Answers {
  whoami?: Rows;
  tables?: Rows;
  columns?: Rows;
  primaryKeys?: Rows;
  foreignKeys?: Rows;
}

function fakeSource(answers: Answers, failOn?: string) {
  const log: string[] = [];
  const released: boolean[] = [];
  const client: SqlClient = {
    async query(text): Promise<QueryOutcome> {
      log.push(text);
      if (failOn !== undefined && text.includes(failOn)) throw new Error('permission denied');
      for (const [name, needle] of Object.entries(NEEDLES)) {
        if (text.includes(needle)) return { fields: [], rows: answers[name as keyof Answers] ?? [] };
      }
      return { fields: [], rows: [] };
    },
    release(destroy) {
      released.push(destroy === true);
    },
  };
  return { connect: async () => client, log, released };
}

const ALL = (o: IntrospectOptions = {}): string[] => {
  const q = introspectionQueries(o);
  return [q.whoami, q.tables, q.columns, q.primaryKeys, q.foreignKeys];
};

describe('the catalog queries are valid Postgres', () => {
  beforeAll(async () => {
    await loadModule();
  });

  it('parses every query, including the lateral unnest ones', () => {
    for (const sql of ALL()) {
      expect(() => parseSync(sql), sql.slice(0, 60)).not.toThrow();
    }
  });

  it('still parses with every option engaged', () => {
    const sql = ALL({
      schemas: ['public', 'reporting'],
      excludeSchemas: ['insightkit'],
      asRole: 'ik_reader',
      maxTables: 10,
      maxColumns: 20,
    });
    for (const s of sql) expect(() => parseSync(s)).not.toThrow();
  });

  it('produces exactly one statement per query', () => {
    for (const sql of ALL()) {
      const parsed = parseSync(sql) as { stmts?: unknown[] };
      expect(parsed.stmts).toHaveLength(1);
    }
  });
});

describe('what the queries are allowed to see', () => {
  it('reports the connected role when no role is named', () => {
    const text = ALL().join('\n');
    expect(text).toContain("has_table_privilege(c.oid, 'SELECT')");
    expect(text).not.toContain('ik_reader');
  });

  it('reports a named role instead, since introspecting as admin over-reports', () => {
    const text = ALL({ asRole: 'ik_reader' }).join('\n');
    expect(text).toContain("has_table_privilege('ik_reader', c.oid, 'SELECT')");
    expect(text).toContain("has_schema_privilege('ik_reader', n.oid, 'USAGE')");
  });

  it('checks column privilege, not only table privilege', () => {
    expect(introspectionQueries().columns).toContain("has_column_privilege(c.oid, a.attnum, 'SELECT')");
  });

  it('filters both ends of a foreign key so a hidden table is not disclosed', () => {
    const fk = introspectionQueries().foreignKeys;
    expect(fk).toContain("has_table_privilege(c.oid, 'SELECT')");
    expect(fk).toContain("has_table_privilege(fc.oid, 'SELECT')");
  });

  it('excludes system schemas everywhere', () => {
    for (const sql of ALL()) {
      if (sql.includes('current_user')) continue;
      expect(sql).toContain("NOT LIKE 'pg\\_%'");
      expect(sql).toContain("<> 'information_schema'");
    }
  });

  it('excludes the schemas it is told to, such as our own metadata', () => {
    expect(introspectionQueries({ excludeSchemas: ['insightkit'] }).tables).toContain(
      "n.nspname <> 'insightkit'",
    );
  });

  it('caps what it will read back', () => {
    const q = introspectionQueries({ maxTables: 5, maxColumns: 7 });
    expect(q.tables).toContain('LIMIT 6');
    expect(q.columns).toContain('LIMIT 8');
  });
});

describe('what the queries refuse to be built from', () => {
  it('refuses a role name that is not an identifier', () => {
    expect(() => introspectionQueries({ asRole: "x'; DROP TABLE users --" })).toThrow(/plain SQL identifier/);
  });

  it('escapes a schema name rather than trusting it', () => {
    expect(introspectionQueries({ schemas: ["it's"] }).tables).toContain("'it''s'");
  });

  it('refuses an empty schema list rather than silently describing everything', () => {
    expect(() => introspectionQueries({ schemas: [] })).toThrow(/at least one schema/);
  });

  it('refuses a nonsensical cap', () => {
    expect(() => introspectionQueries({ maxTables: 0 })).toThrow(/maxTables/);
    expect(() => introspectionQueries({ maxColumns: 1.5 })).toThrow(/maxColumns/);
  });
});

describe('assembling the schema', () => {
  const base: Answers = {
    whoami: [['ik_reader']],
    tables: [
      ['public', 'users', 'r', '1200', 'people'],
      ['public', 'orders', 'r', '90000', null],
      ['public', 'user_summary', 'v', '0', null],
    ],
    columns: [
      ['public', 'users', 'id', 'bigint', 20, true, null],
      ['public', 'users', 'email', 'text', 25, false, 'login'],
      ['public', 'orders', 'id', 'bigint', 20, true, null],
      ['public', 'orders', 'user_id', 'bigint', 20, true, null],
    ],
    primaryKeys: [
      ['public', 'users', 'id'],
      ['public', 'orders', 'id'],
    ],
    foreignKeys: [['orders_user_fk', 'public', 'orders', 'user_id', 'public', 'users', 'id']],
  };

  it('attaches each column to its own table', async () => {
    const schema = await introspectSchema(fakeSource(base));
    const users = schema.tables.find((t) => t.name === 'users');
    expect(users?.columns.map((c) => c.name)).toEqual(['id', 'email']);
    expect(schema.tables.find((t) => t.name === 'orders')?.columns).toHaveLength(2);
  });

  it('does not confuse tables whose names run together', async () => {
    const schema = await introspectSchema(
      fakeSource({
        whoami: [['r']],
        tables: [
          ['a b', 'c', 'r', '0', null],
          ['a', 'b c', 'r', '0', null],
        ],
        columns: [
          ['a b', 'c', 'first', 'text', 25, false, null],
          ['a', 'b c', 'second', 'text', 25, false, null],
        ],
      }),
    );
    expect(schema.tables[0]?.columns.map((c) => c.name)).toEqual(['first']);
    expect(schema.tables[1]?.columns.map((c) => c.name)).toEqual(['second']);
  });

  it('records nullability, types and comments', async () => {
    const schema = await introspectSchema(fakeSource(base));
    const email = schema.tables.find((t) => t.name === 'users')?.columns[1];
    expect(email).toEqual({
      name: 'email',
      dataType: 'text',
      typeOid: 25,
      nullable: true,
      comment: 'login',
    });
    expect(schema.tables.find((t) => t.name === 'users')?.columns[0]?.nullable).toBe(false);
  });

  it('maps relkind to something a prompt can use', async () => {
    const schema = await introspectSchema(fakeSource(base));
    expect(schema.tables.map((t) => t.kind)).toEqual(['table', 'table', 'view']);
  });

  it('keeps the row estimate as a number', async () => {
    const schema = await introspectSchema(fakeSource(base));
    expect(schema.tables.find((t) => t.name === 'orders')?.estimatedRows).toBe(90000);
  });

  it('folds a composite key back into one entry, in order', async () => {
    const schema = await introspectSchema(
      fakeSource({
        whoami: [['r']],
        tables: [['public', 'line_items', 'r', '0', null]],
        primaryKeys: [
          ['public', 'line_items', 'order_id'],
          ['public', 'line_items', 'sku'],
        ],
        foreignKeys: [
          ['li_fk', 'public', 'line_items', 'order_id', 'public', 'orders', 'id'],
          ['li_fk', 'public', 'line_items', 'sku', 'public', 'orders', 'sku'],
        ],
      }),
    );
    expect(schema.tables[0]?.primaryKey).toEqual(['order_id', 'sku']);
    expect(schema.foreignKeys).toHaveLength(1);
    expect(schema.foreignKeys[0]?.from.columns).toEqual(['order_id', 'sku']);
    expect(schema.foreignKeys[0]?.to.columns).toEqual(['id', 'sku']);
  });

  it('says whose visibility it is describing', async () => {
    expect((await introspectSchema(fakeSource(base))).observedAs).toBe('ik_reader');
  });

  it('reports truncation instead of silently describing part of the database', async () => {
    const many = Array.from({ length: 4 }, (_, i) => ['public', `t${i}`, 'r', '0', null]);
    const schema = await introspectSchema(fakeSource({ whoami: [['r']], tables: many }), {
      maxTables: 3,
    });
    expect(schema.tables).toHaveLength(3);
    expect(schema.truncated).toBe(true);
  });

  it('does not claim truncation when everything fit', async () => {
    expect((await introspectSchema(fakeSource(base))).truncated).toBe(false);
  });

  it('drops columns belonging to a table that was cut', async () => {
    const schema = await introspectSchema(
      fakeSource({
        whoami: [['r']],
        tables: [
          ['public', 'a', 'r', '0', null],
          ['public', 'b', 'r', '0', null],
        ],
        columns: [['public', 'b', 'gone', 'text', 25, false, null]],
      }),
      { maxTables: 1 },
    );
    expect(schema.tables.flatMap((t) => t.columns)).toEqual([]);
  });
});

describe('how introspection reaches the database', () => {
  it('runs inside a read-only transaction that always rolls back', async () => {
    const s = fakeSource({ whoami: [['r']] });
    await introspectSchema(s);
    expect(s.log[0]).toBe('BEGIN READ ONLY');
    expect(s.log.at(-1)).toBe('ROLLBACK');
    expect(s.log.some((t) => /commit/i.test(t))).toBe(false);
  });

  it('scopes every setting to the transaction', async () => {
    const s = fakeSource({ whoami: [['r']] });
    await introspectSchema(s);
    for (const t of s.log.filter((x) => x.startsWith('SET'))) expect(t).toMatch(/^SET LOCAL /);
  });

  it('rolls back and releases when a catalog read is refused', async () => {
    const s = fakeSource({ whoami: [['r']] }, 'format_type');
    await expect(introspectSchema(s)).rejects.toThrow(/permission denied/);
    expect(s.log.at(-1)).toBe('ROLLBACK');
    expect(s.released).toEqual([false]);
  });
});
