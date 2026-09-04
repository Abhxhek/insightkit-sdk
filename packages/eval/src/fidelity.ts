export const POSITIONAL_FIELDS: ReadonlySet<string> = new Set([
  'location',
  'list_start',
  'list_end',
  'rexpr_list_start',
  'rexpr_list_end',
]);

const POSITIONAL_SHAPE = /^(?:location|.*_(?:start|end))$/;

export interface FidelityResult {
  readonly equal: boolean;
  readonly unknownPositional: readonly string[];
}

const canonicalise = (node: unknown, unknown: Set<string>): unknown => {
  if (Array.isArray(node)) return node.map((child) => canonicalise(child, unknown));
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(node as Record<string, unknown>).sort()) {
    if (POSITIONAL_FIELDS.has(key)) continue;
    if (POSITIONAL_SHAPE.test(key)) unknown.add(key);
    out[key] = canonicalise((node as Record<string, unknown>)[key], unknown);
  }
  return out;
};

export function astEquivalent(a: unknown, b: unknown): FidelityResult {
  const unknown = new Set<string>();
  const left = JSON.stringify(canonicalise(a, unknown));
  const right = JSON.stringify(canonicalise(b, unknown));
  return { equal: left === right, unknownPositional: [...unknown].sort() };
}
