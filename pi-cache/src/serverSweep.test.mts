/**
 * The start-up sweep (127-C-d decision 12). Conversion work dirs used to be
 * cleaned only through the in-memory jobs Map, so a restart orphaned them,
 * and some held decrypted or converted charts. At start the jobs Map is
 * empty, so everything under TEMP_ROOT, every thalassa-enc-persist-* and the
 * retired re-conversion's work root go. The encrypted deliveries under
 * enc-charts/sources are never touched, nor anything else in TMPDIR.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sweepEncTempLeftovers } from './routes/enc.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));

test('leftover conversion and persist dirs are gone after start; encrypted sources and other apps are not', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-sweep-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const tmp = path.join(root, 'staging');
    const leftovers = [
        path.join(tmp, 'thalassa-enc-conversion', '0b6d0c55-7c55-4d0a-9c2f-3f2b1d1d1d1d', 'out', 'DEPARE.geojson'),
        path.join(tmp, 'thalassa-enc-conversion', '9d9e3a2a-1111-4222-8333-944444444444', 'result.json'),
        path.join(tmp, 'thalassa-enc-persist-Ab12Cd', 'cell.json'),
        path.join(tmp, 'thalassa-enc-reconvert', 'aaaaaaaaaaaa-x', 'converted-ocharts', '0', 'index.json'),
    ];
    for (const file of leftovers) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, '{"cells":[]}');
    }
    const other = path.join(tmp, 'someone-elses-download', 'keep.txt');
    await fs.mkdir(path.dirname(other), { recursive: true });
    await fs.writeFile(other, 'keep');
    const source = path.join(root, 'enc-charts', 'sources', `${'c'.repeat(64)}-x`, 'set', 'OC-99-ZZ0001.oesu');
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, 'encrypted fixture');

    const swept = await sweepEncTempLeftovers(tmp);
    assert.equal(swept, 4, 'two conversion work dirs, one persist stage, one re-conversion root');
    for (const file of leftovers) await assert.rejects(fs.stat(file), { code: 'ENOENT' }, file);
    assert.deepEqual(await fs.readdir(tmp), ['someone-elses-download']);
    assert.equal(await fs.readFile(other, 'utf8'), 'keep');
    assert.equal(await fs.readFile(source, 'utf8'), 'encrypted fixture');
    assert.equal(await sweepEncTempLeftovers(tmp), 0, 'idempotent');
    assert.equal(await sweepEncTempLeftovers(path.join(root, 'no-such-tmp')), 0);
});

test('server.ts sweeps at start, before it listens', () => {
    const server = readFileSync(path.join(SRC, 'server.ts'), 'utf8');
    const sweep = server.indexOf('await sweepEncTempLeftovers()');
    assert.ok(sweep > 0, 'server.ts awaits the sweep');
    assert.ok(sweep < server.indexOf('server.listen('), 'before the server takes a request');
});
