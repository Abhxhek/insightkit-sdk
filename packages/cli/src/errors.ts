export const EXIT_OK = 0;
export const EXIT_NOT_PROVEN = 1;
export const EXIT_USAGE = 2;
export const EXIT_CANNOT_RUN = 3;

/** A bad flag, a bad value, or a name core refused. Exit 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * Nothing was proven or printed because the command never got that far. Exit 3.
 * The message is printed verbatim, so whatever raises one scrubs it first.
 */
export class CannotRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CannotRunError';
  }
}

export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
