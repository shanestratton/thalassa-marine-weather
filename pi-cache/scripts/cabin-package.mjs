import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
export const CABIN_PACKAGE = Object.freeze({
    files: 16,
    fileBytes: 2 * 1024 ** 2,
    totalBytes: 4 * 1024 ** 2,
    archiveBytes: 5 * 1024 ** 2,
});
export function cabinAssetManifest(value) {
    if (!Array.isArray(value) || value.length < 2 || value.length > CABIN_PACKAGE.files)
        throw Error('Cabin asset inventory is unavailable');
    const seen = new Set();
    let total = 0;
    for (const row of value) {
        if (
            !row ||
            typeof row !== 'object' ||
            Object.keys(row).sort().join(',') !== 'bytes,file,sha256' ||
            typeof row.file !== 'string' ||
            row.file.length > 160 ||
            !/^(?:index\.html|assets\/[A-Za-z\d_-]+\.(?:js|css))$/.test(row.file) ||
            seen.has(row.file) ||
            !Number.isSafeInteger(row.bytes) ||
            row.bytes < 1 ||
            row.bytes > CABIN_PACKAGE.fileBytes ||
            !/^[a-f\d]{64}$/.test(row.sha256)
        )
            throw Error('Cabin asset inventory is invalid');
        seen.add(row.file);
        total += row.bytes;
    }
    if (!seen.has('index.html') || !value.some((row) => row.file.endsWith('.js')) || total > CABIN_PACKAGE.totalBytes)
        throw Error('Cabin asset bounds exceeded');
    return value;
}
export function readCabinAssets(directory) {
    const root = fs.lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw Error('Cabin asset directory is unavailable');
    const files = [];
    const top = fs.opendirSync(directory);
    let rootEntries = 0;
    try {
        for (let entry; (entry = top.readSync()); ) {
            if (++rootEntries > CABIN_PACKAGE.files + 1) throw Error('Cabin asset entry count exceeded');
            if (entry.isSymbolicLink()) throw Error('Cabin asset links are refused');
            if (entry.isDirectory()) {
                if (entry.name !== 'assets') throw Error('Unexpected cabin asset directory');
                const assets = fs.opendirSync(path.join(directory, 'assets'));
                try {
                    for (let asset; (asset = assets.readSync()); ) {
                        if (!asset.isFile() || asset.isSymbolicLink() || files.length >= CABIN_PACKAGE.files)
                            throw Error('Cabin asset entry is invalid');
                        files.push(`assets/${asset.name}`);
                    }
                } finally {
                    assets.closeSync();
                }
            } else if (entry.isFile()) files.push(entry.name);
            else throw Error('Cabin asset entry is invalid');
            if (files.length > CABIN_PACKAGE.files) throw Error('Cabin asset count exceeded');
        }
    } finally {
        top.closeSync();
    }
    let total = 0;
    const manifest = [];
    for (const name of files) {
        if (!/^(?:index\.html|assets\/[A-Za-z\d_-]+\.(?:js|css))$/.test(name))
            throw Error('Cabin asset path is invalid');
        const file = path.join(directory, name),
            info = fs.lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > CABIN_PACKAGE.fileBytes)
            throw Error('Cabin asset size changed');
        total += info.size;
        if (total > CABIN_PACKAGE.totalBytes) throw Error('Cabin asset total exceeds its bound');
        const descriptor = fs.openSync(file, 'r');
        try {
            const opened = fs.fstatSync(descriptor);
            if (!opened.isFile() || opened.size !== info.size) throw Error('Cabin asset size changed');
            const bytes = Buffer.alloc(info.size);
            let offset = 0;
            while (offset < bytes.length) {
                const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
                if (count < 1) throw Error('Cabin asset was truncated');
                offset += count;
            }
            if (fs.fstatSync(descriptor).size !== info.size) throw Error('Cabin asset size changed');
            manifest.push({
                file: name,
                bytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
            });
        } finally {
            fs.closeSync(descriptor);
        }
    }
    return cabinAssetManifest(manifest.sort((a, b) => a.file.localeCompare(b.file)));
}
export function verifyCabinFiles(directory, manifest) {
    cabinAssetManifest(manifest);
    const actual = readCabinAssets(directory);
    if (
        actual.length !== manifest.length ||
        actual.some(
            (row) =>
                !manifest.some(
                    (expected) =>
                        expected.file === row.file && expected.bytes === row.bytes && expected.sha256 === row.sha256,
                ),
        )
    )
        throw Error('Cabin asset inventory or bytes changed');
}
/** Bound expansion before invoking tar or writing extracted bytes. The native call is byte-bounded,
 * not claimed as a forcibly interruptible deadline on every OS. */
export function verifyGzipEnvelope(file, compressedBytes, inflatedBytes) {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > compressedBytes)
        throw Error('Archive size is outside its bound');
    const raw = gunzipSync(fs.readFileSync(file), { maxOutputLength: inflatedBytes });
    if (raw.length < 1024 || raw.length > inflatedBytes || raw.length % 512 !== 0)
        throw Error('Archive expansion is invalid');
    return raw.length;
}
export function verifyCabinArchiveInventory(entries, detailedEntries, manifest) {
    cabinAssetManifest(manifest);
    const allowed = new Set(manifest.map((row) => `cabin-dist/${row.file}`));
    const files = entries.filter((entry) => !entry.endsWith('/'));
    if (
        entries.length > CABIN_PACKAGE.files + 2 ||
        entries.some(
            (entry) =>
                entry.split('/').includes('..') ||
                entry.startsWith('/') ||
                (entry.endsWith('/') ? !['cabin-dist/', 'cabin-dist/assets/'].includes(entry) : !allowed.has(entry)),
        ) ||
        files.length !== allowed.size ||
        new Set(files).size !== files.length ||
        detailedEntries.length !== entries.length ||
        detailedEntries.some((line) => !['-', 'd'].includes(line[0]))
    )
        throw Error('Cabin archive inventory is invalid');
}
