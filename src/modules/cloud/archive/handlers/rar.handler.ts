import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Readable } from 'stream';
import { ArchiveFormat, ArchiveEntryType, ArchivePhase } from '@common/enums';
import {
  ArchiveHandler,
  ArchiveEntry,
  ArchiveSafetyLimits,
  ArchiveExtractOptions,
  ArchiveExtractResult,
  ArchiveEntryCallback,
} from '../archive-handler.interface';
import { NormalizeArchiveEntryPath } from '../../cloud.utils';

@Injectable()
export class RarArchiveHandler implements ArchiveHandler {
  readonly Format: ArchiveFormat = ArchiveFormat.RAR;
  readonly Extensions = ['.rar'];
  readonly SupportsCreation = false;

  private readonly MaxBufferBytes = Math.max(
    1,
    parseInt(process.env.RAR_MAX_BUFFER_BYTES ?? `${256 * 1024 * 1024}`, 10),
  );

  private async CollectBuffer(
    stream: Readable,
    totalBytes: number,
  ): Promise<ArrayBuffer> {
    if (totalBytes > this.MaxBufferBytes) {
      throw new HttpException(
        `RAR file is too large for in-memory processing. Maximum: ${this.MaxBufferBytes} bytes.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const chunks: Buffer[] = [];
    let collected = 0;

    for await (const chunk of stream) {
      collected += chunk.length;
      if (collected > this.MaxBufferBytes) {
        throw new HttpException(
          `RAR file is too large for in-memory processing. Maximum: ${this.MaxBufferBytes} bytes.`,
          HttpStatus.BAD_REQUEST,
        );
      }
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
  }

  async ListEntries(
    stream: Readable,
    totalBytes: number,
    limits: ArchiveSafetyLimits,
  ): Promise<ArchiveEntry[]> {
    const { createExtractorFromData } = await import('node-unrar-js');
    const data = await this.CollectBuffer(stream, totalBytes);
    const extractor = await createExtractorFromData({ data });
    const fileList = extractor.getFileList();
    const entries: ArchiveEntry[] = [];

    const fileHeaders = [...fileList.fileHeaders];
    for (const header of fileHeaders) {
      if (entries.length >= limits.MaxEntries) {
        throw new HttpException(
          'Archive has too many entries.',
          HttpStatus.BAD_REQUEST,
        );
      }

      const normalizedPath = NormalizeArchiveEntryPath(header.name);
      if (!normalizedPath) continue;

      entries.push({
        Path: normalizedPath,
        Type: header.flags.directory
          ? ArchiveEntryType.DIRECTORY
          : ArchiveEntryType.FILE,
        Size: header.unpSize,
        CompressedSize: header.packSize,
        LastModified: header.time ? new Date(header.time) : undefined,
      });
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
    const { createExtractorFromData } = await import('node-unrar-js');
    const data = await this.CollectBuffer(stream, totalBytes);
    const extractor = await createExtractorFromData({ data });

    let filesToExtract: string[] | undefined;
    if (options?.SelectedEntries && options.SelectedEntries.size > 0) {
      filesToExtract = [...options.SelectedEntries];
    }

    const extracted = extractor.extract(
      filesToExtract ? { files: filesToExtract } : undefined,
    );

    let entriesProcessed = 0;
    let totalUncompressedBytes = 0;
    const files = [...extracted.files];

    for (const file of files) {
      if (options?.ShouldCancel) {
        await options.ShouldCancel();
      }

      const normalizedPath = NormalizeArchiveEntryPath(file.fileHeader.name);
      if (!normalizedPath) continue;

      if (
        options?.SelectedEntries &&
        !options.SelectedEntries.has(normalizedPath)
      ) {
        continue;
      }

      entriesProcessed += 1;
      if (entriesProcessed > limits.MaxEntries) {
        throw new HttpException(
          'Archive has too many entries.',
          HttpStatus.BAD_REQUEST,
        );
      }

      const entrySize = file.fileHeader.unpSize;
      if (entrySize > limits.MaxEntryBytes) {
        throw new HttpException(
          'Archive entry is too large.',
          HttpStatus.BAD_REQUEST,
        );
      }

      totalUncompressedBytes += entrySize;
      if (totalUncompressedBytes > limits.MaxTotalBytes) {
        throw new HttpException(
          'Archive is too large to extract.',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (
        totalBytes > 0 &&
        totalUncompressedBytes / totalBytes > limits.MaxCompressionRatio
      ) {
        throw new HttpException(
          'Archive compression ratio is too high.',
          HttpStatus.BAD_REQUEST,
        );
      }

      const isDirectory = file.fileHeader.flags.directory;

      const entryStream = isDirectory
        ? Readable.from([])
        : Readable.from(Buffer.from(file.extraction as Uint8Array));

      await onEntry({
        Path: normalizedPath,
        Type: isDirectory ? ArchiveEntryType.DIRECTORY : ArchiveEntryType.FILE,
        Size: entrySize,
        Stream: entryStream,
      });

      if (options?.OnProgress) {
        await options.OnProgress({
          Phase: ArchivePhase.EXTRACT,
          EntriesProcessed: entriesProcessed,
          TotalEntries: options?.SelectedEntries
            ? options.SelectedEntries.size
            : null,
          BytesRead: totalBytes,
          TotalBytes: totalBytes,
          CurrentEntry: normalizedPath,
        });
      }
    }

    return {
      TotalUncompressedBytes: totalUncompressedBytes,
      EntriesProcessed: entriesProcessed,
    };
  }
}
