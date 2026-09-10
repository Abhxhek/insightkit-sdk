// A key must never reach a log line, an error message or a thrown stack. Adapters
// already refuse to attach a provider's own error object, which can carry request
// configuration; this is the last defence in front of anything we do surface.
// Single character class, no nested quantifier, so it cannot backtrack.
const KEY_LIKE = /\b(?:sk|pk|api|key|token|bearer)[-_][A-Za-z0-9_-]{12,}/gi;

export const redact = (text: string): string => text.replace(KEY_LIKE, '[redacted]');
