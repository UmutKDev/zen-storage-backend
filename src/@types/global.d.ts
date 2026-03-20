import { Role, Status, TeamRole } from '@common/enums';

export declare global {
  type AnyObject = Record<string, unknown>;

  namespace NodeJS {
    interface ProcessEnv {
      // Database Configuration
      PG_HOSTNAME: string;
      PG_USERNAME: string;
      PG_PASSWORD: string;
      PG_DATABASE: string;
      PG_PORT: string;
      PG_SCHEMA: string;
      PG_SYNCHRONIZE: string;
      PG_CACERT?: string;

      MONGO_HOSTNAME: string;
      MONGO_PORT: string;
      MONGO_USERNAME: string;
      MONGO_PASSWORD: string;
      MONGO_DATABASE: string;
      MONGO_ENABLED: string;

      // Swagger Configuration
      SWAGGER_USER: string;
      SWAGGER_PASSWORD: string;

      // WebAuthn/Passkey Configuration
      WEBAUTHN_RP_ID?: string;
      WEBAUTHN_RP_NAME?: string;

      // Session Configuration
      SESSION_TTL_SECONDS?: string;

      // Sentry
      SENTRY_DSN?: string;
      SENTRY_AUTH_TOKEN?: string;

      // AWS S3
      S3_PROTOCOL_ACCESS_KEY_ID?: string;
      S3_PROTOCOL_ACCESS_KEY_SECRET?: string;
      S3_PROTOCOL_SIGNED_URL_PROCESSING?: string;

      S3_MAX_SOCKETS?: string;
      S3_ENDPOINT?: string;
      S3_PUBLIC_ENDPOINT?: string;
      S3_FORCE_PATH_STYLE?: string;
      S3_REGION?: string;

      // Redis Configuration
      REDIS_HOSTNAME: string;
      REDIS_PORT: string;
      REDIS_PASSWORD: string;
      REDIS_TTL: string;

      // Cloud Listing Limits
      CLOUD_LIST_METADATA_CONCURRENCY?: string;
      CLOUD_LIST_METADATA_MAX?: string;

      // Cloud Upload Limits
      CLOUD_UPLOAD_PART_MAX_BYTES?: string;

      // Cloud Rate Limits
      CLOUD_UPLOAD_RATE_TTL?: string;
      CLOUD_UPLOAD_RATE_LIMIT?: string;
      CLOUD_DOWNLOAD_RATE_TTL?: string;
      CLOUD_DOWNLOAD_RATE_LIMIT?: string;

      // Cloud Antivirus
      CLOUD_AV_ENABLED?: string;
      CLOUD_AV_HOST?: string;
      CLOUD_AV_PORT?: string;
      CLOUD_AV_MAX_BYTES?: string;
      CLOUD_AV_SOCKET_TIMEOUT_MS?: string;
      CLOUD_AV_CONCURRENCY?: string;

      // Cloud Idempotency
      CLOUD_IDEMPOTENCY_TTL_SECONDS?: string;

      // Zip Extraction Limits (legacy, use ARCHIVE_EXTRACT_* instead)
      ZIP_EXTRACT_MAX_ENTRIES?: string;
      ZIP_EXTRACT_MAX_ENTRY_BYTES?: string;
      ZIP_EXTRACT_MAX_TOTAL_BYTES?: string;
      ZIP_EXTRACT_MAX_RATIO?: string;
      ZIP_EXTRACT_JOB_CONCURRENCY?: string;
      ZIP_EXTRACT_ENTRY_CONCURRENCY?: string;
      ZIP_EXTRACT_PROGRESS_ENTRIES?: string;
      ZIP_EXTRACT_PROGRESS_BYTES?: string;

      // Archive Extraction Limits
      ARCHIVE_EXTRACT_JOB_CONCURRENCY?: string;
      ARCHIVE_EXTRACT_ENTRY_CONCURRENCY?: string;
      ARCHIVE_EXTRACT_PROGRESS_ENTRIES?: string;
      ARCHIVE_EXTRACT_PROGRESS_BYTES?: string;
      ARCHIVE_EXTRACT_MAX_ENTRIES?: string;
      ARCHIVE_EXTRACT_MAX_ENTRY_BYTES?: string;
      ARCHIVE_EXTRACT_MAX_TOTAL_BYTES?: string;
      ARCHIVE_EXTRACT_MAX_RATIO?: string;

      // Archive Creation Limits
      ARCHIVE_CREATE_JOB_CONCURRENCY?: string;
      ARCHIVE_CREATE_MAX_FILES?: string;
      ARCHIVE_CREATE_MAX_TOTAL_BYTES?: string;
      ARCHIVE_CREATE_TEMP_PREFIX?: string;
      ARCHIVE_CREATE_TTL_SECONDS?: string;

      // Archive Preview
      ARCHIVE_PREVIEW_MAX_BYTES?: string;

      // RAR Specific
      RAR_MAX_BUFFER_BYTES?: string;

      // Mail Configuration
      MAIL_HOST: string;
      MAIL_SECURE: string;
      MAIL_FROM: string;
      MAIL_PORT: string;
      MAIL_USER: string;
      MAIL_PASSWORD: string;

      // Application Configuration
      TZ: string;
      NODE_ENV: string;
      PORT: string;
      APP_NAME?: string;
      CLIENT_APP_URL: string;
      API_APP_URL: string;

      // API Access System
      API_IDEMPOTENCY_TTL_SECONDS?: string;
      GEOIP_DB_PATH?: string;

      // MongoDB Configuration
      MONGO_URI?: string;
      MONGO_DATABASE?: string;
      MONGO_ENABLED?: string;
    }
  }

  interface UserContext {
    Id: string;
    FullName: string;
    Email: string;
    Role: Role;
    Status: Status;
    Image?: string;
    TeamId?: string;
    TeamRole?: TeamRole;
    ApiKeyId?: string;
  }

  interface TeamContext {
    TeamId: string;
    TeamRole: TeamRole;
    TeamSlug: string;
    TeamName: string;
  }

  interface Request {
    user: UserContext;
    TotalRowCount: number;
    TeamContext?: TeamContext;
  }

  namespace Codes {
    namespace Error {
      const enum Global {}

      const enum Database {
        EntityMetadataNotFoundError = 'EntityMetadataNotFoundError',
        EntityNotFoundError = 'EntityNotFoundError',
        EntityConflictError = '23505',
        QueryFailedError = 'QueryFailedError',
      }

      const enum Cloud {
        FILE_NOT_FOUND = 'CL-001',
      }

      const enum User {
        NOT_FOUND = 'UR-001',
        CANNOT_BE_EMPTY = 'UR-002',
        INACTIVE = 'UR-003',
        SUSPENDED = 'UR-004',
      }

      const enum Username {
        ALREADY_EXISTS = 'UN-001',
        CANNOT_BE_EMPTY = 'UN-002',
      }

      const enum Email {
        ALREADY_EXISTS = 'ER-001',
        NOT_FOUND = 'ER-002',
        CANNOT_BE_EMPTY = 'ER-003',
        INVALID = 'ER-004',
      }

      const enum PhoneNumber {
        ALREADY_EXISTS = 'PN-001',
      }

      const enum Password {
        WRONG = 'PR-001',
        CANNOT_BE_EMPTY = 'PR-002',
        NOT_STRONG = 'PR-003',
        NOT_MATCH = 'PR-004',
      }

      const enum Subscription {
        NOT_FOUND = 'SU-001',
      }

      const enum Api {
        // Authentication (AP-1xx)
        INVALID_API_KEY = 'AP-101',
        API_KEY_EXPIRED = 'AP-102',
        API_KEY_REVOKED = 'AP-103',
        INSUFFICIENT_SCOPES = 'AP-104',
        IP_NOT_WHITELISTED = 'AP-105',

        // Signature (AP-2xx)
        SIGNATURE_REQUIRED = 'AP-201',
        SIGNATURE_INVALID = 'AP-202',
        TIMESTAMP_EXPIRED = 'AP-203',
        NONCE_REUSED = 'AP-204',
        SIGNATURE_MALFORMED = 'AP-205',

        // Rate Limiting (AP-3xx)
        RATE_LIMIT_EXCEEDED = 'AP-301',
        BURST_LIMIT_EXCEEDED = 'AP-302',
        MONTHLY_QUOTA_EXCEEDED = 'AP-303',
        DAILY_QUOTA_EXCEEDED = 'AP-304',

        // Idempotency (AP-4xx)
        IDEMPOTENCY_KEY_REQUIRED = 'AP-401',
        IDEMPOTENCY_KEY_CONFLICT = 'AP-402',
        IDEMPOTENCY_KEY_TOO_LONG = 'AP-403',

        // Webhook (AP-5xx)
        WEBHOOK_NOT_FOUND = 'AP-501',
        WEBHOOK_URL_INVALID = 'AP-502',
        WEBHOOK_LIMIT_EXCEEDED = 'AP-503',
        WEBHOOK_DELIVERY_NOT_FOUND = 'AP-504',
        WEBHOOK_DISABLED = 'AP-505',

        // Usage (AP-6xx)
        USAGE_DATA_NOT_AVAILABLE = 'AP-601',

        // Version (AP-7xx)
        VERSION_NOT_SUPPORTED = 'AP-701',
        VERSION_DEPRECATED = 'AP-702',

        // General (AP-9xx)
        SUBSCRIPTION_REQUIRED = 'AP-901',
        TIER_UPGRADE_REQUIRED = 'AP-902',
        FEATURE_NOT_AVAILABLE = 'AP-903',
      }
    }
  }
}
