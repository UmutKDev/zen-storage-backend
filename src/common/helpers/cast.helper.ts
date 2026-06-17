import { AllMimeTypesExtensions, MimeTypeGroups } from '@common/enums';
import { camelCase, startCase } from 'lodash';
import { randomInt, randomUUID } from 'crypto';

export const slugify = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

export const turkishSlugify = (value: string): string => {
  if (!value) return '';
  return value
    .normalize('NFC')
    .replace(/\u011e/g, 'G') // Ğ
    .replace(/\u00dc/g, 'U') // Ü
    .replace(/\u015e/g, 'S') // Ş
    .replace(/\u0130/g, 'I') // İ
    .replace(/\u00d6/g, 'O') // Ö
    .replace(/\u00c7/g, 'C') // Ç
    .replace(/\u011f/g, 'g') // ğ
    .replace(/\u00fc/g, 'u') // ü
    .replace(/\u015f/g, 's') // ş
    .replace(/\u0131/g, 'i') // ı
    .replace(/\u00f6/g, 'o') // ö
    .replace(/\u00e7/g, 'c'); // ç
};

export const passwordGenerator = (length: number): string => {
  const charset =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*-_=+';

  const password = Array.from({ length })
    .fill(charset)
    .map((e: string) => {
      return e[randomInt(e.length)];
    });

  return password.join('');
};

export const uuidGenerator = (): string => {
  return randomUUID();
};

export const SizeFormatter = ({
  From,
  FromUnit,
  ToUnit,
}: {
  From: number;
  FromUnit: 'B' | 'KB' | 'MB' | 'GB';
  ToUnit: 'B' | 'KB' | 'MB' | 'GB';
}): number => {
  const unitMap = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
  };

  const bytes = From * unitMap[FromUnit];
  return bytes / unitMap[ToUnit];
};

export const CDNPathResolver = (path: string): string => {
  if (!path) {
    return path;
  }
  // Already an absolute URL (e.g. a presigned URL or one built via GetUrl):
  // it is fully resolved, so prepending the endpoint again would duplicate it.
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  return process.env.S3_PUBLIC_ENDPOINT + '/' + path;
};

export const IsImageFile = (name: string): boolean => {
  const imageExtensions = Object.values(MimeTypeGroups.Images).map(
    (type) => type.split('/')[1],
  );
  const lowerName = name.toLowerCase();
  return imageExtensions.some((ext) => lowerName.endsWith(ext));
};

export const KeyBuilder = (keys: string[]): string => {
  // Normalize each segment by removing leading/trailing slashes so joining
  // always produces a single '/' between parts. Also ignore empty segments.
  const combined = keys
    .filter((key) => key && key.length > 0)
    .map((key) => key.replace(/^\/+|\/+$/g, ''))
    .filter((key) => key.length > 0)
    .join('/');

  // If there's nothing left, return empty string
  if (!combined) return '';

  // If the final segment contains a file extension (dot followed by chars),
  // keep it as-is. Otherwise ensure the combined path ends with a single '/'.
  const lastSegment = combined.split('/').pop() || '';
  const hasExtension = /\.[^/]+$/.test(lastSegment);

  return hasExtension ? combined : combined + '/';
};

export const PascalizeKeys = (obj: any): any => {
  if (Array.isArray(obj)) {
    return obj.map((v) => PascalizeKeys(v));
  } else if (obj !== null && obj.constructor === Object) {
    return Object.keys(obj).reduce<Record<string, any>>(
      (result, key) => ({
        ...result,
        [ToPascalCase(key)]: PascalizeKeys(obj[key]),
      }),
      {},
    );
  }
  return obj;
};

export const ToPascalCase = (str: string): string =>
  startCase(camelCase(str)).replace(/ /g, '');

/**
 * Percent-encode each path SEGMENT of a storage key, leaving the `/` separators
 * literal. Use when a raw UTF-8 key must go into a URL path or an S3 header that
 * the AWS SDK does not encode for us (`CopySource`, the public-URL builder).
 */
export const EncodeStorageKey = (key: string): string =>
  key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

/**
 * Build the `CopySource` value for an S3 `CopyObjectCommand`.
 *
 * AWS SDK v3 percent-encodes the `Key`/`Prefix` params for every other command,
 * but it sends `CopySource` (the `x-amz-copy-source` header) verbatim, so the
 * caller must encode it. We encode each path SEGMENT (preserving the literal `/`
 * separators that S3 requires) and append an encoded `?versionId=` suffix when a
 * version is targeted. `encodeURIComponent` covers spaces, `#`, `?`, `+` and
 * multibyte UTF-8 (e.g. Turkish letters). The bucket name is ASCII, left as-is.
 */
export const EncodeCopySource = (
  bucket: string,
  key: string,
  versionId?: string,
): string => {
  const base = `${bucket}/${EncodeStorageKey(key)}`;
  return versionId
    ? `${base}?versionId=${encodeURIComponent(versionId)}`
    : base;
};

/**
 * Normalize an inbound storage key/path/name without losing information.
 *
 * Keys are stored as human-readable UTF-8 (the S3 SDK encodes them on the wire),
 * so this no longer transliterates Turkish characters and no longer calls
 * `decodeURIComponent` (which threw a URIError on any literal '%', e.g.
 * "50% off.pdf"). It only: strips a full URL prefix + query/fragment when a real
 * URL was passed, removes control characters (illegal in S3 keys and HTTP
 * headers), and trims.
 *
 * Leading/trailing slashes are intentionally preserved: a root destination ("/")
 * must stay non-empty so `@IsNotEmpty` on `DestinationKey` etc. still passes, and
 * `KeyBuilder` normalizes slashes when it composes the final object key. It also
 * deliberately does NOT re-normalize Unicode (no NFC/NFD) or transliterate, so the
 * key's byte sequence is preserved — move/copy/delete/rename take their source key
 * from the listing round-trip, so leaving the bytes untouched keeps them matching
 * the stored object exactly, including objects created before this fix.
 */
export const S3KeyConverter = (input: string): string => {
  if (input == null) return input;
  let value = String(input);
  if (/^https?:\/\//i.test(value)) {
    value = value.replace(/^https?:\/\/[^/]+\//, '').replace(/[?#].*$/, '');
  }
  // Drop control characters (code points 0-31 and 127) which are illegal in S3
  // keys and HTTP headers, using a code-point filter to keep source ASCII-only.
  value = Array.from(value)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('');
  return value.trim();
};

export const ExtensionFromMimeType = (mimeType: string): string | null => {
  for (const ext of AllMimeTypesExtensions) {
    const base = ext.slice(1).toLowerCase();
    const key = base.charAt(0).toUpperCase() + base.slice(1);
    const type =
      MimeTypeGroups.Images[key] ||
      MimeTypeGroups.Audio[key] ||
      MimeTypeGroups.Video[key] ||
      MimeTypeGroups.Documents[key] ||
      MimeTypeGroups.Archives[key];
    if (type === mimeType) return ext;
  }
  return null;
};

export const MimeTypeFromExtension = (extension: string): string | null => {
  const ext = (
    extension.startsWith('.') ? extension : '.' + extension
  ).toLowerCase();
  const base = ext.slice(1).toLowerCase();
  const key = base.charAt(0).toUpperCase() + base.slice(1);
  const type =
    MimeTypeGroups.Images[key] ||
    MimeTypeGroups.Audio[key] ||
    MimeTypeGroups.Video[key] ||
    MimeTypeGroups.Documents[key] ||
    MimeTypeGroups.Archives[key];
  return type || null;
};
