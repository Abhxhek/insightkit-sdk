import type { GuardedQuery, SecurityEvent } from '@insightkit/core';
import { expandQuestion, planQuery, renderGlossary, selectTables } from '@insightkit/core';
import { parseAskRequest } from '@insightkit/protocol';
import type { Runtime } from './config.js';
import { askError, askResponse, readJsonBody } from './http.js';
import { errorResponse, failureResponse, okResponse, sanitiseMessage } from './narrow.js';
import type { ReadScope } from './scope.js';
import { resolveScope, runScopedRead } from './scope.js';
import { newStreamToken } from './store.js';

const AUTH_MESSAGE: Readonly<Record<number, string>> = {
  401: 'authentication is required',
  403: 'this identity may not read',
};

export const FALLBACK_IDENTITY = 'single-tenant';

const guidanceFor = (parts: readonly (string | undefined)[]): string | undefined => {
  const kept = parts.filter((part): part is string => part !== undefined && part.trim() !== '');
  return kept.length === 0 ? undefined : kept.join('\n\n');
};

function issueStream(rt: Runtime, scope: ReadScope, query: GuardedQuery): string | undefined {
  const live = rt.live;
  if (live === null) return undefined;
  const now = rt.now();
  try {
    const token = newStreamToken();
    live.store.issue({
      token,
      identity: scope.identity,
      query,
      issuedAt: now,
      expiresAt: now + live.tokenTtlMs,
    });
    return token;
  } catch (error) {
    rt.onError({ phase: 'store', identity: scope.identity, error });
    return undefined;
  }
}

/**
 * Every planner outcome answers 200. The status code is as much a channel as the body, and an
 * attack-shaped refusal that answered 403 would hand back the oracle ADR 0012 closed. A non-200
 * here describes whether the request was admissible, never what the answer was.
 */
export async function handleAsk(rt: Runtime, request: Request): Promise<Response> {
  if (request.method.toUpperCase() !== 'POST') {
    return askError(405, 'use POST to ask a question', { allow: 'POST' });
  }

  const fallback = rt.identify(request) ?? FALLBACK_IDENTITY;
  const scoped = await resolveScope(rt.tenancy, rt.tokenFrom(request), fallback);
  if (!scoped.ok) {
    rt.onError({ phase: 'auth', identity: null, error: scoped.cause ?? scoped.detail });
    const headers = scoped.status === 401 ? { 'www-authenticate': 'Bearer' } : {};
    return askError(
      scoped.status,
      AUTH_MESSAGE[scoped.status] ?? 'the request could not be authorised',
      headers,
    );
  }

  const scope = scoped.scope;
  const bucket = rt.identify(request) ?? scope.identity;
  const admitted = rt.limiter.admit(bucket, rt.now());
  if (!admitted.ok) {
    return askError(admitted.status, admitted.detail, { 'retry-after': String(admitted.retryAfterSec) });
  }

  const leak = (issue: string): void => {
    rt.onError({
      phase: 'respond',
      identity: scope.identity,
      error: new Error(`response rejected: ${issue}`),
    });
  };

  try {
    const body = await readJsonBody(request, rt.limits.maxBodyBytes);
    if (!body.ok) return askError(body.status, body.detail);

    const parsed = parseAskRequest(body.value);
    if (!parsed.ok)
      return askError(
        400,
        sanitiseMessage(`the request was not accepted: ${parsed.error}`, 'the request was not accepted'),
      );

    const question = parsed.value.question;

    let raised = false;
    const onSecurityEvent = (event: SecurityEvent): void => {
      raised = true;
      const throttled = rt.limiter.strike(bucket, rt.now());
      const host = rt.onSecurityEvent;
      if (host === null) return;
      try {
        host({ ...event, identity: scope.identity, at: rt.now(), throttled });
      } catch {
        /* a host that cannot log must not turn a refusal into a failure */
      }
    };

    const schema = await rt.schema();
    // The expanded text is a retrieval query and never reaches a model: it is the glossary's
    // vocabulary, not the user's question, and sending it would change what was asked.
    const glossary = rt.glossary(schema);
    const expansion = glossary === null ? null : expandQuestion(glossary, question);
    const selection = selectTables(schema, expansion?.searchText ?? question, rt.retrieve);
    const terms = glossary === null ? '' : renderGlossary(glossary, selection.tables).text;
    const guidance = guidanceFor([rt.plan.guidance, terms]);

    const result = await planQuery({ guard: rt.guard, provider: rt.provider }, question, selection, {
      ...rt.plan,
      ...(guidance === undefined ? {} : { guidance }),
      onSecurityEvent,
    });

    if (!result.ok) {
      if (!raised) rt.onError({ phase: 'plan', identity: scope.identity, error: result.detail });
      return askResponse(failureResponse(result), 200, {}, leak);
    }

    const read = await runScopedRead(rt.source, result.plan.query, scope, rt.read);
    const stream = issueStream(rt, scope, result.plan.query);

    return askResponse(
      okResponse(result.plan.chart, read, {
        ...(rt.exposeSql ? { sql: result.plan.sql } : {}),
        ...(stream === undefined ? {} : { stream }),
      }),
      200,
      {},
      leak,
    );
  } catch (error) {
    rt.onError({ phase: 'read', identity: scope.identity, error });
    return askResponse(errorResponse(), 200, {}, leak);
  } finally {
    admitted.release();
  }
}
