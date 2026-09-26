import type { SessionSetting } from '../execute.js';
import { assertSettingName, assertSettingValue } from '../execute.js';
import { IdentityError } from './errors.js';

export const DEFAULT_TENANT_SETTING = 'app.tenant_id';

export interface ScopeClaim {
  readonly setting: string;
  readonly claim: string;
}

export interface ScopeConfig {
  readonly tenantClaim: string;
  readonly tenantSetting?: string;
  /** Further claims an RLS policy needs, such as a user id or a role. Each one is required. */
  readonly extra?: readonly ScopeClaim[];
}

export interface TenantScope {
  readonly tenantId: string;
  readonly settings: readonly SessionSetting[];
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const claimText = (raw: unknown): string | null => {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? String(raw) : null;
  return null;
};

const settingName = (name: string): string => {
  try {
    return assertSettingName(name);
  } catch (err) {
    throw new IdentityError('E_SETTING_NAME_UNSAFE', `unsafe session setting name: ${describe(err)}`, {
      cause: err,
    });
  }
};

const settingValue = (value: string, claim: string, setting: string): string => {
  try {
    return assertSettingValue(value, `claim ${claim}`);
  } catch (err) {
    throw new IdentityError(
      'E_TENANT_VALUE_UNSAFE',
      `claim ${claim} cannot be carried in ${setting}: ${describe(err)}`,
      { cause: err },
    );
  }
};

export function tenantScope(claims: Readonly<Record<string, unknown>>, config: ScopeConfig): TenantScope {
  if (typeof config.tenantClaim !== 'string' || config.tenantClaim.length === 0) {
    throw new IdentityError('E_CONFIG', 'tenantClaim must name the claim that carries the tenant id');
  }

  const wanted: readonly ScopeClaim[] = [
    { setting: config.tenantSetting ?? DEFAULT_TENANT_SETTING, claim: config.tenantClaim },
    ...(config.extra ?? []),
  ];

  const seen = new Set<string>();
  const settings: SessionSetting[] = [];

  for (const { setting, claim } of wanted) {
    const name = settingName(setting);
    if (seen.has(name)) throw new IdentityError('E_CONFIG', `session setting ${name} is mapped twice`);
    seen.add(name);

    const raw = Object.hasOwn(claims, claim) ? claims[claim] : undefined;
    const text = claimText(raw);
    if (text === null || text.length === 0) {
      // Never an empty scope: falling through with no tenant is one customer reading another's rows.
      throw new IdentityError(
        'E_TENANT_CLAIM_MISSING',
        `claim ${JSON.stringify(claim)} is missing or unusable (${raw === undefined ? 'absent' : typeof raw})`,
      );
    }

    settings.push({ name, value: settingValue(text, claim, name) });
  }

  const tenantId = settings[0]?.value;
  if (tenantId === undefined) throw new IdentityError('E_CONFIG', 'no tenant setting was produced');

  return { tenantId, settings };
}
