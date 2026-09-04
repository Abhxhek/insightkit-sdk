module.exports = {
  forbidden: [
    {
      name: 'kernel-no-io',
      severity: 'error',
      comment:
        'sql-guard decides whether SQL is safe and must not be able to act on that decision. No database drivers, no network, no filesystem.',
      from: { path: '^packages/sql-guard/src' },
      to: {
        path: '^(node:)?(fs|net|http|https|child_process|dgram|tls|dns|worker_threads|vm|cluster)(/|$)|^pg(-|$)|^node-fetch$|^axios$|^undici$',
      },
    },
    {
      name: 'kernel-no-siblings',
      severity: 'error',
      comment: 'sql-guard must be auditable in isolation. Its only dependency is the Postgres parser.',
      from: { path: '^packages/sql-guard/src' },
      to: { path: '^packages/(?!sql-guard/)' },
    },
    {
      name: 'browser-never-imports-engine',
      severity: 'error',
      comment:
        'One import of core from a client component ships the database URL into the browser bundle. react talks to the server over HTTP, never in-process.',
      from: { path: '^packages/react/src' },
      to: { path: '^packages/(core|cli|server)/' },
    },
    {
      name: 'browser-no-server-modules',
      severity: 'error',
      comment: 'Nothing in the browser package may reach a Node builtin or a database driver.',
      from: { path: '^packages/react/src' },
      to: { path: '^(node:)?(fs|net|http|https|child_process|tls|dns)(/|$)|^pg(-|$)' },
    },
    {
      name: 'llm-never-touches-guard',
      severity: 'error',
      comment:
        'The code that talks to an untrusted model does not sit next to the code that decides what is trusted. Model output crosses that gap as a string.',
      from: { path: '^packages/llm/src' },
      to: { path: '^packages/(sql-guard|core)/' },
    },
    {
      name: 'protocol-stays-portable',
      severity: 'error',
      comment: 'protocol is shared by browser and server. It must run in both.',
      from: { path: '^packages/protocol/src' },
      to: { path: '^(node:)?(fs|net|http|https|child_process|tls|dns)(/|$)|^pg(-|$)|^packages/' },
    },
    {
      name: 'eval-measures-the-shipped-system',
      severity: 'error',
      comment:
        'The harness must exercise the code we publish. A direct driver import would let a reference query run on a path production never uses, and the gate would then be green about a different system.',
      from: { path: '^packages/eval/(src|test)' },
      to: { path: '^pg(-|$)|^postgres$|^node-postgres$' },
    },
    {
      name: 'nothing-ships-the-harness',
      severity: 'error',
      comment: 'eval is a gate, not a dependency. No published package may import it.',
      from: { path: '^packages/(?!eval/)' },
      to: { path: '^packages/eval/' },
    },
    {
      name: 'eval-src-is-pure',
      severity: 'error',
      comment:
        'Scoring must be reproducible from a results file. The comparator, the gate and the runner take their I/O as injected functions.',
      from: { path: '^packages/eval/src' },
      to: { path: '^(node:)?(fs|net|http|https|child_process|dgram|tls|dns|worker_threads|vm|cluster)(/|$)' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'src-never-imports-test',
      severity: 'error',
      from: { path: '^packages/[^/]+/src' },
      to: { path: '^packages/[^/]+/test' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.ts', '.tsx', '.mjs', '.cjs'],
    },
  },
};
