import type { ResultSet as CoreRows, ChartSpec as PlanChart, PlanResult, ReadResult } from '@insightkit/core';
import type { AskResponse, Cell, ChartSpec, JsonValue, ResultSet } from '@insightkit/protocol';
import { MAX_MESSAGE_LENGTH, PROTOCOL_VERSION } from '@insightkit/protocol';

/**
 * A refusal says nothing about why. `E_NOT_SELECT` reaching a browser tells an attacker the
 * probe was detected and classified, which is a free map of the validator. See ADR 0012.
 */
export const REFUSED_MESSAGE = 'that question could not be answered safely';
export const ERROR_MESSAGE = 'the question could not be answered right now';
export const UNANSWERABLE_MESSAGE = 'the data available cannot answer that question';

const MAX_DEPTH = 24;

const ALLOWED_CONTROL = new Set([9, 10, 13]);

/**
 * A repair turn puts the deny code into the conversation, so a model can echo it back inside
 * an `answerable: false` reason on the next attempt. The model's prose is the one free-text
 * field that crosses, so it is scrubbed rather than trusted.
 */
const DENY_CODE = /\bE_[A-Z][A-Z0-9_]*/g;

export const stripDenyCodes = (text: string): string => text.replace(DENY_CODE, '');

/** Model prose reaching `prose()` with a stray control character would 500 an answerable result. */
export function sanitiseMessage(text: string, fallback: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const control = (code < 32 && !ALLOWED_CONTROL.has(code)) || (code >= 127 && code <= 159);
    out += control ? ' ' : ch;
  }
  const trimmed = out.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_LENGTH).trim();
  return trimmed === '' ? fallback : trimmed;
}

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

/**
 * A `Date` here would mean ADR 0007's text-first conversion was bypassed, and serialising it
 * is how a timestamp silently shifts a day. Refusing is loud; the handler turns it into a 500.
 */
export function toCell(value: unknown, depth = 0): Cell {
  if (value === null || value === undefined) return null;
  if (depth > MAX_DEPTH) throw new TypeError('a cell nests deeper than the wire allows');
  switch (typeof value) {
    case 'string':
      return value;
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('a non-finite number reached the wire; it must arrive as text');
      }
      return value;
    case 'object':
      break;
    default:
      throw new TypeError(`a ${typeof value} cannot cross the wire`);
  }
  const object = value as object;
  if (Array.isArray(object)) return object.map((item) => toCell(item, depth + 1));
  if (!isPlainObject(object)) {
    throw new TypeError(
      `a ${object.constructor?.name ?? 'non-plain object'} reached the wire; the reader path must return text`,
    );
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(object)) out[key] = toCell(item, depth + 1);
  return out;
}

export function toResultSet(rows: CoreRows): ResultSet {
  return {
    columns: [...rows.columns],
    rows: rows.rows.map((row) => row.map((cell) => toCell(cell))),
  };
}

export function toChartSpec(chart: PlanChart): ChartSpec {
  return { kind: chart.kind, x: chart.x, y: [...chart.y], series: chart.series, title: chart.title };
}

export interface OkOptions {
  readonly sql?: string;
  readonly stream?: string;
}

export function okResponse(chart: PlanChart, read: ReadResult, options: OkOptions = {}): AskResponse {
  return {
    status: 'ok',
    protocol: PROTOCOL_VERSION,
    chart: toChartSpec(chart),
    data: toResultSet(read.rows),
    truncated: read.reachedLimit,
    ...(options.sql === undefined ? {} : { sql: options.sql }),
    ...(options.stream === undefined ? {} : { stream: options.stream }),
  };
}

export const refusedResponse = (): AskResponse => ({
  status: 'refused',
  protocol: PROTOCOL_VERSION,
  message: REFUSED_MESSAGE,
});

export const errorResponse = (message: string = ERROR_MESSAGE): AskResponse => ({
  status: 'error',
  protocol: PROTOCOL_VERSION,
  message: sanitiseMessage(message, ERROR_MESSAGE),
});

/**
 * The one place a planner failure becomes a wire status. `detail`, `code`, `attempts` and
 * `usage` are dropped here and nowhere is there a branch that puts them back.
 */
export function failureResponse(result: Extract<PlanResult, { ok: false }>): AskResponse {
  if (result.reason === 'unanswerable') {
    // A denial earlier in the conversation means the model has seen a deny code. Once that has
    // happened its prose is no longer only about the schema, so it does not cross at all.
    const sawDenial = result.attempts.some((attempt) => attempt.outcome === 'denied');
    const message = sawDenial ? UNANSWERABLE_MESSAGE : stripDenyCodes(result.detail);
    return {
      status: 'unanswerable',
      protocol: PROTOCOL_VERSION,
      message: sanitiseMessage(message, UNANSWERABLE_MESSAGE),
    };
  }
  if (result.reason === 'rejected') return refusedResponse();
  return errorResponse();
}
