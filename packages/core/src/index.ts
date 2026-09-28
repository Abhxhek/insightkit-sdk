export { approve, isGuardedQuery } from './approve.js';
export type { RoleNames } from './doctor/checks.js';
export { isolationChecks } from './doctor/checks.js';
export { proveIsolation } from './doctor/run.js';
export type { ScopedReadOptions, SessionSetting } from './execute.js';
export {
  ASSERT_READ_ONLY,
  assertSettingName,
  assertSettingValue,
  BEGIN_READ_ONLY,
  ROLLBACK,
  runGuardedRead,
  sessionPreamble,
  setLocal,
} from './execute.js';
export type { IdentityErrorCode, IdentityFailure } from './identity/errors.js';
export { IdentityError, identityFailure, isIdentityError } from './identity/errors.js';
export type { ScopeResolver, ScopeResolverConfig } from './identity/resolve.js';
export { createScopeResolver } from './identity/resolve.js';
export type { ScopeClaim, ScopeConfig, TenantScope } from './identity/scope.js';
export { DEFAULT_TENANT_SETTING, tenantScope } from './identity/scope.js';
export type {
  JwtAlgorithm,
  TokenVerifier,
  TokenVerifierConfig,
  VerificationKey,
  VerifiedToken,
} from './identity/verify.js';
export { createTokenVerifier, JWT_ALGORITHMS } from './identity/verify.js';
export type { IntrospectionQueries } from './introspect/queries.js';
export {
  DEFAULT_MAX_COLUMNS,
  DEFAULT_MAX_TABLES,
  introspectionQueries,
} from './introspect/queries.js';
export { introspectSchema } from './introspect/run.js';
export type {
  ColumnInfo,
  DatabaseSchema,
  ForeignKey,
  ForeignKeyEnd,
  IntrospectOptions,
  TableInfo,
  TableKind,
} from './introspect/types.js';
export type { PlanDeps } from './plan/planner.js';
export { isAttackShaped, isRepairable, planQuery } from './plan/planner.js';
export type { PromptOptions } from './plan/prompt.js';
export { repairTurn, systemPrompt } from './plan/prompt.js';
export type {
  ModelCompletion,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelUsage,
} from './plan/provider.js';
export { failureKind } from './plan/provider.js';
export type { RenderOptions } from './plan/render.js';
export { estimateTokens, renderDatabase, renderSchema, tableKey } from './plan/render.js';
export type { RetrieveOptions, Selection } from './plan/retrieve.js';
export { selectTables, terms } from './plan/retrieve.js';
export type { PlanDraft } from './plan/schema.js';
export { PLAN_SCHEMA, readPlan } from './plan/schema.js';
export type {
  AttemptOutcome,
  ChartKind,
  ChartSpec,
  Plan,
  PlanAttempt,
  PlanFailure,
  PlanOptions,
  PlanResult,
  SecurityEvent,
} from './plan/types.js';
export { CHART_KINDS } from './plan/types.js';
export type { ProvisionConfig, ProvisionScript } from './provision.js';
export { provisioningScript } from './provision.js';
export { expandQuestion } from './semantic/expand.js';
export { fragmentIssues } from './semantic/fragment.js';
export { defineGlossary, GLOSSARY_DEFAULTS } from './semantic/glossary.js';
export { renderGlossary } from './semantic/render.js';
export type {
  ExpandOptions,
  Expansion,
  FragmentIssue,
  FragmentProblemCode,
  Glossary,
  GlossaryEntry,
  GlossaryMatch,
  GlossaryProblem,
  GlossaryProblemCode,
  GlossaryRef,
  GlossaryRenderOptions,
  GlossaryReport,
  GlossarySection,
  GlossaryValidateOptions,
} from './semantic/types.js';
export { validateGlossary } from './semantic/validate.js';
export type { Ask } from './session.js';
export { inReadOnlyTransaction } from './session.js';
export { asAdminSource, asReaderSource, isAdminSource, isReaderSource } from './source.js';
export {
  CACHE_KEY_VERSION,
  cacheKey,
  DEFAULT_PLANNER_VERSION,
  glossaryDigest,
  normalizeQuestion,
  schemaDigest,
} from './store/key.js';
export type { AppliedMigration, Migration, MigrationOptions, MigrationReport } from './store/migrations.js';
export { MIGRATIONS, migrationChecksum, pendingMigrations, runMigrations } from './store/migrations.js';
export { APPROVED_QUERY_TABLE, DEFAULT_METADATA_SCHEMA, MIGRATION_TABLE } from './store/names.js';
export type { QueryStore, QueryStoreOptions } from './store/store.js';
export { createQueryStore, DEFAULT_MAX_ENTRY_BYTES, DEFAULT_TTL_MS } from './store/store.js';
export type {
  CachedPlan,
  CacheKey,
  CacheKeyInput,
  RejectedEntry,
  RejectionReason,
  SavedPlan,
  SavePlanInput,
  StoreErrorCode,
} from './store/types.js';
export { isStoreError, StoreError } from './store/types.js';
export type {
  AdminSource,
  Approval,
  Check,
  CheckOutcome,
  CheckReport,
  CheckStatus,
  ConnectionSource,
  GuardedQuery,
  IsolationProof,
  QueryOutcome,
  ReaderSource,
  ReadOptions,
  ReadResult,
  ResultSet,
  SqlClient,
} from './types.js';
