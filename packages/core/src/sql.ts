const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

export function assertIdent(name: string, what: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw new RangeError(`${what} must be a plain SQL identifier, got ${JSON.stringify(name)}`);
  }
  return name;
}

export function quoteIdent(name: string, what: string): string {
  return `"${assertIdent(name, what)}"`;
}

export function quoteLiteral(value: string, what: string): string {
  if (value.includes('\u0000')) throw new RangeError(`${what} contains a NUL byte`);
  return `'${value.replace(/'/g, "''")}'`;
}
