import { deparseSync, parseSync } from 'pgsql-parser';
import { ALLOWED_FIELDS, ALLOWED_TAGS } from './allowlist.js';
import { ALLOWED_FUNCTION_SCHEMAS, ALLOWED_FUNCTIONS } from './functions.js';
import { applyRowCap, effectiveLimit } from './rowcap.js';
import type { DenyCode, Policy, TableRef, Verdict } from './types.js';

const DEFAULT_MAX_DEPTH = 100;

const deny = (code: DenyCode, detail: string): Verdict => ({ ok: false, code, detail });

const isTag = (key: string): boolean => /^[A-Z]/.test(key);

interface Scan {
  tables: TableRef[];
  cteNames: Set<string>;
  denial: Verdict | null;
  maxDepth: number;
}

function funcNameParts(node: unknown): string[] {
  if (!Array.isArray(node)) return [];
  return node.map((n) => (n as { String?: { sval?: string } })?.String?.sval ?? '?');
}

function checkFunction(body: Record<string, unknown>, scan: Scan): void {
  const parts = funcNameParts(body.funcname);
  if (parts.length === 0 || parts.length > 2) {
    scan.denial = deny('E_FUNCTION_NOT_ALLOWED', `unresolvable function name: ${parts.join('.')}`);
    return;
  }
  const name = parts[parts.length - 1] as string;
  const schema = parts.length === 2 ? (parts[0] as string) : null;
  if (schema !== null && !ALLOWED_FUNCTION_SCHEMAS.has(schema)) {
    scan.denial = deny('E_FUNCTION_NOT_ALLOWED', `function schema not allowed: ${schema}`);
    return;
  }
  if (!ALLOWED_FUNCTIONS.has(name.toLowerCase())) {
    scan.denial = deny('E_FUNCTION_NOT_ALLOWED', `function not on allowlist: ${name}`);
  }
}

function walk(node: unknown, tag: string | null, depth: number, scan: Scan): void {
  if (scan.denial) return;
  if (depth > scan.maxDepth) {
    scan.denial = deny('E_DEPTH_EXCEEDED', `nesting deeper than ${scan.maxDepth}`);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walk(item, tag, depth + 1, scan);
    return;
  }
  if (node === null || typeof node !== 'object') return;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (scan.denial) return;

    if (isTag(key)) {
      if (!ALLOWED_TAGS.has(key)) {
        scan.denial = deny('E_NODE_NOT_ALLOWED', `node type not on allowlist: ${key}`);
        return;
      }
      const body = (value ?? {}) as Record<string, unknown>;
      if (key === 'FuncCall') checkFunction(body, scan);
      if (key === 'CommonTableExpr' && typeof body.ctename === 'string') scan.cteNames.add(body.ctename);
      if (key === 'RangeVar') {
        scan.tables.push({
          schema: typeof body.schemaname === 'string' ? body.schemaname : null,
          name: typeof body.relname === 'string' ? body.relname : '',
        });
      }
      walk(value, key, depth + 1, scan);
      continue;
    }

    if (tag !== null) {
      const allowed = ALLOWED_FIELDS[tag];
      if (allowed === undefined || !allowed.has(key)) {
        scan.denial = deny('E_FIELD_NOT_ALLOWED', `field not allowed on ${tag}: ${key}`);
        return;
      }
    }
    walk(value, tag, depth + 1, scan);
  }
}

function applyPolicy(scan: Scan, policy: Policy): Verdict | null {
  for (const t of scan.tables) {
    if (t.schema === null && scan.cteNames.has(t.name)) continue;
    const schema = t.schema ?? 'public';
    if (policy.allowedSchemas && !policy.allowedSchemas.includes(schema)) {
      return deny('E_SCHEMA_NOT_ALLOWED', `schema not allowed: ${schema}`);
    }
    if (policy.allowedTables) {
      const qualified = `${schema}.${t.name}`;
      if (!policy.allowedTables.includes(qualified) && !policy.allowedTables.includes(t.name)) {
        return deny('E_TABLE_NOT_ALLOWED', `table not allowed: ${qualified}`);
      }
    }
  }
  return null;
}

function inspect(sql: string, policy: Policy): { verdict: Verdict; tree?: unknown } {
  if (typeof sql !== 'string' || sql.trim() === '') {
    return { verdict: deny('E_EMPTY', 'empty statement') };
  }

  // The parser is C-backed and truncates at NUL, so anything after one is never inspected.
  if (sql.includes('\u0000')) {
    return { verdict: deny('E_NUL_BYTE', 'input contains a NUL byte') };
  }

  let parsed: { stmts?: Array<{ stmt?: Record<string, unknown> }> };
  try {
    parsed = parseSync(sql) as typeof parsed;
  } catch (err) {
    return { verdict: deny('E_PARSE', err instanceof Error ? err.message : 'parse failed') };
  }

  const stmts = parsed?.stmts ?? [];
  if (stmts.length === 0) return { verdict: deny('E_EMPTY', 'no statement found') };
  if (stmts.length > 1) {
    return { verdict: deny('E_MULTI_STATEMENT', `${stmts.length} statements; exactly 1 permitted`) };
  }

  const root = stmts[0]?.stmt;
  if (!root || typeof root !== 'object') return { verdict: deny('E_PARSE', 'missing statement body') };

  const rootTags = Object.keys(root);
  if (rootTags.length !== 1 || rootTags[0] !== 'SelectStmt') {
    return { verdict: deny('E_NOT_SELECT', `top-level statement is ${rootTags.join(',') || 'unknown'}`) };
  }

  const scan: Scan = {
    tables: [],
    cteNames: new Set(),
    denial: null,
    maxDepth: policy.maxDepth ?? DEFAULT_MAX_DEPTH,
  };
  walk(root, null, 0, scan);
  if (scan.denial) return { verdict: scan.denial };

  const policyDenial = applyPolicy(scan, policy);
  if (policyDenial) return { verdict: policyDenial };

  return { verdict: { ok: true, sql, tables: scan.tables, rowLimit: null }, tree: parsed };
}

function selectOf(tree: unknown): Record<string, unknown> | null {
  const stmts = (tree as { stmts?: Array<{ stmt?: Record<string, unknown> }> } | undefined)?.stmts;
  const select = stmts?.[0]?.stmt?.SelectStmt;
  return select !== null && typeof select === 'object' ? (select as Record<string, unknown>) : null;
}

export function guardWith(sql: string, policy: Policy = {}): Verdict {
  try {
    const first = inspect(sql, policy);
    if (!first.verdict.ok) return first.verdict;

    let rowLimit: number | null = null;
    if (policy.maxRows !== undefined) {
      const select = selectOf(first.tree);
      if (select === null) return deny('E_INTERNAL', 'validated tree exposes no SelectStmt');
      const capped = applyRowCap(select, policy.maxRows);
      if (!capped.ok) return deny(capped.code, capped.detail);
      rowLimit = capped.limit;
    }

    let emitted: string;
    try {
      emitted = deparseSync(first.tree as never);
    } catch (err) {
      return deny('E_ROUND_TRIP_FAILED', err instanceof Error ? err.message : 'deparse failed');
    }

    const second = inspect(emitted, policy);
    if (!second.verdict.ok) {
      return deny('E_ROUND_TRIP_FAILED', `emitted sql rejected on re-inspection: ${second.verdict.code}`);
    }

    if (policy.maxRows !== undefined) {
      const emittedSelect = selectOf(second.tree);
      const present = emittedSelect === null ? { kind: 'dynamic' as const } : effectiveLimit(emittedSelect);
      if (present.kind !== 'static' || present.value > policy.maxRows) {
        return deny('E_ROUND_TRIP_FAILED', 'row cap is not present in the emitted sql');
      }
    }

    return { ok: true, sql: emitted, tables: second.verdict.tables, rowLimit };
  } catch (err) {
    return deny('E_INTERNAL', err instanceof Error ? err.message : 'unknown internal failure');
  }
}
