import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import AdmZip from 'adm-zip';

import {
    CHART_ARCHIVE_POLICY,
    ENC_ARCHIVE_POLICY,
    ENC_DOWNLOAD_POLICY,
    PI_ARCHIVE_REJECTED_CODE,
    PI_DOWNLOAD_TOO_LARGE_CODE,
    PiResourceBoundaryError,
    extractZipArchive,
    inspectZipArchive,
    streamResponseToFile,
    type ArchivePolicy,
} from './resourceBoundary.js';

async function temporaryDirectory(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(tmpdir(), prefix));
}

function writeZip(filePath: string, entries: Array<{ name: string; data?: string; attr?: number }>): void {
    const zip = new AdmZip();
    for (const item of entries) {
        zip.addFile(item.name, Buffer.from(item.data ?? 'chart-data'));
        if (item.attr !== undefined) {
            const entry = zip.getEntry(item.name);
            assert(entry);
            entry.header.made = (3 << 8) | 20;
            entry.attr = item.attr << 16;
        }
    }
    zip.writeZip(filePath);
}

function rewriteZipName(filePath: string, from: string, to: string): void {
    assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
    const archive = Buffer.from(readFileSync(filePath));
    const fromBytes = Buffer.from(from);
    const toBytes = Buffer.from(to);
    let cursor = 0;
    let replacements = 0;
    while ((cursor = archive.indexOf(fromBytes, cursor)) >= 0) {
        toBytes.copy(archive, cursor);
        cursor += toBytes.length;
        replacements++;
    }
    assert(replacements >= 2, `expected local and central names for ${from}`);
    writeFileSync(filePath, archive);
}

function rewriteZipUnixMode(filePath: string, mode: number): void {
    const archive = Buffer.from(readFileSync(filePath));
    const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert(central >= 0);
    archive.writeUInt16LE((3 << 8) | 20, central + 4);
    archive.writeUInt32LE((mode << 16) >>> 0, central + 38);
    writeFileSync(filePath, archive);
}

test('safe ZIP inspection and extraction stream regular nested files', async () => {
    const directory = await temporaryDirectory('pi-safe-zip-');
    const archive = path.join(directory, 'cells.zip');
    const destination = path.join(directory, 'out');
    writeZip(archive, [
        { name: 'ENC_ROOT/AU530150.000', data: 'cell-one' },
        { name: 'ENC_ROOT/AU530151.000', data: 'cell-two' },
    ]);

    const inspected = await inspectZipArchive(archive, ENC_ARCHIVE_POLICY);
    assert.equal(inspected.fileCount, 2);
    assert.equal(inspected.uncompressedBytes, 16);
    const extracted = await extractZipArchive(archive, destination, ENC_ARCHIVE_POLICY);
    assert.equal(extracted.files.length, 2);
    assert.equal(readFileSync(path.join(destination, 'ENC_ROOT/AU530150.000'), 'utf8'), 'cell-one');
});

test('traversal, absolute paths, excessive nesting, duplicates, symlinks and special files are rejected', async () => {
    const directory = await temporaryDirectory('pi-hostile-zip-');
    const cases: Array<{
        name: string;
        entries: Array<{ name: string; attr?: number }>;
        rewrite?: [string, string];
        unixMode?: number;
    }> = [
        { name: 'traversal', entries: [{ name: 'aa/escape.000' }], rewrite: ['aa/escape.000', '../escape.000'] },
        { name: 'absolute', entries: [{ name: 'aescape.000' }], rewrite: ['aescape.000', '/escape.000'] },
        { name: 'deep', entries: [{ name: 'a/b/c/d/e/f/g/h/i/cell.000' }] },
        { name: 'duplicate', entries: [{ name: 'CELL.000' }, { name: 'cell.000' }] },
        { name: 'symlink', entries: [{ name: 'link.000' }], unixMode: 0o120777 },
        { name: 'fifo', entries: [{ name: 'pipe.000' }], unixMode: 0o010644 },
    ];
    for (const hostile of cases) {
        const archive = path.join(directory, `${hostile.name}.zip`);
        writeZip(archive, hostile.entries);
        if (hostile.rewrite) rewriteZipName(archive, ...hostile.rewrite);
        if (hostile.unixMode) rewriteZipUnixMode(archive, hostile.unixMode);
        await assert.rejects(
            inspectZipArchive(archive, ENC_ARCHIVE_POLICY),
            (error: unknown) => error instanceof PiResourceBoundaryError && error.code === PI_ARCHIVE_REJECTED_CODE,
            hostile.name,
        );
    }
});

test('entry, aggregate, and file-count limits are checked from metadata before inflation', async () => {
    const directory = await temporaryDirectory('pi-limit-zip-');
    const archive = path.join(directory, 'limits.zip');
    writeZip(archive, [
        { name: 'one.000', data: '12345678' },
        { name: 'two.000', data: '12345678' },
    ]);
    const tinyPolicy: ArchivePolicy = {
        ...ENC_ARCHIVE_POLICY,
        maxArchiveBytes: 1_000_000,
        maxFiles: 1,
        maxEntries: 2,
        maxEntryBytes: 10,
        maxUncompressedBytes: 12,
        minimumFreeBytes: 0,
    };
    await assert.rejects(inspectZipArchive(archive, tinyPolicy), /file limit/);
    await assert.rejects(
        inspectZipArchive(archive, { ...tinyPolicy, maxFiles: 2, maxUncompressedBytes: 12 }),
        /expanded limit/,
    );

    // Patch only the central-directory size metadata. Inspection must reject
    // it without attempting to allocate the declared 32 MiB output.
    const bomb = Buffer.from(readFileSync(archive));
    const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert(central >= 0);
    bomb.writeUInt32LE(32 * 1024 * 1024, central + 24);
    const bombPath = path.join(directory, 'metadata-bomb.zip');
    writeFileSync(bombPath, bomb);
    await assert.rejects(
        inspectZipArchive(bombPath, { ...ENC_ARCHIVE_POLICY, maxEntryBytes: 16 * 1024 * 1024 }),
        /entry exceeds/,
    );
});

test('corrupt compressed data fails integrity checks and leaves no extracted partials', async () => {
    const directory = await temporaryDirectory('pi-corrupt-zip-');
    const archive = path.join(directory, 'corrupt.zip');
    const destination = path.join(directory, 'out');
    writeZip(archive, [{ name: 'AU530150.000', data: 'a chart cell with enough data to deflate' }]);
    const inspected = await inspectZipArchive(archive, ENC_ARCHIVE_POLICY);
    const entry = inspected.entries[0];
    assert(entry && entry.compressedSize > 0);
    const bytes = Buffer.from(readFileSync(archive));
    bytes[entry.dataOffset + Math.floor(entry.compressedSize / 2)] ^= 0xff;
    writeFileSync(archive, bytes);

    await assert.rejects(
        extractZipArchive(archive, destination, ENC_ARCHIVE_POLICY),
        (error: unknown) => error instanceof PiResourceBoundaryError && error.code === PI_ARCHIVE_REJECTED_CODE,
    );
    assert.deepEqual(await fs.readdir(destination), []);
});

test('a multi-file archive leaves the live destination unchanged when any output cannot commit', async () => {
    const directory = await temporaryDirectory('pi-atomic-zip-');
    const archive = path.join(directory, 'replacement.zip');
    const destination = path.join(directory, 'out');
    await fs.mkdir(path.join(destination, 'blocked.000'), { recursive: true });
    await fs.writeFile(path.join(destination, 'first.000'), 'old-chart');
    writeZip(archive, [
        { name: 'first.000', data: 'new-chart' },
        { name: 'blocked.000', data: 'cannot-replace-a-directory' },
    ]);

    await assert.rejects(
        extractZipArchive(archive, destination, ENC_ARCHIVE_POLICY),
        (error: unknown) => error instanceof PiResourceBoundaryError && error.code === PI_ARCHIVE_REJECTED_CODE,
    );
    assert.equal(await fs.readFile(path.join(destination, 'first.000'), 'utf8'), 'old-chart');
    assert.equal((await fs.lstat(path.join(destination, 'blocked.000'))).isDirectory(), true);
    assert.deepEqual(
        (await fs.readdir(destination)).filter((name) => name.startsWith('.thalassa-extract-')),
        [],
    );
});

test('streamed downloads reject declared and actual overflow and clean every partial', async () => {
    const directory = await temporaryDirectory('pi-download-boundary-');
    const destination = path.join(directory, 'chart.bin');
    const policy = { maxBytes: 8, minimumFreeBytes: 0, diskCheckIntervalBytes: 4 };

    await assert.rejects(
        streamResponseToFile(new Response('small', { headers: { 'content-length': '9' } }), destination, policy),
        (error: unknown) => error instanceof PiResourceBoundaryError && error.code === PI_DOWNLOAD_TOO_LARGE_CODE,
    );

    const overflowing = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(Buffer.from('12345'));
            controller.enqueue(Buffer.from('67890'));
            controller.close();
        },
    });
    await assert.rejects(
        streamResponseToFile(new Response(overflowing), destination, policy),
        (error: unknown) => error instanceof PiResourceBoundaryError && error.code === PI_DOWNLOAD_TOO_LARGE_CODE,
    );
    await assert.rejects(fs.access(destination));

    await fs.writeFile(destination, 'existing-chart');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(streamResponseToFile(new Response('new'), destination, policy, { signal: controller.signal }));
    assert.equal(await fs.readFile(destination, 'utf8'), 'existing-chart');
    assert.deepEqual(
        (await fs.readdir(directory)).filter((name) => name.includes('.partial')),
        [],
    );
});

test('a successful bounded download replaces the destination only after completion', async () => {
    const directory = await temporaryDirectory('pi-download-success-');
    const destination = path.join(directory, 'chart.bin');
    await fs.writeFile(destination, 'old');
    const bytes = await streamResponseToFile(new Response('new-chart'), destination, {
        maxBytes: 64,
        minimumFreeBytes: 0,
        diskCheckIntervalBytes: 4,
    });
    assert.equal(bytes, 9);
    assert.equal(await fs.readFile(destination, 'utf8'), 'new-chart');
});

/**
 * The ENC envelope must fit a REAL commercial chart set, not just a handful of
 * loose S-57 cells.
 *
 * Measured from the o-charts Australian base set on 2026-08-30 —
 * `oeuSENC-AU-2026-1-31-base-sgl001FECD2.zip`, read straight off the download
 * with a ranged request before committing to 707 MB over the boat's 4G. The
 * previous envelope failed it three ways at once, and would have said so only
 * after the download completed.
 *
 * These are the numbers that mattered, kept here so a future tightening has to
 * argue with the archive rather than with a round number.
 */
const OCHARTS_AU_BASE = Object.freeze({
    archiveBytes: 741_109_675, // 706.8 MB
    entries: 5_020,
    centralDirectoryBytes: 629_145, // 0.6 MB
});

test('the ENC policy admits the o-charts Australian base set', () => {
    assert.ok(
        OCHARTS_AU_BASE.archiveBytes <= ENC_ARCHIVE_POLICY.maxArchiveBytes,
        `archive ${OCHARTS_AU_BASE.archiveBytes} exceeds maxArchiveBytes ${ENC_ARCHIVE_POLICY.maxArchiveBytes}`,
    );
    assert.ok(
        OCHARTS_AU_BASE.entries <= ENC_ARCHIVE_POLICY.maxFiles,
        `entries ${OCHARTS_AU_BASE.entries} exceeds maxFiles ${ENC_ARCHIVE_POLICY.maxFiles}`,
    );
    assert.ok(
        OCHARTS_AU_BASE.entries <= ENC_ARCHIVE_POLICY.maxEntries,
        `entries ${OCHARTS_AU_BASE.entries} exceeds maxEntries ${ENC_ARCHIVE_POLICY.maxEntries}`,
    );
    assert.ok(OCHARTS_AU_BASE.centralDirectoryBytes <= ENC_ARCHIVE_POLICY.maxCentralDirectoryBytes);
});

test('raising the ENC envelope did not weaken the zip-bomb guards', () => {
    // Archive size and entry count bound bandwidth and disk. Decompression is
    // bounded by these two, and they are unchanged — that is the whole
    // argument for the raise being safe.
    assert.equal(ENC_ARCHIVE_POLICY.maxCompressionRatio, 1_000);
    assert.equal(ENC_ARCHIVE_POLICY.maxEntryBytes, 256 * 1024 * 1024);
    // Uncompressed still bounded, and still below the raster chart allowance.
    assert.ok(ENC_ARCHIVE_POLICY.maxUncompressedBytes <= CHART_ARCHIVE_POLICY.maxUncompressedBytes);
});

test('the DOWNLOAD limit was raised with the archive limit, not after it', () => {
    // These come in pairs. Raising only the archive half let the o-charts set
    // fail with "Download exceeds the 314,572,800-byte limit" before the zip
    // was opened at all — the limit had simply moved one layer earlier.
    assert.ok(
        OCHARTS_AU_BASE.archiveBytes <= ENC_DOWNLOAD_POLICY.maxBytes,
        `archive ${OCHARTS_AU_BASE.archiveBytes} exceeds download maxBytes ${ENC_DOWNLOAD_POLICY.maxBytes}`,
    );
    assert.equal(ENC_DOWNLOAD_POLICY.maxBytes, ENC_ARCHIVE_POLICY.maxArchiveBytes);
});
