import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus } from '@nestjs/common';
import { Readable } from 'stream';
import { CloudArchiveService } from './cloud.archive.service';
import { CloudS3Service } from './cloud.s3.service';
import { CloudMetadataService } from './cloud.metadata.service';
import { CloudUsageService } from './cloud.usage.service';
import { CloudListService } from './cloud.list.service';
import { CloudDirectoryService } from './cloud.directory.service';
import { ArchiveHandlerRegistry } from './archive/archive-handler.registry';
import { NotificationService } from '@modules/notification/notification.service';
import { RedisService } from '@modules/redis/redis.service';
import { ArchiveEntryType, ConflictResolutionStrategy } from '@common/enums';

type ExtractConflictPlan =
  | { mode: 'overwrite' }
  | { mode: 'skip'; existing: Set<string> }
  | { mode: 'fail'; existing: Set<string> }
  | { mode: 'keepBoth'; existing: Set<string>; claimed: Set<string> };

// Access the private members under test without widening the public surface.
type ArchivePrivate = {
  ResolveExtractTarget: (
    ownerId: string,
    baseExtractPrefix: string,
    strategy: ConflictResolutionStrategy,
    createFolder: boolean,
  ) => Promise<{ prefix: string; plan: ExtractConflictPlan }>;
  UploadExtractedEntry: (
    user: { Id: string },
    extractPrefix: string,
    effectivePath: string,
    type: ArchiveEntryType,
    stream: Readable,
    size: number,
    plan: ExtractConflictPlan,
  ) => Promise<void>;
  ResolveCreateEntries: (
    ownerId: string,
    keys: string[],
    commonParent: string,
    encryptedFolders: Set<string>,
    hiddenFolders: Set<string>,
  ) => Promise<Array<{ Key: string; Name: string; Size: number }>>;
};

type S3Command = { constructor: { name: string }; input: Record<string, unknown> };

describe('CloudArchiveService', () => {
  let service: CloudArchiveService;
  let priv: ArchivePrivate;

  // Configured per-test:
  // occupied — full prefixes (with trailing slash) that already hold objects
  // listing  — full keys returned by a non-truncated list for a given prefix
  const occupied = new Set<string>();
  const listing = new Map<string, string[]>();

  const mockS3Service = {
    GetBuckets: jest.fn(() => ({ Storage: 'bucket' })),
    GetKey: jest.fn((key: string, ownerId: string) =>
      key.startsWith(`${ownerId}/`) ? key.slice(ownerId.length + 1) : key,
    ),
    IsNotFoundError: jest.fn(
      (error: { name?: string }) => error?.name === 'NotFound',
    ),
    Send: jest.fn(async (command: S3Command) => {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        const prefix = command.input.Prefix as string;
        if (command.input.MaxKeys === 1) {
          return occupied.has(prefix)
            ? { KeyCount: 1, Contents: [{ Key: `${prefix}placeholder` }] }
            : { KeyCount: 0, Contents: [] };
        }
        const keys = listing.get(prefix) ?? [];
        return {
          Contents: keys.map((Key) => ({ Key, Size: 4 })),
          IsTruncated: false,
        };
      }
      if (name === 'HeadObjectCommand') {
        return { ContentLength: 4 };
      }
      return {};
    }),
  };

  const noop = jest.fn();
  const mockMetadata = { MetadataProcessor: jest.fn() };
  const mockUsage = { IncrementUsage: noop };
  const mockList = {
    InvalidateDirectoryThumbnailCache: noop,
    InvalidateListCache: noop,
  };
  const mockRegistry = { GetHandlerByFormat: jest.fn() };
  const mockNotification = { EmitToUser: noop, EmitTransientToUser: noop };
  const mockRedis = { Get: noop, Set: noop, Delete: noop };
  const mockDirectory = {
    GetEncryptedFolderSet: jest.fn(async () => new Set<string>()),
    GetHiddenFolderSet: jest.fn(async () => new Set<string>()),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CloudArchiveService,
        { provide: RedisService, useValue: mockRedis },
        { provide: CloudS3Service, useValue: mockS3Service },
        { provide: CloudMetadataService, useValue: mockMetadata },
        { provide: CloudUsageService, useValue: mockUsage },
        { provide: CloudListService, useValue: mockList },
        { provide: ArchiveHandlerRegistry, useValue: mockRegistry },
        { provide: NotificationService, useValue: mockNotification },
        { provide: CloudDirectoryService, useValue: mockDirectory },
      ],
    }).compile();

    service = module.get<CloudArchiveService>(CloudArchiveService);
    priv = service as unknown as ArchivePrivate;
  });

  afterEach(() => {
    occupied.clear();
    listing.clear();
    jest.clearAllMocks();
  });

  const putKeys = () =>
    mockS3Service.Send.mock.calls
      .map(([c]) => c as S3Command)
      .filter((c) => c.constructor.name === 'PutObjectCommand')
      .map((c) => c.input.Key as string);

  // ── Extract conflict resolution — subfolder mode (createFolder=true) ────────
  describe('ResolveExtractTarget (new subfolder)', () => {
    it('uses the computed prefix when the target is free', async () => {
      const res = await priv.ResolveExtractTarget(
        'user-1',
        'docs/photos',
        ConflictResolutionStrategy.KEEP_BOTH,
        true,
      );
      expect(res.prefix).toBe('docs/photos');
      expect(res.plan).toEqual({ mode: 'overwrite' });
    });

    it('REPLACE overwrites the occupied prefix', async () => {
      occupied.add('user-1/docs/photos/');
      const res = await priv.ResolveExtractTarget(
        'user-1',
        'docs/photos',
        ConflictResolutionStrategy.REPLACE,
        true,
      );
      expect(res).toEqual({ prefix: 'docs/photos', plan: { mode: 'overwrite' } });
    });

    it('FAIL throws 409 when the target already exists', async () => {
      occupied.add('user-1/docs/photos/');
      await expect(
        priv.ResolveExtractTarget(
          'user-1',
          'docs/photos',
          ConflictResolutionStrategy.FAIL,
          true,
        ),
      ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });

    it('KEEP_BOTH retargets the next free "name (n)" sibling', async () => {
      occupied.add('user-1/docs/photos/');
      occupied.add('user-1/docs/photos (1)/');
      const res = await priv.ResolveExtractTarget(
        'user-1',
        'docs/photos',
        ConflictResolutionStrategy.KEEP_BOTH,
        true,
      );
      expect(res.prefix).toBe('docs/photos (2)');
      expect(res.plan).toEqual({ mode: 'overwrite' });
    });

    it('SKIP keeps the prefix and returns the pre-existing keys to skip', async () => {
      occupied.add('user-1/docs/photos/');
      listing.set('user-1/docs/photos/', ['user-1/docs/photos/a.txt']);
      const res = await priv.ResolveExtractTarget(
        'user-1',
        'docs/photos',
        ConflictResolutionStrategy.SKIP,
        true,
      );
      expect(res.prefix).toBe('docs/photos');
      expect(res.plan).toEqual({
        mode: 'skip',
        existing: new Set(['user-1/docs/photos/a.txt']),
      });
    });
  });

  // ── Extract conflict resolution — same-folder mode (createFolder=false) ─────
  describe('ResolveExtractTarget (same folder)', () => {
    it('REPLACE writes straight into the folder, overwriting', async () => {
      const res = await priv.ResolveExtractTarget(
        'user-1',
        'docs',
        ConflictResolutionStrategy.REPLACE,
        false,
      );
      expect(res).toEqual({ prefix: 'docs', plan: { mode: 'overwrite' } });
    });

    it('KEEP_BOTH degrades to a per-entry rename plan', async () => {
      listing.set('user-1/docs/', ['user-1/docs/a.txt']);
      const res = await priv.ResolveExtractTarget(
        'user-1',
        'docs',
        ConflictResolutionStrategy.KEEP_BOTH,
        false,
      );
      expect(res.prefix).toBe('docs');
      expect(res.plan).toMatchObject({
        mode: 'keepBoth',
        existing: new Set(['user-1/docs/a.txt']),
      });
    });

    it('FAIL degrades to a per-entry fail plan', async () => {
      listing.set('user-1/docs/', ['user-1/docs/a.txt']);
      const res = await priv.ResolveExtractTarget(
        'user-1',
        'docs',
        ConflictResolutionStrategy.FAIL,
        false,
      );
      expect(res.plan).toEqual({
        mode: 'fail',
        existing: new Set(['user-1/docs/a.txt']),
      });
    });
  });

  describe('UploadExtractedEntry', () => {
    it('skips a file whose key already exists (drains the stream)', async () => {
      const stream = { resume: jest.fn() } as unknown as Readable;
      await priv.UploadExtractedEntry(
        { Id: 'user-1' },
        'docs/photos',
        'a.txt',
        ArchiveEntryType.FILE,
        stream,
        4,
        { mode: 'skip', existing: new Set(['user-1/docs/photos/a.txt']) },
      );
      expect(putKeys()).toHaveLength(0);
      expect(mockMetadata.MetadataProcessor).not.toHaveBeenCalled();
      expect(
        (stream as unknown as { resume: jest.Mock }).resume,
      ).toHaveBeenCalled();
    });

    it('overwrite writes the file at its natural key', async () => {
      await priv.UploadExtractedEntry(
        { Id: 'user-1' },
        'docs/photos',
        'c.txt',
        ArchiveEntryType.FILE,
        Readable.from(['data']),
        4,
        { mode: 'overwrite' },
      );
      expect(putKeys()).toEqual(['user-1/docs/photos/c.txt']);
    });

    it('keepBoth renames a colliding file to "name (1).ext"', async () => {
      await priv.UploadExtractedEntry(
        { Id: 'user-1' },
        'docs',
        'a.txt',
        ArchiveEntryType.FILE,
        Readable.from(['data']),
        4,
        {
          mode: 'keepBoth',
          existing: new Set(['user-1/docs/a.txt']),
          claimed: new Set(),
        },
      );
      expect(putKeys()).toEqual(['user-1/docs/a (1).txt']);
    });

    it('fail throws when a file already exists', async () => {
      await expect(
        priv.UploadExtractedEntry(
          { Id: 'user-1' },
          'docs',
          'a.txt',
          ArchiveEntryType.FILE,
          Readable.from(['data']),
          4,
          { mode: 'fail', existing: new Set(['user-1/docs/a.txt']) },
        ),
      ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });
  });

  // ── Create secure-scoping parity (B2) ──────────────────────────────────────
  describe('ResolveCreateEntries secure-folder scoping', () => {
    beforeEach(() => {
      listing.set('user-1/Secret/', ['user-1/Secret/a.txt']);
    });

    it('excludes a hidden folder when the full (unscoped) set is used', async () => {
      const entries = await priv.ResolveCreateEntries(
        'user-1',
        ['Secret/'],
        'Secret',
        new Set<string>(),
        new Set<string>(['Secret']),
      );
      expect(entries).toHaveLength(0);
    });

    it('includes the navigated hidden folder when the scoped set is used', async () => {
      const entries = await priv.ResolveCreateEntries(
        'user-1',
        ['Secret/'],
        'Secret',
        new Set<string>(),
        new Set<string>(),
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].Key).toBe('user-1/Secret/a.txt');
    });
  });
});
