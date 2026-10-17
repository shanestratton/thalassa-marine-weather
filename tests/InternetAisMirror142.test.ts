// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
const files = [
    'utils/internetAis.ts',
    'pi-cache/src/internetAisWire.ts',
    'supabase/functions/_shared/internetAis.ts',
    'pi-cache/scripts/sync-internet-ais.mjs',
];
it('keeps the dependency-free original-time/source contract byte-exact in Pi and Edge', () => {
    const source = fs.readFileSync(files[0], 'utf8').replaceAll('\r\n', '\n');
    expect(ts.preProcessFile(source).importedFiles).toEqual([]);
    for (const file of files.slice(1, 3)) {
        const mirror = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
        expect(mirror.slice(mirror.indexOf('\n') + 1)).toBe(source);
    }
    execFileSync(process.execPath, [files[3], '--check']);
});
it('actual check refuses a one-byte stale mirror without rewriting canonical source or other mirrors', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'internet-ais-mirror-'));
    try {
        for (const file of files) {
            fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
            fs.copyFileSync(file, path.join(directory, file));
        }
        fs.appendFileSync(path.join(directory, files[1]), ' ');
        const original = fs.readFileSync(path.join(directory, files[0]));
        const result = spawnSync(process.execPath, [files[3], '--check'], { cwd: directory, encoding: 'utf8' });
        expect(result.status).not.toBe(0);
        expect(fs.readFileSync(path.join(directory, files[0]))).toEqual(original);
        expect(fs.readFileSync(path.join(directory, files[2]))).toEqual(fs.readFileSync(files[2]));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
