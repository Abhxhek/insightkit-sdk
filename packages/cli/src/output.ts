export interface Output {
  out(line: string): void;
  err(line: string): void;
}

export interface BufferedOutput extends Output {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  all(): string;
}

export function processOutput(): Output {
  return {
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

export function bufferedOutput(): BufferedOutput {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => {
      stdout.push(line);
    },
    err: (line) => {
      stderr.push(line);
    },
    all: () => [...stdout, ...stderr].join('\n'),
  };
}
