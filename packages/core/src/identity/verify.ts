import type { JWTVerifyGetKey, JWTVerifyOptions, KeyInput } from 'jose';
import { createRemoteJWKSet, importSPKI, jwtVerify } from 'jose';
import { IdentityError } from './errors.js';

export const JWT_ALGORITHMS = [
  'HS256',
  'HS384',
  'HS512',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;

export type JwtAlgorithm = (typeof JWT_ALGORITHMS)[number];

export type VerificationKey =
  | { readonly kind: 'secret'; readonly secret: string }
  | { readonly kind: 'publicKey'; readonly spki: string }
  | {
      readonly kind: 'jwks';
      readonly url: string;
      readonly timeoutMs?: number;
      readonly cacheMaxAgeMs?: number;
      readonly cooldownMs?: number;
    };

export interface TokenVerifierConfig {
  readonly key: VerificationKey;
  /** Required. The token's own `alg` header never selects the algorithm. */
  readonly algorithms: readonly JwtAlgorithm[];
  readonly issuer?: string | readonly string[];
  readonly audience?: string | readonly string[];
  readonly clockToleranceSec?: number;
  readonly maxTokenAgeSec?: number;
  readonly requiredClaims?: readonly string[];
}

export interface VerifiedToken {
  readonly claims: Readonly<Record<string, unknown>>;
  readonly algorithm: string;
  readonly subject: string | null;
  readonly expiresAt: number | null;
}

export type TokenVerifier = (token: string) => Promise<VerifiedToken>;

const MIN_SECRET_BYTES = 32;
const MAX_TOKEN_CHARS = 8192;
const MAX_CLOCK_TOLERANCE_SEC = 300;

const ALGORITHMS: ReadonlySet<string> = new Set(JWT_ALGORITHMS);

const CODES: Readonly<Record<string, IdentityError['code']>> = {
  ERR_JWS_SIGNATURE_VERIFICATION_FAILED: 'E_TOKEN_SIGNATURE',
  ERR_JWT_EXPIRED: 'E_TOKEN_EXPIRED',
  ERR_JOSE_ALG_NOT_ALLOWED: 'E_TOKEN_ALG',
  ERR_JOSE_NOT_SUPPORTED: 'E_TOKEN_ALG',
  ERR_JWT_CLAIM_VALIDATION_FAILED: 'E_TOKEN_CLAIM',
  ERR_JWS_INVALID: 'E_TOKEN_MALFORMED',
  ERR_JWT_INVALID: 'E_TOKEN_MALFORMED',
  ERR_JWKS_NO_MATCHING_KEY: 'E_TOKEN_KEY',
  ERR_JWKS_MULTIPLE_MATCHING_KEYS: 'E_TOKEN_KEY',
  ERR_JWKS_TIMEOUT: 'E_TOKEN_KEY',
  ERR_JWKS_INVALID: 'E_TOKEN_KEY',
  ERR_JWK_INVALID: 'E_TOKEN_KEY',
};

const config = (message: string, cause?: unknown): IdentityError =>
  new IdentityError('E_CONFIG', message, cause === undefined ? undefined : { cause });

const positiveInt = (value: number, what: string, max: number): number => {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw config(`${what} must be an integer between 1 and ${max}, got ${value}`);
  }
  return value;
};

const checkAlgorithms = (algorithms: readonly JwtAlgorithm[]): void => {
  if (algorithms.length === 0) {
    throw config('algorithms must name at least one algorithm; an empty allowlist accepts nothing');
  }
  for (const alg of algorithms) {
    if (!ALGORITHMS.has(alg)) {
      throw config(`unsupported algorithm ${JSON.stringify(alg)}; allowed: ${JWT_ALGORITHMS.join(', ')}`);
    }
  }
};

async function resolveKey(
  key: VerificationKey,
  algorithms: readonly JwtAlgorithm[],
): Promise<KeyInput | JWTVerifyGetKey> {
  if (key.kind === 'secret') {
    const bytes = new TextEncoder().encode(key.secret);
    if (bytes.length < MIN_SECRET_BYTES) {
      throw config(
        `shared secret must be at least ${MIN_SECRET_BYTES} bytes, got ${bytes.length}; jose does not enforce this`,
      );
    }
    return bytes;
  }

  if (key.kind === 'publicKey') {
    const alg = algorithms[0];
    if (alg === undefined || algorithms.length !== 1) {
      throw config('a publicKey allows exactly one algorithm; use a jwks endpoint to accept several');
    }
    try {
      return await importSPKI(key.spki, alg);
    } catch (err) {
      throw config('publicKey is not an SPKI-formatted PEM', err);
    }
  }

  let url: URL;
  try {
    url = new URL(key.url);
  } catch (err) {
    throw config(`jwks url is not a url: ${JSON.stringify(key.url)}`, err);
  }
  if (url.protocol !== 'https:') {
    throw config(`jwks url must be https, got ${url.protocol}; keys fetched over http are attacker-supplied`);
  }
  return createRemoteJWKSet(url, {
    ...(key.timeoutMs === undefined
      ? {}
      : { timeoutDuration: positiveInt(key.timeoutMs, 'timeoutMs', 60_000) }),
    ...(key.cacheMaxAgeMs === undefined
      ? {}
      : { cacheMaxAge: positiveInt(key.cacheMaxAgeMs, 'cacheMaxAgeMs', 86_400_000) }),
    ...(key.cooldownMs === undefined
      ? {}
      : { cooldownDuration: positiveInt(key.cooldownMs, 'cooldownMs', 3_600_000) }),
  });
}

const asIdentityError = (err: unknown): IdentityError => {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  const mapped = typeof code === 'string' ? CODES[code] : undefined;
  const detail = err instanceof Error ? err.message : String(err);
  return new IdentityError(mapped ?? 'E_TOKEN_SIGNATURE', `token rejected: ${detail}`, { cause: err });
};

export async function createTokenVerifier(options: TokenVerifierConfig): Promise<TokenVerifier> {
  checkAlgorithms(options.algorithms);
  const key = await resolveKey(options.key, options.algorithms);

  // jose verifies a token that carries no exp at all, so exp is demanded explicitly.
  const required = new Set<string>(['exp', ...(options.requiredClaims ?? [])]);

  const verifyOptions: JWTVerifyOptions = {
    algorithms: [...options.algorithms],
    requiredClaims: [...required],
    ...(options.issuer === undefined
      ? {}
      : { issuer: typeof options.issuer === 'string' ? options.issuer : [...options.issuer] }),
    ...(options.audience === undefined
      ? {}
      : { audience: typeof options.audience === 'string' ? options.audience : [...options.audience] }),
    ...(options.clockToleranceSec === undefined
      ? {}
      : {
          clockTolerance: positiveInt(
            options.clockToleranceSec,
            'clockToleranceSec',
            MAX_CLOCK_TOLERANCE_SEC,
          ),
        }),
    ...(options.maxTokenAgeSec === undefined
      ? {}
      : { maxTokenAge: positiveInt(options.maxTokenAgeSec, 'maxTokenAgeSec', 86_400) }),
  };

  return async (token: string): Promise<VerifiedToken> => {
    if (typeof token !== 'string' || token.length === 0) {
      throw new IdentityError('E_TOKEN_MALFORMED', 'no token was supplied');
    }
    if (token.length > MAX_TOKEN_CHARS) {
      throw new IdentityError(
        'E_TOKEN_MALFORMED',
        `token is ${token.length} characters, over the ${MAX_TOKEN_CHARS} limit`,
      );
    }

    try {
      const { payload, protectedHeader } = await jwtVerify(token, key, verifyOptions);
      return {
        claims: payload as Readonly<Record<string, unknown>>,
        algorithm: String(protectedHeader.alg),
        subject: typeof payload.sub === 'string' ? payload.sub : null,
        expiresAt: typeof payload.exp === 'number' ? payload.exp : null,
      };
    } catch (err) {
      throw asIdentityError(err);
    }
  };
}
