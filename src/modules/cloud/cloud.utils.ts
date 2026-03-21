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
