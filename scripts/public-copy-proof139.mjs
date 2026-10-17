import assert from 'node:assert/strict';
import { readdir, readFile, lstat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Public dist inventory only. Never accepts symlinks, maps or native binaries. */
export async function publicInventory139(directory) {
    const rows = [];
    async function walk(relative) {
        for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
            const name = relative ? `${relative}/${entry.name}` : entry.name;
            const target = path.join(directory, name);
            assert.ok(!(await lstat(target)).isSymbolicLink(), 'Public payload must not contain symlinks');
            if (entry.isDirectory()) await walk(name);
            else {
                assert.ok(entry.isFile(), 'Unsupported public payload entry');
                assert.ok(!name.endsWith('.map'), 'Public payload must not contain source maps');
                assert.ok(
                    !/\.(?:ipa|p8|p12|mobileprovision|xcarchive)$/i.test(name),
                    'Native/key material is not public proof',
                );
                const bytes = await readFile(target);
                rows.push({ file: name, bytes: bytes.length, sha256: sha(bytes) });
            }
        }
    }
    await walk('');
    return rows.sort((a, b) => a.file.localeCompare(b.file));
}

export async function assertPublicCopy139(source, copy) {
    const expected = await publicInventory139(source);
    assert.ok(
        expected.some((entry) => entry.file === 'index.html'),
        'Missing actual HTML entry',
    );
    assert.ok(
        expected.some((entry) => entry.file === 'logs.html'),
        'Missing actual Logs entry',
    );
    assert.ok(
        expected.some((entry) => entry.file.startsWith('assets/')),
        'Missing actual bundled assets',
    );
    const actual = await publicInventory139(copy);
    for (const row of expected)
        assert.deepEqual(
            actual.find((entry) => entry.file === row.file),
            row,
            `Public copy differs: ${row.file}`,
        );
    // Capacitor adds its own public bridge files; list their hashes explicitly.
    const expectedNames = new Set(expected.map((entry) => entry.file));
    const added = actual.filter((entry) => !expectedNames.has(entry.file));
    assert.ok(
        added.every((entry) => ['cordova.js', 'cordova_plugins.js'].includes(entry.file)),
        'Unexpected native public additions',
    );
    return {
        sourceFiles: expected.length,
        sourceBytes: expected.reduce((sum, row) => sum + row.bytes, 0),
        files: expected,
        added,
        copiedPublicBytesIdentical: true,
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [source, copy, output, ...extra] = process.argv.slice(2);
    assert.ok(
        source && copy && output && !extra.length,
        'Expected source public directory, copied public directory and JSON output',
    );
    const proof = await assertPublicCopy139(source, copy);
    await writeFile(output, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
    console.log(
        JSON.stringify({
            sourceFiles: proof.sourceFiles,
            sourceBytes: proof.sourceBytes,
            copiedPublicBytesIdentical: true,
        }),
    );
}
