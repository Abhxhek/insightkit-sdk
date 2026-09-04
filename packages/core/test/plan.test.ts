import { describe, expect, it } from 'vitest';
import type { ColumnInfo, DatabaseSchema, ForeignKey, TableInfo } from '../src/introspect/types.js';
import { estimateTokens, renderSchema } from '../src/plan/render.js';
import { selectTables, terms } from '../src/plan/retrieve.js';

const col = (name: string, dataType = 'text', extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  dataType,
  typeOid: 25,
  nullable: true,
  comment: null,
  ...extra,
});

const table = (
  schema: string,
  name: string,
  columns: readonly ColumnInfo[],
  extra: Partial<TableInfo> = {},
): TableInfo => ({
  schema,
  name,
  kind: 'table',
  comment: null,
  estimatedRows: 0,
  primaryKey: [],
  columns,
  ...extra,
});

const fk = (name: string, from: [string, string, string[]], to: [string, string, string[]]): ForeignKey => ({
  name,
  from: { schema: from[0], table: from[1], columns: from[2] },
  to: { schema: to[0], table: to[1], columns: to[2] },
});

const db = (tables: readonly TableInfo[], foreignKeys: readonly ForeignKey[] = []): DatabaseSchema => ({
  observedAs: 'ik_reader',
  tables,
  foreignKeys,
  truncated: false,
});

const USERS = table(
  'public',
  'users',
  [
    col('id', 'bigint', { nullable: false }),
    col('email', 'text', { nullable: false, comment: 'login address' }),
    col('signup_method', 'text'),
  ],
  { primaryKey: ['id'], estimatedRows: 1200, comment: 'people who signed up' },
);
const ORDERS = table(
  'public',
  'orders',
  [
    col('id', 'bigint', { nullable: false }),
    col('user_id', 'bigint', { nullable: false }),
    col('total_cents', 'integer'),
  ],
  { primaryKey: ['id'], estimatedRows: 90000 },
);
const TICKETS = table('support', 'tickets', [col('id', 'bigint'), col('subject')], {
  estimatedRows: 40,
});
const ORDERS_FK = fk('orders_user', ['public', 'orders', ['user_id']], ['public', 'users', ['id']]);

describe('rendering a schema for a prompt', () => {
  it('emits schema-qualified DDL a model has seen a lot of', () => {
    const sql = renderSchema([USERS], []);
    expect(sql).toContain('CREATE TABLE public.users (');
    expect(sql).toContain('id bigint NOT NULL');
    expect(sql).toContain('PRIMARY KEY (id)');
    expect(sql.trimEnd().endsWith(');')).toBe(true);
  });

  it('marks nullable columns by omitting NOT NULL', () => {
    expect(renderSchema([USERS], [])).toMatch(/signup_method text(?! NOT NULL)/);
  });

  it('carries comments through, since they are what a column name does not say', () => {
    const sql = renderSchema([USERS], []);
    expect(sql).toContain('-- people who signed up');
    expect(sql).toContain('-- login address');
  });

  it('can be asked to leave comments and counts out', () => {
    const sql = renderSchema([USERS], [], { includeComments: false, includeRowCounts: false });
    expect(sql).not.toContain('--');
  });

  it('reports the row estimate so a planner can tell a lookup from a scan', () => {
    expect(renderSchema([ORDERS], [])).toContain('approximately 90,000 rows');
  });

  it('renders a foreign key when both tables are present', () => {
    const sql = renderSchema([USERS, ORDERS], [ORDERS_FK]);
    expect(sql).toContain('FOREIGN KEY (user_id) REFERENCES public.users (id)');
  });

  it('omits a foreign key pointing at a table it did not describe', () => {
    const sql = renderSchema([ORDERS], [ORDERS_FK]);
    expect(sql).not.toContain('REFERENCES');
  });

  it('does not leave a dangling comma before the closing paren', () => {
    expect(renderSchema([USERS, ORDERS], [ORDERS_FK])).not.toMatch(/,\s*\)/);
  });

  it('quotes an identifier that is not a plain lowercase name', () => {
    const odd = table('public', 'Order Items', [col('Unit Price')]);
    const sql = renderSchema([odd], []);
    expect(sql).toContain('public."Order Items"');
    expect(sql).toContain('"Unit Price"');
  });

  it('says when a relation is a view rather than a table', () => {
    const view = table('public', 'summary', [col('n')], { kind: 'view' });
    expect(renderSchema([view], [])).toContain('CREATE VIEW public.summary (');
  });

  it('keeps a comment on the last column outside the comma it removed', () => {
    const one = table('public', 't', [col('a', 'text', { comment: 'note' })]);
    expect(renderSchema([one], [])).toContain('a text -- note');
  });
});

describe('tokenising a question', () => {
  it('drops filler words that match nothing useful', () => {
    expect(terms('how many of the users')).toEqual(['many', 'user']);
  });

  it('splits snake_case and camelCase identifiers alike', () => {
    expect(terms('signup_method')).toEqual(['signup', 'method']);
    expect(terms('signupMethod')).toEqual(['signup', 'method']);
  });

  it('reduces plurals so a question about users finds the users table', () => {
    expect(terms('users')).toEqual(terms('user'));
    expect(terms('companies')).toEqual(['company']);
    expect(terms('addresses')).toEqual(['address']);
  });

  it('leaves a short word ending in double s alone', () => {
    expect(terms('class pass')).toEqual(['class', 'pass']);
  });
});

describe('choosing which tables a question is about', () => {
  const schema = db([USERS, ORDERS, TICKETS], [ORDERS_FK]);

  it('picks the table whose name the question names', () => {
    const picked = selectTables(db([USERS, TICKETS]), 'how many tickets are open?', { linkDepth: 0 });
    expect(picked.tables.map((t) => t.name)).toEqual(['tickets']);
    expect(picked.matched).toBe(true);
  });

  it('matches on a column name, not only the table name', () => {
    const picked = selectTables(db([USERS, TICKETS]), 'break it down by signup method', {
      linkDepth: 0,
    });
    expect(picked.tables.map((t) => t.name)).toEqual(['users']);
  });

  it('matches on a comment, which is where the business words live', () => {
    const picked = selectTables(db([ORDERS, USERS]), 'who signed up', { linkDepth: 0 });
    expect(picked.tables[0]?.name).toBe('users');
  });

  it('pulls in the table a join needs even though the question never named it', () => {
    const picked = selectTables(schema, 'total orders', { linkDepth: 1 });
    expect(picked.tables.map((t) => t.name)).toContain('orders');
    expect(picked.tables.map((t) => t.name)).toContain('users');
    expect(picked.foreignKeys).toHaveLength(1);
  });

  it('does not follow foreign keys when told not to', () => {
    const picked = selectTables(schema, 'total orders', { linkDepth: 0 });
    expect(picked.tables.map((t) => t.name)).toEqual(['orders']);
  });

  it('honours the table cap and reports what it left out', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      table('public', `report_${i}`, [col('id'), col('value')]),
    );
    const picked = selectTables(db(many), 'report', { maxTables: 4 });
    expect(picked.tables).toHaveLength(4);
    expect(picked.omitted).toBe(26);
  });

  it('stops adding tables once the token budget is spent', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      table(
        'public',
        `report_${i}`,
        Array.from({ length: 20 }, (_, c) => col(`field_${c}`)),
      ),
    );
    const picked = selectTables(db(many), 'report', { maxTables: 30, maxTokens: 300 });
    expect(picked.estimatedTokens).toBeLessThanOrEqual(300);
    expect(picked.tables.length).toBeLessThan(30);
    expect(picked.omitted).toBeGreaterThan(0);
  });

  it('returns one table even when a single table blows the budget', () => {
    const huge = table(
      'public',
      'wide',
      Array.from({ length: 400 }, (_, i) => col(`field_${i}`)),
    );
    const picked = selectTables(db([huge]), 'wide', { maxTokens: 10 });
    expect(picked.tables).toHaveLength(1);
  });

  it('says so when nothing matched, rather than pretending', () => {
    const picked = selectTables(schema, 'what is the weather in Jaipur', { linkDepth: 0 });
    expect(picked.matched).toBe(false);
    expect(picked.tables.length).toBeGreaterThan(0);
  });

  it('falls back to the most connected tables when nothing matched', () => {
    const picked = selectTables(schema, 'weather', { maxTables: 1, linkDepth: 0 });
    expect(['users', 'orders']).toContain(picked.tables[0]?.name);
  });

  it('returns the same answer for the same question', () => {
    const a = selectTables(schema, 'orders by signup method');
    const b = selectTables(schema, 'orders by signup method');
    expect(a.tables.map((t) => t.name)).toEqual(b.tables.map((t) => t.name));
  });

  it('follows a foreign key to the right table when two keys would run together', () => {
    // "a" + "bc" and "ab" + "c" concatenate identically, so a naive key sends the
    // join to whichever of the two was indexed last.
    const left = table('a', 'bc', [col('alpha')]);
    const right = table('ab', 'c', [col('beta')]);
    const invoices = table('billing', 'invoices', [col('target_id', 'bigint')]);
    const link = fk('inv_target', ['billing', 'invoices', ['target_id']], ['a', 'bc', ['alpha']]);
    const picked = selectTables(db([left, right, invoices], [link]), 'invoices', { linkDepth: 1 });
    const names = picked.tables.map((t) => `${t.schema}.${t.name}`);
    expect(names).toContain('a.bc');
    expect(names).not.toContain('ab.c');
  });

  it('reports how much of the schema it looked at', () => {
    expect(selectTables(schema, 'orders').considered).toBe(3);
  });

  it('produces rendered SQL that matches the tables it chose', () => {
    const picked = selectTables(schema, 'total orders');
    for (const t of picked.tables) expect(picked.sql).toContain(`.${t.name} (`);
    expect(picked.estimatedTokens).toBe(estimateTokens(picked.sql));
  });
});
