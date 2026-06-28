import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PassThrough, Readable } from 'stream';
import * as unzipper from 'unzipper';
import * as archiver from 'archiver';
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
export class ZipArchiveHandler implements ArchiveHandler {
  readonly Format: ArchiveFormat = ArchiveFormat.ZIP;
  readonly Extensions = ['.zip'];
  readonly SupportsCreation = true;

  async ListEntries(
    stream: Readable,
    totalBytes: number,
    limits: ArchiveSafetyLimits,
  ): Promise<ArchiveEntry[]> {
    const entries: ArchiveEntry[] = [];
    const parser = stream.pipe(unzipper.Parse({ forceStream: true }));

    for await (const entry of parser) {
      if (entries.length >= limits.MaxEntries) {
        entry.autodrain();
        throw new HttpException(
          'Archive has too many entries.',
          HttpStatus.BAD_REQUEST,
        );
      }

      const normalizedPath = NormalizeArchiveEntryPath(entry.path);
      if (!normalizedPath) {
        entry.autodrain();
        continue;
      }

      const uncompressedSize = Number(
        (entry as { vars?: { uncompressedSize?: number } }).vars
          ?.uncompressedSize ?? 0,
      );

      entries.push({
        Path: normalizedPath,
        Type:
          entry.type === 'Directory'
            ? ArchiveEntryType.DIRECTORY
            : ArchiveEntryType.FILE,
        Size: uncompressedSize,
        CompressedSize: Number(
          (entry as { vars?: { compressedSize?: number } }).vars
            ?.compressedSize ?? 0,
        ),
      });

      entry.autodrain();
    }

    return entries;
  }

  async Extract(
    stream: Readable,
    totalBytes: number,
    limits: ArchiveSafetyLimits,
    onEntry: ArchiveEntryCallback,
    options?: ArchiveExtractOptions,
  ): Promise<ArchiveExtractResult> {
    const countingStream = new PassThrough();
    let bytesRead = 0;
    countingStream.on('data', (chunk: Buffer) => {
      bytesRead += chunk.length;
    });

    const parser = stream
      .pipe(countingStream)
      .pipe(unzipper.Parse({ forceStream: true }));

    let entriesProcessed = 0;
    let totalUncompressedBytes = 0;

    const reportProgress = async (currentEntry?: string) => {
      if (!options?.OnProgress) return;
      await options.OnProgress({
        Phase: ArchivePhase.EXTRACT,
        EntriesProcessed: entriesProcessed,
        TotalEntries: options?.SelectedEntries
          ? options.SelectedEntries.size
          : null,
        BytesRead: bytesRead,
        TotalBytes: totalBytes,
        CurrentEntry: currentEntry,
      });
    };

    for await (const entry of parser) {
      if (options?.ShouldCancel) {
        const cancelled = await options.ShouldCancel();
        if (cancelled) {
          entry.autodrain();
        }
      }

      const normalizedPath = NormalizeArchiveEntryPath(entry.path);
      if (!normalizedPath) {
        entry.autodrain();
        continue;
      }

      if (
        options?.SelectedEntries &&
        !options.SelectedEntries.has(normalizedPath)
      ) {
        entry.autodrain();
        continue;
      }

      entriesProcessed += 1;
      if (entriesProcessed > limits.MaxEntries) {
        entry.autodrain();
        throw new HttpException(
          'Archive has too many entries.',
          HttpStatus.BAD_REQUEST,
        );
      }

      const entryUncompressedSize = Number(
        (entry as { vars?: { uncompressedSize?: number } }).vars
          ?.uncompressedSize ?? 0,
      );

      if (entryUncompressedSize > limits.MaxEntryBytes) {
        entry.autodrain();
        throw new HttpException(
          'Archive entry is too large.',
          HttpStatus.BAD_REQUEST,
        );
      }

      totalUncompressedBytes += entryUncompressedSize;
      if (totalUncompressedBytes > limits.MaxTotalBytes) {
        entry.autodrain();
        throw new HttpException(
          'Archive is too large to extract.',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (
        totalBytes > 0 &&
        totalUncompressedBytes / totalBytes > limits.MaxCompressionRatio
      ) {
        entry.autodrain();
        throw new HttpException(
          'Archive compression ratio is too high.',
          HttpStatus.BAD_REQUEST,
        );
      }

      const isDirectory = entry.type === 'Directory';

      await onEntry({
        Path: normalizedPath,
        Type: isDirectory ? ArchiveEntryType.DIRECTORY : ArchiveEntryType.FILE,
        Size: entryUncompressedSize,
        Stream: isDirectory ? Readable.from([]) : entry,
      });

      if (isDirectory) {
        entry.autodrain();
      }

      await reportProgress(normalizedPath);
    }

    await reportProgress();

    return {
      TotalUncompressedBytes: totalUncompressedBytes,
      EntriesProcessed: entriesProcessed,
    };
  }

  async Create(
    entries: ArchiveCreateEntry[],
    getStream: ArchiveCreateGetStream,
    output: PassThrough,
    options?: ArchiveCreateOptions,
  ): Promise<void> {
    const archive = archiver.create('zip', { zlib: { level: 6 } });

    archive.on('error', (err) => {
      output.destroy(err);
    });

    archive.pipe(output);

    let entriesProcessed = 0;
    let bytesWritten = 0;

    archive.on('progress', (progress) => {
      bytesWritten = progress.fs.processedBytes;
    });

    for (const entry of entries) {
      if (options?.ShouldCancel) {
        const cancelled = await options.ShouldCancel();
        if (cancelled) {
          archive.abort();
          throw new Error('Archive creation cancelled.');
        }
      }

      const readable = await getStream(entry.Key);
      archive.append(readable, { name: entry.Name });

      entriesProcessed += 1;
      if (options?.OnProgress) {
        await options.OnProgress({
          Phase: ArchivePhase.CREATE,
          EntriesProcessed: entriesProcessed,
          TotalEntries: entries.length,
          BytesWritten: bytesWritten,
          CurrentEntry: entry.Name,
        });
      }
    }

    await archive.finalize();
  }
}
