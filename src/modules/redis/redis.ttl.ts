/**
 * Centralized Redis TTL / duration constants (all values in **seconds**).
 *
 * Environment-variable overrides are resolved here so every consumer
 * references a single source of truth.
 */

// ─── Helper ──────────────────────────────────────────────────────────────────

const envInt = (key: string, fallback: number): number =>
  Math.max(1, parseInt(process.env[key] ?? String(fallback), 10));

// ─── Session ─────────────────────────────────────────────────────────────────

/** Session data TTL — 7 days */
export const SESSION_TTL = 60 * 60 * 24 * 7;

/** Minimum interval between `updateSessionActivity` Redis writes */
export const SESSION_ACTIVITY_THROTTLE = 60;

// ─── Authentication ──────────────────────────────────────────────────────────

/** WebAuthn challenge TTL — 5 minutes */
export const PASSKEY_CHALLENGE_TTL = 300;

/** `hasPasskey` boolean cache — 5 minutes */
export const HAS_PASSKEY_CACHE_TTL = 300;

/** `isTwoFactorEnabled` boolean cache — 5 minutes */
export const TWO_FACTOR_ENABLED_CACHE_TTL = 300;

/** 2FA brute-force lockout window — 15 minutes */
export const TWO_FACTOR_LOCKOUT_TTL = 900;

/** Maximum failed 2FA attempts before lockout */
export const TWO_FACTOR_MAX_ATTEMPTS = 5;

// ─── API Key ─────────────────────────────────────────────────────────────────

/** Cached API-key entity lookup by PublicKey — 5 minutes */
export const API_KEY_ENTITY_CACHE_TTL = 300;

/** Per-minute rate-limit counter TTL — 60 seconds */
export const API_KEY_RATE_LIMIT_TTL = 60;

// ─── Account ─────────────────────────────────────────────────────────────────

/** User profile cache — 5 minutes */
export const ACCOUNT_PROFILE_CACHE_TTL = 300;

// ─── Subscription ────────────────────────────────────────────────────────────

/** Subscription plan list cache — 30 minutes */
export const SUBSCRIPTION_LIST_CACHE_TTL = 1800;

/** Per-user subscription cache — 10 minutes */
export const USER_SUBSCRIPTION_CACHE_TTL = 600;

// ─── Definition ──────────────────────────────────────────────────────────────

/** Definition group / list cache — 1 hour */
export const DEFINITION_CACHE_TTL = 3600;

// ─── Cloud ───────────────────────────────────────────────────────────────────

/** Cloud listing cache (objects, directories, combined) */
export const CLOUD_LIST_CACHE_TTL = envInt(
  'CLOUD_LIST_CACHE_TTL_SECONDS',
  3600,
);

/** Directory thumbnail cache */
export const CLOUD_THUMBNAIL_CACHE_TTL = envInt(
  'CLOUD_LIST_THUMBNAIL_CACHE_TTL_SECONDS',
  86400,
);

/** Encrypted folder manifest cache — 10 minutes */
export const ENCRYPTED_MANIFEST_CACHE_TTL = 600;

/** Encrypted folder unlock-session TTL — 15 minutes */
export const ENCRYPTED_FOLDER_SESSION_TTL = 15 * 60;

/** Hidden folder manifest cache — 10 minutes */
export const HIDDEN_MANIFEST_CACHE_TTL = 600;

/** Hidden folder reveal-session TTL — 15 minutes */
export const HIDDEN_FOLDER_SESSION_TTL = 15 * 60;

/** Idempotency key cache for cloud mutations */
export const CLOUD_IDEMPOTENCY_TTL = envInt(
  'CLOUD_IDEMPOTENCY_TTL_SECONDS',
  300,
);

// ─── Archive ────────────────────────────────────────────────────────────────

/** Archive creation result cache TTL — 1 hour (how long the download link stays valid) */
export const ARCHIVE_CREATE_RESULT_TTL = envInt(
  'ARCHIVE_CREATE_TTL_SECONDS',
  3600,
);

// ─── Duplicate Scan ────────────────────────────────────────────────────────

/** Duplicate scan status cache TTL — 24 hours */
export const DUPLICATE_SCAN_STATUS_TTL = envInt(
  'DUPLICATE_SCAN_STATUS_TTL_SECONDS',
  86400,
);

/** Duplicate scan result cache TTL — 24 hours */
export const DUPLICATE_SCAN_RESULT_TTL = envInt(
  'DUPLICATE_SCAN_RESULT_TTL_SECONDS',
  86400,
);

/** Duplicate scan cancel signal TTL — 6 hours */
export const DUPLICATE_SCAN_CANCEL_TTL = 6 * 60 * 60;

/** Duplicate scan active lock TTL — 6 hours (auto-cleared on completion) */
export const DUPLICATE_SCAN_ACTIVE_TTL = 6 * 60 * 60;

// ─── Team ───────────────────────────────────────────────────────────────────

/** Team membership cache — 5 minutes (used by TeamContextGuard) */
export const TEAM_MEMBERSHIP_CACHE_TTL = 300;

/** Team list cache — 10 minutes */
export const TEAM_LIST_CACHE_TTL = 600;

/** Team detail cache — 10 minutes */
export const TEAM_DETAIL_CACHE_TTL = 600;

/** Team invitation expiry — 7 days */
export const TEAM_INVITATION_EXPIRY = 60 * 60 * 24 * 7;

// ─── API Usage ──────────────────────────────────────────────────────────────

/** Monthly usage counter TTL — 35 days (outlives the billing month) */
export const API_USAGE_MONTHLY_TTL = 60 * 60 * 24 * 35;

/** Daily usage counter TTL — 48 hours */
export const API_USAGE_DAILY_TTL = 60 * 60 * 48;

/** Usage log buffer entry TTL — 1 hour (flushed every 5 minutes) */
export const API_USAGE_BUFFER_TTL = 3600;

// ─── API Rate Limiting ──────────────────────────────────────────────────────

/** Sliding window counter TTL — 120 seconds (2× the 60-second window) */
export const API_RATE_LIMIT_WINDOW_TTL = 120;

/** Burst counter TTL — 2 seconds */
export const API_RATE_LIMIT_BURST_TTL = 2;

// ─── API Idempotency ────────────────────────────────────────────────────────

/** API idempotency result cache — 24 hours (env-overridable) */
export const API_IDEMPOTENCY_TTL = envInt('API_IDEMPOTENCY_TTL_SECONDS', 86400);

// ─── API Signature ──────────────────────────────────────────────────────────

/** Nonce TTL for replay prevention — 5 minutes (matches timestamp window) */
export const API_SIGNATURE_NONCE_TTL = 300;

// ─── Webhook ────────────────────────────────────────────────────────────────

/** Cached user webhooks — 5 minutes */
export const WEBHOOK_USER_CACHE_TTL = 300;

/** Webhook delivery context TTL — 1 hour */
export const WEBHOOK_DISPATCH_TTL = 3600;

// ─── Geolocation ────────────────────────────────────────────────────────────

/** IP geolocation cache — 24 hours */
export const API_GEO_CACHE_TTL = 86400;

// ─── Document ──────────────────────────────────────────────────────────────

/** Document edit lock TTL — 5 minutes */
export const DOCUMENT_LOCK_TTL = 5 * 60;

/** Document draft TTL — 1 hour */
export const DOCUMENT_DRAFT_TTL = 60 * 60;

/** Document save throttle — 30 seconds */
export const DOCUMENT_SAVE_THROTTLE_TTL = 30;

/** Document auto-save throttle — 10 seconds */
export const DOCUMENT_AUTOSAVE_THROTTLE_TTL = 10;

/** Document draft counter TTL — 1 hour (same as draft) */
export const DOCUMENT_DRAFT_COUNTER_TTL = 60 * 60;
