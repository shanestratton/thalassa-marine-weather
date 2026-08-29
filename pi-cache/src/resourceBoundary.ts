import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

export const PI_ARCHIVE_REJECTED_CODE = 'PI_ARCHIVE_REJECTED';
export const PI_DOWNLOAD_TOO_LARGE_CODE = 'PI_DOWNLOAD_TOO_LARGE';
export const PI_DISK_SPACE_LOW_CODE = 'PI_DISK_SPACE_LOW';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;
const ZIP_UINT16_MAX = 0xffff;
const ZIP_UINT32_MAX = 0xffffffff;
const MAX_EOCD_SEARCH_BYTES = ZIP_UINT16_MAX + 22;

export interface ArchivePolicy {
    maxArchiveBytes: number;
    maxFiles: number;
    maxEntries: number;
    maxEntryBytes: number;
    maxUncompressedBytes: number;
    maxPathDepth: number;
    maxNameBytes: number;
    maxCentralDirectoryBytes: number;
    maxCompressionRatio: number;
    minimumFreeBytes: number;
}

/**
 * Sized for a real commercial vector chart set, not a single S-57 cell.
 *
 * The original envelope (300 MiB, 4 096 files) fitted a handful of `.000`
 * cells and nothing else. Measured against the o-charts Australian base set on
 * 2026-08-30 — `oeuSENC-AU-2026-1-31-base-sgl001FECD2.zip` — it was short on
 * three counts at once: the archive is 707 MB against a 300 MiB cap, and it
 * holds 5 020 entries against caps of 4 096 files and 4 608 entries. The
 * installer would have refused it AFTER the download finished.
 *
 * The raised numbers are CHARTWORLD_ARCHIVE_POLICY's, not invented ones. That
 * envelope is already in production for ChartWorld S-63 distributions, which
 * are the same class of payload — a large, commercially issued, encrypted
 * vector chart set — so this adopts a reviewed limit rather than minting one.
 *
 * What is NOT loosened, deliberately: maxEntryBytes stays at 256 MiB, because
 * an individual chart cell is kilobytes to a few megabytes and there is no
 * evidence for a bigger one; and maxCompressionRatio stays at 1 000, which
 * with maxUncompressedBytes is the actual zip-bomb guard. Archive size and
 * entry count bound bandwidth and disk, not decompression, so raising them
 * does not weaken what the ratio protects against.
 */
export const ENC_ARCHIVE_POLICY: Readonly<ArchivePolicy> = Object.freeze({
    maxArchiveBytes: 1 * GIB,
    maxFiles: 8_192,
    maxEntries: 9_216,
    maxEntryBytes: 256 * MIB,
    maxUncompressedBytes: 2 * GIB,
    maxPathDepth: 8,
    maxNameBytes: 512,
    maxCentralDirectoryBytes: 32 * MIB,
    maxCompressionRatio: 1_000,
    minimumFreeBytes: 512 * MIB,
});

export const CHART_ARCHIVE_POLICY: Readonly<ArchivePolicy> = Object.freeze({
    maxArchiveBytes: 2 * GIB,
    maxFiles: 8_192,
    maxEntries: 9_216,
    maxEntryBytes: 2 * GIB,
    maxUncompressedBytes: 4 * GIB,
    maxPathDepth: 8,
    maxNameBytes: 512,
    maxCentralDirectoryBytes: 64 * MIB,
    maxCompressionRatio: 1_000,
    minimumFreeBytes: 512 * MIB,
});

export const CHARTWORLD_ARCHIVE_POLICY: Readonly<ArchivePolicy> = Object.freeze({
    maxArchiveBytes: 1 * GIB,
    maxFiles: 8_192,
    maxEntries: 9_216,
    maxEntryBytes: 512 * MIB,
    maxUncompressedBytes: 2 * GIB,
    maxPathDepth: 8,
    maxNameBytes: 512,
    maxCentralDirectoryBytes: 64 * MIB,
    maxCompressionRatio: 1_000,
    minimumFreeBytes: 512 * MIB,
});

export interface DownloadPolicy {
    maxBytes: number;
    minimumFreeBytes: number;
    diskCheckIntervalBytes: number;
}

export const ENC_DOWNLOAD_POLICY: Readonly<DownloadPolicy> = Object.freeze({
    maxBytes: 300 * MIB,
    minimumFreeBytes: 512 * MIB,
    diskCheckIntervalBytes: 16 * MIB,
});

export const CHART_DOWNLOAD_POLICY: Readonly<DownloadPolicy> = Object.freeze({
    maxBytes: 2 * GIB,
    minimumFreeBytes: 512 * MIB,
    diskCheckIntervalBytes: 16 * MIB,
});

export const CHARTWORLD_DOWNLOAD_POLICY: Readonly<DownloadPolicy> = Object.freeze({
    maxBytes: 1 * GIB,
    minimumFreeBytes: 512 * MIB,
    diskCheckIntervalBytes: 16 * MIB,
});

export class PiResourceBoundaryError extends Error {
    constructor(
        message: string,
        readonly code:
            | typeof PI_ARCHIVE_REJECTED_CODE
            | typeof PI_DOWNLOAD_TOO_LARGE_CODE
            | typeof PI_DISK_SPACE_LOW_CODE,
        readonly status: 413 | 507,
    ) {
        super(message);
        this.name = 'PiResourceBoundaryError';
    }
}

export interface SafeZipEntry {
    name: string;
    pathSegments: string[];
    isDirectory: boolean;
    compressedSize: number;
    uncompressedSize: number;
    compressionMethod: 0 | 8;
    crc32: number;
    flags: number;
    localHeaderOffset: number;
    dataOffset: number;
}

export interface SafeZipInspection {
    archiveBytes: number;
    fileCount: number;
    uncompressedBytes: number;
    entries: SafeZipEntry[];
}

interface CentralDirectoryLocation {
    entryCount: number;
    offset: number;
    size: number;
}

function archiveError(message: string): PiResourceBoundaryError {
    return new PiResourceBoundaryError(message, PI_ARCHIVE_REJECTED_CODE, 413);
}

function hasControlCharacter(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code < 32 || code === 127) return true;
    }
    return false;
}

function diskSpaceError(minimumFreeBytes: number): PiResourceBoundaryError {
    return new PiResourceBoundaryError(
        `Insufficient free disk space; ${minimumFreeBytes.toLocaleString('en-US')} bytes must remain free`,
        PI_DISK_SPACE_LOW_CODE,
        507,
    );
}

function safeNumber(value: bigint, label: string): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw archiveError(`${label} is outside the supported range`);
    return Number(value);
}

async function readExactly(file: fs.FileHandle, position: number, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
        const { bytesRead } = await file.read(buffer, total, length - total, position + total);
        if (bytesRead === 0) throw archiveError('ZIP structure is truncated');
        total += bytesRead;
    }
    return buffer;
}

function findEndRecord(buffer: Buffer): number {
    for (let offset = buffer.length - 22; offset >= 0; offset--) {
        if (buffer.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) continue;
        const commentLength = buffer.readUInt16LE(offset + 20);
        if (offset + 22 + commentLength === buffer.length) return offset;
    }
    return -1;
}

async function locateCentralDirectory(
    file: fs.FileHandle,
    archiveBytes: number,
    policy: ArchivePolicy,
): Promise<CentralDirectoryLocation> {
    const tailLength = Math.min(archiveBytes, MAX_EOCD_SEARCH_BYTES);
    const tailStart = archiveBytes - tailLength;
    const tail = await readExactly(file, tailStart, tailLength);
    const eocdInTail = findEndRecord(tail);
    if (eocdInTail < 0 || eocdInTail + 22 > tail.length) throw archiveError('ZIP end record is missing');
    const eocdOffset = tailStart + eocdInTail;
    const eocd = tail.subarray(eocdInTail);
    const disk = eocd.readUInt16LE(4);
    const centralDisk = eocd.readUInt16LE(6);
    const diskEntries = eocd.readUInt16LE(8);
    let entryCount = eocd.readUInt16LE(10);
    let centralSize = eocd.readUInt32LE(12);
    let centralOffset = eocd.readUInt32LE(16);
    const commentLength = eocd.readUInt16LE(20);
    if (eocdInTail + 22 + commentLength > tail.length) throw archiveError('ZIP comment is truncated');
    if (
        disk !== 0 ||
        centralDisk !== 0 ||
        (diskEntries !== ZIP_UINT16_MAX && entryCount !== ZIP_UINT16_MAX && diskEntries !== entryCount)
    ) {
        throw archiveError('Multi-disk and spanned ZIP archives are not supported');
    }

    const needsZip64 =
        diskEntries === ZIP_UINT16_MAX ||
        entryCount === ZIP_UINT16_MAX ||
        centralSize === ZIP_UINT32_MAX ||
        centralOffset === ZIP_UINT32_MAX;
    if (needsZip64) {
        if (eocdOffset < 20) throw archiveError('ZIP64 locator is missing');
        const locator = await readExactly(file, eocdOffset - 20, 20);
        if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) throw archiveError('ZIP64 locator is missing');
        if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
            throw archiveError('Multi-disk ZIP64 archives are not supported');
        }
        const zip64Offset = safeNumber(locator.readBigUInt64LE(8), 'ZIP64 end offset');
        const zip64 = await readExactly(file, zip64Offset, 56);
        if (zip64.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) throw archiveError('ZIP64 end record is missing');
        if (zip64.readUInt32LE(16) !== 0 || zip64.readUInt32LE(20) !== 0) {
            throw archiveError('Multi-disk ZIP64 archives are not supported');
        }
        const entriesOnDisk = safeNumber(zip64.readBigUInt64LE(24), 'ZIP64 entry count');
        entryCount = safeNumber(zip64.readBigUInt64LE(32), 'ZIP64 entry count');
        if (entriesOnDisk !== entryCount) throw archiveError('Multi-disk ZIP64 archives are not supported');
        centralSize = safeNumber(zip64.readBigUInt64LE(40), 'ZIP64 central directory size');
        centralOffset = safeNumber(zip64.readBigUInt64LE(48), 'ZIP64 central directory offset');
    }

    if (entryCount > policy.maxEntries) {
        throw archiveError(`ZIP exceeds the ${policy.maxEntries.toLocaleString('en-US')}-entry limit`);
    }
    if (centralSize > policy.maxCentralDirectoryBytes) throw archiveError('ZIP central directory is too large');
    if (centralOffset < 0 || centralSize < 0 || centralOffset + centralSize > archiveBytes) {
        throw archiveError('ZIP central directory is outside the archive');
    }
    return { entryCount, offset: centralOffset, size: centralSize };
}

function readZip64Values(
    extra: Buffer,
    needs: { uncompressed: boolean; compressed: boolean; offset: boolean; disk: boolean },
): Partial<{ uncompressed: number; compressed: number; offset: number; disk: number }> {
    let cursor = 0;
    while (cursor + 4 <= extra.length) {
        const id = extra.readUInt16LE(cursor);
        const length = extra.readUInt16LE(cursor + 2);
        const valueStart = cursor + 4;
        const valueEnd = valueStart + length;
        if (valueEnd > extra.length) throw archiveError('ZIP extra field is truncated');
        if (id === ZIP64_EXTRA_ID) {
            let valueCursor = valueStart;
            const values: Partial<{ uncompressed: number; compressed: number; offset: number; disk: number }> = {};
            const take64 = (label: string): number => {
                if (valueCursor + 8 > valueEnd) throw archiveError('ZIP64 extra field is truncated');
                const value = safeNumber(extra.readBigUInt64LE(valueCursor), label);
                valueCursor += 8;
                return value;
            };
            if (needs.uncompressed) values.uncompressed = take64('ZIP64 uncompressed size');
            if (needs.compressed) values.compressed = take64('ZIP64 compressed size');
            if (needs.offset) values.offset = take64('ZIP64 local header offset');
            if (needs.disk) {
                if (valueCursor + 4 > valueEnd) throw archiveError('ZIP64 disk field is truncated');
                values.disk = extra.readUInt32LE(valueCursor);
            }
            return values;
        }
        cursor = valueEnd;
    }
    return {};
}

function validateEntryPath(
    rawName: Buffer,
    flags: number,
    policy: ArchivePolicy,
): {
    name: string;
    pathSegments: string[];
    isDirectory: boolean;
} {
    if (rawName.length === 0 || rawName.length > policy.maxNameBytes) throw archiveError('ZIP entry name is invalid');
    const name = rawName.toString(flags & 0x0800 ? 'utf8' : 'latin1');
    if (!name || hasControlCharacter(name)) throw archiveError('ZIP entry name is invalid');
    const normalized = name.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
        throw archiveError(`ZIP entry uses an absolute path: ${name}`);
    }
    const isDirectory = normalized.endsWith('/');
    const pathSegments = normalized
        .split('/')
        .filter((segment, index, all) => (isDirectory && index === all.length - 1 ? false : true));
    if (
        pathSegments.length === 0 ||
        pathSegments.length > policy.maxPathDepth ||
        pathSegments.some((segment) => !segment || segment === '.' || segment === '..')
    ) {
        throw archiveError(`ZIP entry path is unsafe or too deeply nested: ${name}`);
    }
    return { name, pathSegments, isDirectory };
}

function unixEntryType(madeBy: number, externalAttributes: number): number | null {
    const hostSystem = (madeBy >>> 8) & 0xff;
    if (hostSystem !== 3 && hostSystem !== 19) return null;
    return (externalAttributes >>> 16) & 0xffff & 0o170000;
}

function packedEntryType(externalAttributes: number): number {
    return (externalAttributes >>> 16) & 0xffff & 0o170000;
}

async function resolveEntryDataOffset(file: fs.FileHandle, entry: Omit<SafeZipEntry, 'dataOffset'>): Promise<number> {
    const local = await readExactly(file, entry.localHeaderOffset, 30);
    if (local.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) throw archiveError('ZIP local header is missing');
    const localFlags = local.readUInt16LE(6);
    const localMethod = local.readUInt16LE(8);
    const nameLength = local.readUInt16LE(26);
    const extraLength = local.readUInt16LE(28);
    if ((localFlags & 0x0841) !== (entry.flags & 0x0841) || localMethod !== entry.compressionMethod) {
        throw archiveError('ZIP local and central headers disagree');
    }
    return entry.localHeaderOffset + 30 + nameLength + extraLength;
}

/** Inspect every central-directory record before any entry is inflated. */
export async function inspectZipArchive(
    archivePath: string,
    policy: Readonly<ArchivePolicy>,
): Promise<SafeZipInspection> {
    const archiveStat = await fs.lstat(archivePath);
    if (!archiveStat.isFile()) throw archiveError('Archive path is not a regular file');
    if (archiveStat.size <= 0 || archiveStat.size > policy.maxArchiveBytes) {
        throw archiveError(`Archive exceeds the ${policy.maxArchiveBytes.toLocaleString('en-US')}-byte limit`);
    }

    const file = await fs.open(archivePath, 'r');
    try {
        const centralLocation = await locateCentralDirectory(file, archiveStat.size, policy);
        const central = await readExactly(file, centralLocation.offset, centralLocation.size);
        const entries: SafeZipEntry[] = [];
        const uniquePaths = new Set<string>();
        let cursor = 0;
        let fileCount = 0;
        let uncompressedBytes = 0;

        for (let index = 0; index < centralLocation.entryCount; index++) {
            if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
                throw archiveError('ZIP central directory entry is malformed');
            }
            const madeBy = central.readUInt16LE(cursor + 4);
            const flags = central.readUInt16LE(cursor + 8);
            const method = central.readUInt16LE(cursor + 10);
            const crc32 = central.readUInt32LE(cursor + 16);
            let compressedSize = central.readUInt32LE(cursor + 20);
            let uncompressedSize = central.readUInt32LE(cursor + 24);
            const nameLength = central.readUInt16LE(cursor + 28);
            const extraLength = central.readUInt16LE(cursor + 30);
            const commentLength = central.readUInt16LE(cursor + 32);
            let diskStart = central.readUInt16LE(cursor + 34);
            const externalAttributes = central.readUInt32LE(cursor + 38);
            let localHeaderOffset = central.readUInt32LE(cursor + 42);
            const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
            if (recordEnd > central.length) throw archiveError('ZIP central directory entry is truncated');
            const rawName = central.subarray(cursor + 46, cursor + 46 + nameLength);
            const extra = central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
            const zip64 = readZip64Values(extra, {
                uncompressed: uncompressedSize === ZIP_UINT32_MAX,
                compressed: compressedSize === ZIP_UINT32_MAX,
                offset: localHeaderOffset === ZIP_UINT32_MAX,
                disk: diskStart === ZIP_UINT16_MAX,
            });
            if (uncompressedSize === ZIP_UINT32_MAX) {
                if (zip64.uncompressed === undefined) throw archiveError('ZIP64 uncompressed size is missing');
                uncompressedSize = zip64.uncompressed;
            }
            if (compressedSize === ZIP_UINT32_MAX) {
                if (zip64.compressed === undefined) throw archiveError('ZIP64 compressed size is missing');
                compressedSize = zip64.compressed;
            }
            if (localHeaderOffset === ZIP_UINT32_MAX) {
                if (zip64.offset === undefined) throw archiveError('ZIP64 local header offset is missing');
                localHeaderOffset = zip64.offset;
            }
            if (diskStart === ZIP_UINT16_MAX) {
                if (zip64.disk === undefined) throw archiveError('ZIP64 disk field is missing');
                diskStart = zip64.disk;
            }
            if (diskStart !== 0) throw archiveError('Multi-disk ZIP entries are not supported');
            if ((flags & 0x0041) !== 0) throw archiveError('Encrypted ZIP entries are not supported');
            if (method !== 0 && method !== 8) throw archiveError(`ZIP compression method ${method} is not supported`);

            const entryPath = validateEntryPath(rawName, flags, policy);
            const entryType = unixEntryType(madeBy, externalAttributes);
            const packedType = packedEntryType(externalAttributes);
            if (packedType !== 0 && packedType !== 0o040000 && packedType !== 0o100000) {
                throw archiveError(`ZIP contains a symlink or special file: ${entryPath.name}`);
            }
            if (entryType === 0o040000 && !entryPath.isDirectory) {
                throw archiveError(`ZIP directory metadata is inconsistent: ${entryPath.name}`);
            }
            if (entryType === 0o100000 && entryPath.isDirectory) {
                throw archiveError(`ZIP file metadata is inconsistent: ${entryPath.name}`);
            }
            const dosAttributes = externalAttributes & 0xff;
            if ((dosAttributes & 0x08) !== 0)
                throw archiveError(`ZIP contains a special volume entry: ${entryPath.name}`);

            const pathKey = entryPath.pathSegments.join('/').toLowerCase();
            if (uniquePaths.has(pathKey)) throw archiveError(`ZIP contains a duplicate path: ${entryPath.name}`);
            uniquePaths.add(pathKey);

            if (entryPath.isDirectory) {
                if (compressedSize !== 0 || uncompressedSize !== 0) {
                    throw archiveError(`ZIP directory contains data: ${entryPath.name}`);
                }
            } else {
                fileCount++;
                if (fileCount > policy.maxFiles) {
                    throw archiveError(`ZIP exceeds the ${policy.maxFiles.toLocaleString('en-US')}-file limit`);
                }
                if (uncompressedSize > policy.maxEntryBytes) {
                    throw archiveError(
                        `ZIP entry exceeds the ${policy.maxEntryBytes.toLocaleString('en-US')}-byte limit: ${entryPath.name}`,
                    );
                }
                if (
                    uncompressedSize > 16 * MIB &&
                    uncompressedSize > Math.max(1, compressedSize) * policy.maxCompressionRatio
                ) {
                    throw archiveError(`ZIP entry has an unsafe compression ratio: ${entryPath.name}`);
                }
                if (uncompressedBytes > policy.maxUncompressedBytes - uncompressedSize) {
                    throw archiveError(
                        `ZIP exceeds the ${policy.maxUncompressedBytes.toLocaleString('en-US')}-byte expanded limit`,
                    );
                }
                uncompressedBytes += uncompressedSize;
            }

            const withoutOffset: Omit<SafeZipEntry, 'dataOffset'> = {
                ...entryPath,
                compressedSize,
                uncompressedSize,
                compressionMethod: method,
                crc32,
                flags,
                localHeaderOffset,
            };
            const dataOffset = await resolveEntryDataOffset(file, withoutOffset);
            if (dataOffset < 0 || dataOffset + compressedSize > centralLocation.offset) {
                throw archiveError(`ZIP entry data is outside the archive: ${entryPath.name}`);
            }
            entries.push({ ...withoutOffset, dataOffset });
            cursor = recordEnd;
        }

        return { archiveBytes: archiveStat.size, fileCount, uncompressedBytes, entries };
    } finally {
        await file.close();
    }
}

const CRC32_TABLE = new Uint32Array(256);
for (let value = 0; value < CRC32_TABLE.length; value++) {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    CRC32_TABLE[value] = crc >>> 0;
}

class EntryIntegrityTransform extends Transform {
    private bytes = 0;
    private crc = 0xffffffff;

    constructor(private readonly entry: SafeZipEntry) {
        super();
    }

    override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
        this.bytes += chunk.length;
        if (this.bytes > this.entry.uncompressedSize) {
            callback(archiveError(`ZIP entry expanded beyond its declared size: ${this.entry.name}`));
            return;
        }
        for (const byte of chunk) this.crc = CRC32_TABLE[(this.crc ^ byte) & 0xff] ^ (this.crc >>> 8);
        callback(null, chunk);
    }

    override _flush(callback: TransformCallback): void {
        const crc = (this.crc ^ 0xffffffff) >>> 0;
        if (this.bytes !== this.entry.uncompressedSize || crc !== this.entry.crc32) {
            callback(archiveError(`ZIP entry failed size or CRC verification: ${this.entry.name}`));
            return;
        }
        callback();
    }
}

export interface ExtractZipOptions {
    select?: (entry: SafeZipEntry) => boolean;
    /** Map an entry to a safe relative output path, or null to skip it. */
    outputName?: (entry: SafeZipEntry) => string | null;
    /** Creation mode for extracted files; private by default. */
    fileMode?: number;
}

/**
 * Inflate validated entries through bounded streams into a private staging
 * directory, then move complete files into the destination. No entry-sized
 * Buffer is ever allocated.
 */
export async function extractZipArchive(
    archivePath: string,
    destinationDir: string,
    policy: Readonly<ArchivePolicy>,
    options: ExtractZipOptions = {},
): Promise<{ inspection: SafeZipInspection; files: string[] }> {
    const inspection = await inspectZipArchive(archivePath, policy);
    await fs.mkdir(destinationDir, { recursive: true });
    const selectedEntries = inspection.entries.filter(
        (entry) => !entry.isDirectory && (!options.select || options.select(entry)),
    );
    const selectedEntrySet = new Set(selectedEntries);
    const selectedUncompressedBytes = selectedEntries.reduce((total, entry) => total + entry.uncompressedSize, 0);
    const free = await availableBytes(destinationDir);
    if (free < selectedUncompressedBytes + policy.minimumFreeBytes) {
        throw diskSpaceError(policy.minimumFreeBytes);
    }
    const stagingDir = await fs.mkdtemp(path.join(destinationDir, '.thalassa-extract-'));
    const staged: Array<{ temporaryPath: string; relativePath: string }> = [];
    const outputNames = new Set<string>();
    let preserveStaging = false;
    try {
        for (const entry of inspection.entries) {
            if (!selectedEntrySet.has(entry)) continue;
            const relativePath = options.outputName?.(entry) ?? entry.pathSegments.join(path.sep);
            if (relativePath === null) continue;
            const checked = validateEntryPath(Buffer.from(relativePath, 'utf8'), 0x0800, policy);
            if (checked.isDirectory) throw archiveError('Archive output mapping produced a directory');
            const canonicalRelative = checked.pathSegments.join(path.sep);
            const outputKey = canonicalRelative.toLowerCase();
            if (outputNames.has(outputKey)) throw archiveError(`Archive maps multiple files to ${relativePath}`);
            outputNames.add(outputKey);
            const temporaryPath = path.join(stagingDir, canonicalRelative);
            await fs.mkdir(path.dirname(temporaryPath), { recursive: true });
            const source =
                entry.compressedSize === 0
                    ? Readable.from([])
                    : createReadStream(archivePath, {
                          start: entry.dataOffset,
                          end: entry.dataOffset + entry.compressedSize - 1,
                      });
            const integrity = new EntryIntegrityTransform(entry);
            const output = createWriteStream(temporaryPath, { flags: 'wx', mode: options.fileMode ?? 0o600 });
            if (entry.compressionMethod === 8) {
                await pipeline(source, createInflateRaw(), integrity, output);
            } else {
                await pipeline(source, integrity, output);
            }
            await fs.chmod(temporaryPath, options.fileMode ?? 0o600);
            staged.push({ temporaryPath, relativePath: canonicalRelative });
        }

        // Resolve and validate every destination before changing any live
        // chart. This prevents a late collision (for example, an existing
        // directory at the second output path) from leaving only the first
        // half of a multi-file archive installed.
        const prepared: Array<{
            temporaryPath: string;
            finalPath: string;
            relativePath: string;
            backupPath: string | null;
        }> = [];
        const backupDir = path.join(stagingDir, '.backups');
        for (const [index, item] of staged.entries()) {
            const finalPath = path.join(destinationDir, item.relativePath);
            await fs.mkdir(path.dirname(finalPath), { recursive: true });
            let backupPath: string | null = null;
            try {
                const existing = await fs.lstat(finalPath);
                if (!existing.isFile()) throw archiveError(`Refusing to replace non-file path ${item.relativePath}`);
                backupPath = path.join(backupDir, String(index));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            prepared.push({ ...item, finalPath, backupPath });
        }

        // Keep old files inside the same-filesystem staging directory until
        // every new file has committed. A failed rename can then roll the
        // whole archive back instead of exposing a mixed old/new chart set.
        const backedUp: typeof prepared = [];
        const committed: typeof prepared = [];
        try {
            if (prepared.some((item) => item.backupPath)) await fs.mkdir(backupDir, { recursive: true });
            for (const item of prepared) {
                if (!item.backupPath) continue;
                await fs.rename(item.finalPath, item.backupPath);
                backedUp.push(item);
            }
            for (const item of prepared) {
                await fs.rename(item.temporaryPath, item.finalPath);
                committed.push(item);
            }
        } catch (commitError) {
            const rollbackErrors: unknown[] = [];
            for (const item of committed.reverse()) {
                try {
                    await fs.unlink(item.finalPath);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') rollbackErrors.push(error);
                }
            }
            for (const item of backedUp.reverse()) {
                try {
                    await fs.rename(item.backupPath!, item.finalPath);
                } catch (error) {
                    rollbackErrors.push(error);
                }
            }
            if (rollbackErrors.length > 0) {
                preserveStaging = true;
                throw archiveError(
                    `ZIP commit failed and rollback was incomplete: ${
                        commitError instanceof Error ? commitError.message : String(commitError)
                    }; recoverable backups remain at ${stagingDir}`,
                );
            }
            throw commitError;
        }
        return { inspection, files: prepared.map((item) => item.finalPath) };
    } catch (error) {
        if (error instanceof PiResourceBoundaryError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOSPC') throw diskSpaceError(policy.minimumFreeBytes);
        throw archiveError(`ZIP extraction failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        if (!preserveStaging) await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
}

async function availableBytes(directory: string): Promise<number> {
    const stats = await fs.statfs(directory, { bigint: true });
    const value = stats.bavail * stats.bsize;
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

async function assertDiskCapacity(directory: string, requiredBytes: number, policy: DownloadPolicy): Promise<void> {
    const available = await availableBytes(directory);
    if (available < requiredBytes + policy.minimumFreeBytes) {
        throw diskSpaceError(policy.minimumFreeBytes);
    }
}

export async function assertDownloadDestinationCapacity(
    destinationPath: string,
    requiredBytes: number,
    policy: Readonly<DownloadPolicy>,
): Promise<void> {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0 || requiredBytes > policy.maxBytes) {
        throw new PiResourceBoundaryError(
            `Download exceeds the ${policy.maxBytes.toLocaleString('en-US')}-byte limit`,
            PI_DOWNLOAD_TOO_LARGE_CODE,
            413,
        );
    }

    const destinationDir = path.dirname(destinationPath);
    await fs.mkdir(destinationDir, { recursive: true });
    await assertDiskCapacity(destinationDir, requiredBytes > 0 ? requiredBytes : policy.diskCheckIntervalBytes, policy);
}

/** Maximum bytes a new stream may consume while preserving the disk reserve. */
export async function resolveDownloadByteBudget(
    destinationPath: string,
    policy: Readonly<DownloadPolicy>,
): Promise<number> {
    const destinationDir = path.dirname(destinationPath);
    await fs.mkdir(destinationDir, { recursive: true });
    const available = await availableBytes(destinationDir);
    const diskBudget = Math.floor(available - policy.minimumFreeBytes);
    if (diskBudget <= 0) throw diskSpaceError(policy.minimumFreeBytes);
    return Math.min(policy.maxBytes, diskBudget);
}

export async function assertDownloadedFileWithinPolicy(
    filePath: string,
    policy: Readonly<DownloadPolicy>,
): Promise<number> {
    const file = await fs.lstat(filePath);
    if (!file.isFile() || file.size <= 0) throw new Error('Downloaded file is empty or not a regular file');
    if (file.size > policy.maxBytes) {
        throw new PiResourceBoundaryError(
            `Download exceeds the ${policy.maxBytes.toLocaleString('en-US')}-byte limit`,
            PI_DOWNLOAD_TOO_LARGE_CODE,
            413,
        );
    }
    return file.size;
}

class DownloadBoundaryTransform extends Transform {
    bytes = 0;
    private nextDiskCheck: number;

    constructor(
        private readonly destinationDir: string,
        private readonly policy: Readonly<DownloadPolicy>,
    ) {
        super();
        this.nextDiskCheck = policy.diskCheckIntervalBytes;
    }

    override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
        this.bytes += chunk.length;
        if (this.bytes > this.policy.maxBytes) {
            callback(
                new PiResourceBoundaryError(
                    `Download exceeds the ${this.policy.maxBytes.toLocaleString('en-US')}-byte limit`,
                    PI_DOWNLOAD_TOO_LARGE_CODE,
                    413,
                ),
            );
            return;
        }
        if (this.bytes < this.nextDiskCheck) {
            callback(null, chunk);
            return;
        }
        this.nextDiskCheck = this.bytes + this.policy.diskCheckIntervalBytes;
        void assertDiskCapacity(this.destinationDir, this.policy.diskCheckIntervalBytes, this.policy).then(
            () => callback(null, chunk),
            (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
        );
    }
}

/** Stream a Fetch response to an adjacent partial file and atomically replace on success. */
export async function streamResponseToFile(
    response: { body: unknown | null; headers: { get(name: string): string | null } },
    destinationPath: string,
    policy: Readonly<DownloadPolicy>,
    options: {
        signal?: AbortSignal;
        onProgress?: (bytes: number, contentLength: number) => void;
        mode?: number;
    } = {},
): Promise<number> {
    if (!response.body) throw new Error('Upstream response has no body');
    const contentLengthText = response.headers.get('content-length');
    let contentLength = 0;
    if (contentLengthText && /^\d+$/.test(contentLengthText)) contentLength = Number(contentLengthText);
    if (!Number.isSafeInteger(contentLength) || contentLength > policy.maxBytes) {
        throw new PiResourceBoundaryError(
            `Download exceeds the ${policy.maxBytes.toLocaleString('en-US')}-byte limit`,
            PI_DOWNLOAD_TOO_LARGE_CODE,
            413,
        );
    }

    const destinationDir = path.dirname(destinationPath);
    await assertDownloadDestinationCapacity(destinationPath, contentLength, policy);
    const partialPath = `${destinationPath}.${process.pid}.${randomUUID()}.partial`;
    const boundary = new DownloadBoundaryTransform(destinationDir, policy);
    if (options.onProgress) {
        boundary.on('data', () => options.onProgress?.(boundary.bytes, contentLength));
    }
    const output = createWriteStream(partialPath, { flags: 'wx', mode: options.mode ?? 0o600 });
    try {
        const source = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
        await pipeline(source, boundary, output, { signal: options.signal });
        if (boundary.bytes === 0) throw new Error('Upstream returned an empty body');
        await fs.chmod(partialPath, options.mode ?? 0o600);
        await fs.rename(partialPath, destinationPath);
        return boundary.bytes;
    } catch (error) {
        output.destroy();
        if (!output.closed) await once(output, 'close').catch(() => {});
        await fs.unlink(partialPath).catch(() => {});
        if ((error as NodeJS.ErrnoException).code === 'ENOSPC') throw diskSpaceError(policy.minimumFreeBytes);
        throw error;
    }
}
