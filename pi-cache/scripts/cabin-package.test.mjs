import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { gzipSync } from 'node:zlib';
import { bundleFixture } from './update10Fixture.mjs';
import {
    CABIN_PACKAGE,
    cabinAssetManifest,
    readCabinAssets,
    verifyCabinFiles,
    verifyCabinArchiveInventory,
    verifyGzipEnvelope,
} from './cabin-package.mjs';

test('bounded cabin assets preserve exact manifest and file bytes', () => {
    const f = bundleFixture();
    try {
        const directory = path.join(f.root, 'cabin-dist');
        assert.deepEqual(readCabinAssets(directory), f.manifest.cabinAssets);
        assert.doesNotThrow(() => verifyCabinFiles(directory, f.manifest.cabinAssets));
        fs.appendFileSync(path.join(directory, 'assets/display.js'), 'Changed');
        assert.throws(() => verifyCabinFiles(directory, f.manifest.cabinAssets), /bytes changed/);
    } finally {
        f.close();
    }
});
test('cabin asset metadata refuses traversal, duplicate, unknown, missing and oversized fields', () => {
    const f = bundleFixture();
    try {
        for (const mutate of [
            (a) => {
                a[0].file = '../secret';
            },
            (a) => {
                a.push(a[0]);
            },
            (a) => {
                a[0].file = 'assets/.env';
            },
            (a) => {
                a[0].bytes = CABIN_PACKAGE.fileBytes + 1;
            },
            (a) => {
                a[0].sha256 = 'bad';
            },
            (a) => {
                a[0].extra = 'not admitted';
            },
            (a) => {
                a.shift();
            },
        ]) {
            const assets = structuredClone(f.manifest.cabinAssets);
            mutate(assets);
            assert.throws(() => cabinAssetManifest(assets));
        }
        const many = Array.from({ length: 17 }, (_, i) => ({
            file: `assets/${i}.js`,
            bytes: 1,
            sha256: 'a'.repeat(64),
        }));
        assert.throws(() => cabinAssetManifest(many));
        const total = [
            { file: 'index.html', bytes: CABIN_PACKAGE.fileBytes, sha256: 'a'.repeat(64) },
            { file: 'assets/a.js', bytes: CABIN_PACKAGE.fileBytes, sha256: 'a'.repeat(64) },
            { file: 'assets/b.js', bytes: 1, sha256: 'a'.repeat(64) },
        ];
        assert.throws(() => cabinAssetManifest(total));
    } finally {
        f.close();
    }
});
test('cabin filesystem reader refuses extra entries, nesting and oversized files before reading bytes', () => {
    for (const kind of ['extra', 'nested', 'oversized', 'many']) {
        const f = bundleFixture();
        try {
            const directory = path.join(f.root, 'cabin-dist');
            if (kind === 'extra') fs.writeFileSync(path.join(directory, '.env'), 'private');
            if (kind === 'nested') fs.mkdirSync(path.join(directory, 'assets/nested'));
            if (kind === 'oversized') {
                const fd = fs.openSync(path.join(directory, 'assets/display.js'), 'w');
                try {
                    fs.ftruncateSync(fd, CABIN_PACKAGE.fileBytes + 1);
                } finally {
                    fs.closeSync(fd);
                }
            }
            if (kind === 'many')
                for (let i = 0; i < 17; i++) fs.writeFileSync(path.join(directory, `assets/f${i}.js`), 'a');
            assert.throws(() => readCabinAssets(directory));
        } finally {
            f.close();
        }
    }
});
test('cabin archive inventory requires exact regular assets and bounded directory entries', () => {
    const f = bundleFixture();
    try {
        const files = f.manifest.cabinAssets.map((row) => `cabin-dist/${row.file}`);
        const good = ['cabin-dist/', 'cabin-dist/assets/', ...files];
        assert.doesNotThrow(() =>
            verifyCabinArchiveInventory(good, ['d root', 'd assets', '- html', '- js'], f.manifest.cabinAssets),
        );
        for (const bad of [
            [],
            [...good, files[0]],
            [...good, 'cabin-dist/../escape'],
            [...good, '/outside'],
            [...good, 'cabin-dist/private/'],
        ])
            assert.throws(() =>
                verifyCabinArchiveInventory(
                    bad,
                    bad.map(() => '- file'),
                    f.manifest.cabinAssets,
                ),
            );
        assert.throws(() =>
            verifyCabinArchiveInventory(good, ['d root', 'd assets', 'l link', '- js'], f.manifest.cabinAssets),
        );
        assert.throws(() => verifyCabinArchiveInventory(good, ['d root'], f.manifest.cabinAssets));
    } finally {
        f.close();
    }
});
test('gzip envelope bounds compressed bytes, expansion and tar block alignment before extraction', () => {
    const f = bundleFixture();
    try {
        assert.ok(
            verifyGzipEnvelope(
                path.join(f.output, 'cabin.tar.gz'),
                CABIN_PACKAGE.archiveBytes,
                CABIN_PACKAGE.totalBytes + 65536,
            ) >= 1024,
        );
        const name = path.join(f.root, 'bomb.gz');
        fs.writeFileSync(name, gzipSync(Buffer.alloc(32768)));
        assert.throws(() => verifyGzipEnvelope(name, 1024, 1024));
        fs.writeFileSync(name, gzipSync(Buffer.alloc(1025)));
        assert.throws(() => verifyGzipEnvelope(name, 1024, 2048), /expansion is invalid/);
        fs.writeFileSync(name, 'x'.repeat(1025));
        assert.throws(() => verifyGzipEnvelope(name, 1024, 2048), /size is outside/);
    } finally {
        f.close();
    }
});
