import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PassThrough, Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as tar from 'tar-stream';
import { createGunzip, createGzip } from 'zlib';
import { ArchiveFormat, ArchiveEntryType, ArchivePhase } from '@common/enums';
import {
  ArchiveHandler,
  ArchiveEntry,
  ArchiveSafetyLimits,
  ArchiveExtractOptions,
  ArchiveExtractResult,
  ArchiveEntryCallback,
  ArchiveCreateEntry,
  ArchiveCreateGetStream,
  ArchiveCreateOptions,
} from '../archive-handler.interface';
import { NormalizeArchiveEntryPath } from '../../cloud.utils';

@Injectable()
export class TarArchiveHandler implements ArchiveHandler {
  readonly Format: ArchiveFormat;
  readonly Extensions: string[];
  readonly SupportsCreation = true;

  private readonly Compressed: boolean;

  constructor(compressed: boolean) {
    this.Compressed = compressed;
    if (compressed) {
      this.Format = ArchiveFormat.TAR_GZ;
      this.Extensions = ['.tar.gz', '.tgz'];
    } else {
      this.Format = ArchiveFormat.TAR;
      this.Extensions = ['.tar'];
    }
  }

  async ListEntries(
    stream: Readable,
    totalBytes: number,
    limits: ArchiveSafetyLimits,
  ): Promise<ArchiveEntry[]> {
    const entries: ArchiveEntry[] = [];

    return new Promise<ArchiveEntry[]>((resolve, reject) => {
      const extract = tar.extract();

      extract.on('entry', (header, entryStream, next) => {
        if (entries.length >= limits.MaxEntries) {
          entryStream.resume();
          reject(
            new HttpException(
              'Archive has too many entries.',
              HttpStatus.BAD_REQUEST,
            ),
          );
          return;
        }

        const normalizedPath = NormalizeArchiveEntryPath(header.name);
        if (normalizedPath) {
          entries.push({
            Path: normalizedPath,
            Type:
              header.type === 'directory'
                ? ArchiveEntryType.DIRECTORY
                : ArchiveEntryType.FILE,
            Size: header.size ?? 0,
            LastModified: header.mtime ?? undefined,
          });
        }

        entryStream.resume();
        next();
      });

      extract.on('finish', () => resolve(entries));
      extract.on('error', reject);

      const source = this.Compressed ? stream.pipe(createGunzip()) : stream;

      source.pipe(extract);
      source.on('error', reject);
    });
  }

  async Extract(
    stream: Readable,
    totalBytes: number,
    limits: ArchiveSafetyLimits,
    onEntry: ArchiveEntryCallback,
    options?: ArchiveExtractOptions,
  ): Promise<ArchiveExtractResult> {
    let entriesProcessed = 0;
    let totalUncompressedBytes = 0;
    let bytesRead = 0;

    const countingStream = new PassThrough();
    countingStream.on('data', (chunk: Buffer) => {
      bytesRead += chunk.length;
    });

    return new Promise<ArchiveExtractResult>((resolve, reject) => {
      const extract = tar.extract();

      extract.on('entry', async (header, entryStream, next) => {
        try {
          if (options?.ShouldCancel) {
            const cancelled = await options.ShouldCancel();
            if (cancelled) {
              entryStream.resume();
              return;
            }
          }

          const normalizedPath = NormalizeArchiveEntryPath(header.name);
          if (!normalizedPath) {
            entryStream.resume();
            next();
            return;
          }

          if (
            options?.SelectedEntries &&
            !options.SelectedEntries.has(normalizedPath)
          ) {
            entryStream.resume();
            next();
            return;
          }

          entriesProcessed += 1;
          if (entriesProcessed > limits.MaxEntries) {
            entryStream.resume();
            reject(
              new HttpException(
                'Archive has too many entries.',
                HttpStatus.BAD_REQUEST,
              ),
            );
            return;
          }

          const entrySize = header.size ?? 0;
          if (entrySize > limits.MaxEntryBytes) {
            entryStream.resume();
            reject(
              new HttpException(
                'Archive entry is too large.',
                HttpStatus.BAD_REQUEST,
              ),
            );
            return;
          }

          totalUncompressedBytes += entrySize;
          if (totalUncompressedBytes > limits.MaxTotalBytes) {
            entryStream.resume();
            reject(
              new HttpException(
                'Archive is too large to extract.',
                HttpStatus.BAD_REQUEST,
              ),
            );
            return;
          }

          if (
            totalBytes > 0 &&
            totalUncompressedBytes / totalBytes > limits.MaxCompressionRatio
          ) {
            entryStream.resume();
            reject(
              new HttpException(
                'Archive compression ratio is too high.',
                HttpStatus.BAD_REQUEST,
              ),
            );
            return;
          }

          const isDirectory = header.type === 'directory';

          await onEntry({
            Path: normalizedPath,
            Type: isDirectory
              ? ArchiveEntryType.DIRECTORY
              : ArchiveEntryType.FILE,
            Size: entrySize,
            Stream: isDirectory ? Readable.from([]) : entryStream,
          });

          if (isDirectory) {
            entryStream.resume();
          }

          if (options?.OnProgress) {
            await options.OnProgress({
              Phase: ArchivePhase.EXTRACT,
              EntriesProcessed: entriesProcessed,
              TotalEntries: options?.SelectedEntries
                ? options.SelectedEntries.size
                : null,
              BytesRead: bytesRead,
              TotalBytes: totalBytes,
              CurrentEntry: normalizedPath,
            });
          }

          next();
        } catch (error) {
          reject(error);
        }
      });

      extract.on('finish', () => {
        resolve({
          TotalUncompressedBytes: totalUncompressedBytes,
          EntriesProcessed: entriesProcessed,
        });
      });

      extract.on('error', reject);

      const source = this.Compressed
        ? stream.pipe(countingStream).pipe(createGunzip())
        : stream.pipe(countingStream);

      source.pipe(extract);
      source.on('error', reject);
    });
  }

  async Create(
    entries: ArchiveCreateEntry[],
    getStream: ArchiveCreateGetStream,
    output: PassThrough,
    options?: ArchiveCreateOptions,
  ): Promise<void> {
    const pack = tar.pack();

    if (this.Compressed) {
      const gzip = createGzip();
      pack.pipe(gzip).pipe(output);
    } else {
      pack.pipe(output);
    }

    let entriesProcessed = 0;

    for (const entry of entries) {
      if (options?.ShouldCancel) {
        const cancelled = await options.ShouldCancel();
        if (cancelled) {
          pack.destroy();
          throw new Error('Archive creation cancelled.');
        }
      }

      const readable = await getStream(entry.Key);
      const tarEntry = pack.entry({ name: entry.Name, size: entry.Size });

      await pipeline(readable, tarEntry);

      entriesProcessed += 1;
      if (options?.OnProgress) {
        await options.OnProgress({
          Phase: ArchivePhase.CREATE,
          EntriesProcessed: entriesProcessed,
          TotalEntries: entries.length,
          BytesWritten: 0,
          CurrentEntry: entry.Name,
        });
      }
    }

    pack.finalize();
  }
}
