import { RedisOptions } from 'ioredis';
import { ArchiveFormat } from '@common/enums';

export const NormalizeDirectoryPath = (path: string): string =>
  (path || '').replace(/^\/+|\/+$/g, '');

export const EnsureTrailingSlash = (value: string): string =>
  value.endsWith('/') ? value : value + '/';

export const JoinKey = (...parts: string[]): string =>
  parts
    .map((part) => (part || '').replace(/^\/+|\/+$/g, ''))
    .filter((part) => !!part)
    .join('/');

// Parent directory of a key/path; '' for root or single-segment paths.
export const GetParentDirectoryPath = (path: string): string => {
  const normalized = NormalizeDirectoryPath(path);
  if (!normalized) {
    return '';
  }
  const parts = normalized.split('/').filter((part) => !!part);
  if (parts.length <= 1) {
    return '';
  }
  parts.pop();
  return parts.join('/');
};

// ─── Name / Extension ────────────────────────────────────────────────────────

// Last path segment (file/folder name) of an S3 key; '' when empty.
export const GetFileName = (key: string): string =>
  (key || '').split('/').pop() || '';

// Extension of a file name (without the dot); '' when there is none.
export const GetExtension = (name: string): string =>
  name.includes('.') ? (name.split('.').pop() ?? '') : '';

// ─── Folder Containment ──────────────────────────────────────────────────────

// First folder in `folders` that contains `relativePath` (exact match or
// ancestor prefix), or null. Encrypted vs hidden is purely the caller's Set.
export const FindContainingFolder = (
  relativePath: string,
  folders?: Set<string>,
): string | null => {
  if (!folders || folders.size === 0) {
    return null;
  }
  for (const folder of folders) {
    if (relativePath === folder || relativePath.startsWith(folder + '/')) {
      return folder;
    }
  }
  return null;
};

export const IsInsideFolder = (
  relativePath: string,
  folders?: Set<string>,
): boolean => FindContainingFolder(relativePath, folders) !== null;

// A background job (duplicate scan / archive create) excludes secure folders so
// their contents can't leak into a broad/root scan. But the user can EXPLICITLY
// scan a folder they navigated into — which may itself be hidden/encrypted (or
// nested inside one). Those ancestor-or-self secure folders must NOT be excluded
// (the user has access; it's their explicit target), otherwise the whole scan
// returns nothing. Returns the secure folders that should still be excluded for
// a scan rooted at `scanPath`: every folder that is NOT the scan root or an
// ancestor of it (so secure folders elsewhere — and strictly nested below the
// root — stay excluded). An empty `scanPath` (root scan) keeps them all.
export const SecureFoldersToExcludeForScan = (
  folders: Set<string>,
  scanPath: string,
): Set<string> => {
  const root = (scanPath || '').replace(/^\/+|\/+$/g, '');
  return new Set(
    [...folders].filter(
      (folder) => !(root === folder || root.startsWith(folder + '/')),
    ),
  );
};

// ─── Archive Format Detection ────────────────────────────────────────────────

export const ArchiveExtensionMap: Record<string, ArchiveFormat> = {
  '.zip': ArchiveFormat.ZIP,
  '.tar': ArchiveFormat.TAR,
  '.tar.gz': ArchiveFormat.TAR_GZ,
  '.tgz': ArchiveFormat.TAR_GZ,
  '.rar': ArchiveFormat.RAR,
};

export const GetArchiveFormat = (key: string): ArchiveFormat | null => {
  const lower = (key || '').toLowerCase();
  if (lower.endsWith('.tar.gz')) return ArchiveFormat.TAR_GZ;
  if (lower.endsWith('.tgz')) return ArchiveFormat.TAR_GZ;
  if (lower.endsWith('.zip')) return ArchiveFormat.ZIP;
  if (lower.endsWith('.tar')) return ArchiveFormat.TAR;
  if (lower.endsWith('.rar')) return ArchiveFormat.RAR;
  return null;
};

export const IsArchiveKey = (key: string): boolean =>
  GetArchiveFormat(key) !== null;

export const ArchiveFormatExtension = (format: ArchiveFormat): string => {
  switch (format) {
    case ArchiveFormat.ZIP:
      return '.zip';
    case ArchiveFormat.TAR:
      return '.tar';
    case ArchiveFormat.TAR_GZ:
      return '.tar.gz';
    case ArchiveFormat.RAR:
      return '.rar';
    default:
      return '.zip';
  }
};

// ─── Archive Path Utilities ──────────────────────────────────────────────────

export const BuildArchiveExtractPrefix = (
  key: string,
  format: ArchiveFormat,
): string => {
  const normalized = NormalizeDirectoryPath(key);
  const parts = normalized.split('/').filter((part) => !!part);
  const filename = parts.pop() || '';

  let baseName: string;
  if (format === ArchiveFormat.TAR_GZ) {
    baseName = filename.replace(/\.(tar\.gz|tgz)$/i, '').trim();
  } else {
    const extPattern =
      format === ArchiveFormat.ZIP
        ? /\.zip$/i
        : format === ArchiveFormat.TAR
          ? /\.tar$/i
          : format === ArchiveFormat.RAR
            ? /\.rar$/i
            : /$/;
    baseName = filename.replace(extPattern, '').trim();
  }

  const safeBase = baseName || filename || 'extracted';
  const parent = parts.join('/');
  return JoinKey(parent, safeBase);
};

export const NormalizeArchiveEntryPath = (entryPath: string): string | null => {
  const normalized = (entryPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/').filter((segment) => !!segment);
  if (!segments.length) return null;
  if (segments[0] === '__MACOSX') return null;
  if (segments.some((segment) => segment === '.DS_Store')) return null;
  if (segments.some((segment) => segment.startsWith('._'))) return null;
  if (segments.some((segment) => segment === '.' || segment === '..'))
    return null;
  if (
    segments[0] === 'PaxHeader' ||
    segments.some((segment) => segment === 'PaxHeader')
  )
    return null;
  return segments.join('/');
};

// ─── BullMQ Redis Connection ─────────────────────────────────────────────────

// Direct IORedis options for BullMQ queues/workers. These intentionally differ
// from the cache-manager RedisService config (maxRetriesPerRequest: null is
// required by BullMQ). Returns null when Redis env is not configured.
//
// Same environment-isolated DB as the cache (production → 0, test/dev → 1) so
// test jobs never land in the live queue DB on a shared Redis instance.
export const BuildBullRedisConnectionOptions = (): RedisOptions | null => {
  const host = process.env.REDIS_HOSTNAME;
  const portValue = process.env.REDIS_PORT ?? '';
  const port = parseInt(portValue, 10);
  if (!host || Number.isNaN(port)) {
    return null;
  }
  return {
    host,
    port,
    password: process.env.REDIS_PASSWORD,
    db: process.env.NODE_ENV === 'production' ? 0 : 1,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
};
