import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PACKAGES = join(ROOT, '..');
const DIST = join(ROOT, 'dist');
const PARTS = ['sql-guard', 'protocol', 'core', 'llm', 'server', 'react', 'cli'];

const manifests = new Map(
  PARTS.map((part) => [part, JSON.parse(readFileSync(join(PACKAGES, part, 'package.json'), 'utf8'))]),
);

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

// The part's own exports map decides where insightics-core/pg lands, so a renamed entry
// fails the build here instead of shipping a dangling import.
const targetOf = (part, subpath) => {
  const entry = manifests.get(part).exports?.[subpath === undefined ? '.' : `./${subpath}`];
  const file = typeof entry === 'string' ? entry : entry?.default;
  if (typeof file !== 'string' || !file.startsWith('./dist/')) {
    throw new Error(`insightics-${part} does not export ${subpath ?? '.'}`);
  }
  return join(DIST, part, file.slice('./dist/'.length));
};

// Module specifiers only: the same text also appears as data, such as the CLI's
// application_name and the package names it accepts when reporting --version.
const SPECIFIER = new RegExp(
  `(\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+)(['"])insightics-(${PARTS.join('|')})(?:/([a-z0-9-]+))?\\2`,
  'g',
);

// Source maps stay behind: they point at src/, which is not shipped, and a map that
// resolves to nothing makes every bundler that loads it print a warning.
const SOURCE_MAP_COMMENT = /\n\/\/# sourceMappingURL=\S+\.map\s*$/;

rmSync(DIST, { recursive: true, force: true });
for (const part of PARTS) {
  const built = join(PACKAGES, part, 'dist');
  if (!existsSync(built)) throw new Error(`insightics-${part} is not built: ${built} is missing`);
  cpSync(built, join(DIST, part), { recursive: true, filter: (path) => !path.endsWith('.map') });
}

const modules = walk(DIST).filter((file) => file.endsWith('.js') || file.endsWith('.d.ts'));
for (const file of modules) {
  const source = readFileSync(file, 'utf8');
  const rewritten = source
    .replace(SPECIFIER, (_match, lead, quote, part, subpath) => {
      const path = relative(dirname(file), targetOf(part, subpath)).split(sep).join('/');
      return `${lead}${quote}${path.startsWith('.') ? path : `./${path}`}${quote}`;
    })
    .replace(SOURCE_MAP_COMMENT, '\n');
  if (rewritten !== source) writeFileSync(file, rewritten);
}

const unresolved = modules.filter((file) => {
  SPECIFIER.lastIndex = 0;
  return SPECIFIER.test(readFileSync(file, 'utf8'));
});
if (unresolved.length > 0) throw new Error(`still importing a separate part:\n${unresolved.join('\n')}`);

console.log(`insightics: packed ${PARTS.length} parts, ${modules.length} modules`);
