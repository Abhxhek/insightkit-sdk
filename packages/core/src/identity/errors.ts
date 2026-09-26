export type IdentityErrorCode =
  | 'E_TOKEN_MALFORMED'
  | 'E_TOKEN_SIGNATURE'
  | 'E_TOKEN_ALG'
  | 'E_TOKEN_EXPIRED'
  | 'E_TOKEN_CLAIM'
  | 'E_TOKEN_KEY'
  | 'E_TENANT_CLAIM_MISSING'
  | 'E_TENANT_VALUE_UNSAFE'
  | 'E_SETTING_NAME_UNSAFE'
  | 'E_CONFIG';

/** authentication maps to 401, authorization to 403, configuration to 500. */
export type IdentityFailure = 'authentication' | 'authorization' | 'configuration';

const FAILURE: Readonly<Record<IdentityErrorCode, IdentityFailure>> = {
  E_TOKEN_MALFORMED: 'authentication',
  E_TOKEN_SIGNATURE: 'authentication',
  E_TOKEN_ALG: 'authentication',
  E_TOKEN_EXPIRED: 'authentication',
  E_TOKEN_CLAIM: 'authentication',
  E_TOKEN_KEY: 'authentication',
  E_TENANT_CLAIM_MISSING: 'authorization',
  E_TENANT_VALUE_UNSAFE: 'authorization',
  E_SETTING_NAME_UNSAFE: 'configuration',
  E_CONFIG: 'configuration',
};

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  readonly failure: IdentityFailure;

  constructor(code: IdentityErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IdentityError';
    this.code = code;
    this.failure = FAILURE[code];
  }
}

export function isIdentityError(err: unknown): err is IdentityError {
  return err instanceof IdentityError;
}

export const identityFailure = (code: IdentityErrorCode): IdentityFailure => FAILURE[code];
