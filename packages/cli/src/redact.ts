const CREDENTIALS = /\b([a-z][a-z0-9+.-]*):\/\/[^\s@]*@/gi;
const SECRET_PARAM = /([?&](?:password|sslpassword|sslkey|passfile)=)[^\s&]*/gi;
const KEY_LIKE = /\b(?:sk|pk|api|key|token|bearer)[-_][A-Za-z0-9_-]{12,}/gi;

export type Redactor = (text: string) => string;

/**
 * For error text only. It is never run over catalog output: a table named
 * token_expires_audit matches KEY_LIKE, and rewriting it would corrupt the answer.
 */
export const redact: Redactor = (text) =>
  text
    .replace(CREDENTIALS, '$1://[redacted]@')
    .replace(SECRET_PARAM, '$1[redacted]')
    .replace(KEY_LIKE, '[redacted]');

/**
 * Callers pass the URL and the password, never the user: the roles under test are
 * named in almost every check detail, so redacting those would blank the report.
 */
export function secretRedactorFor(secrets: readonly string[]): Redactor {
  const literals = [...new Set(secrets.filter((s) => s.length >= 4))];
  return (text) => literals.reduce((acc, secret) => acc.split(secret).join('[redacted]'), text);
}

export function redactorFor(secrets: readonly string[]): Redactor {
  const secretsOnly = secretRedactorFor(secrets);
  return (text) => redact(secretsOnly(text));
}
