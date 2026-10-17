// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
describe('portable weather position wire survives standalone Pi/web uploads', () => {
    it('checks the actual byte-exact pure mirror', () => {
        expect(
            execFileSync(process.execPath, ['pi-cache/scripts/sync-weather-position.mjs', '--check'], {
                encoding: 'utf8',
            }),
        ).toBe('');
        const source = readFileSync('utils/weatherPosition.ts', 'utf8').replace(/\r\n/g, '\n');
        const mirror = readFileSync('pi-cache/src/weatherPositionWire.ts', 'utf8').replace(/\r\n/g, '\n');
        expect(mirror.slice(mirror.indexOf('\n') + 1)).toBe(source);
    });
    it('compiles the real wire in an isolated folder without Pi/Node/types/dependencies', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'thalassa-weather-position-'));
        const within = () =>
            path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + 'thalassa-weather-position-');
        expect(within()).toBe(true);
        try {
            copyFileSync(path.resolve('utils/weatherPosition.ts'), path.join(directory, 'weatherPosition.ts'));
            writeFileSync(
                path.join(directory, 'tsconfig.json'),
                JSON.stringify({
                    compilerOptions: {
                        target: 'ES2022',
                        module: 'ESNext',
                        moduleResolution: 'bundler',
                        lib: ['ES2022', 'DOM'],
                        types: [],
                        strict: true,
                        noEmit: true,
                    },
                    include: ['*.ts'],
                }),
            );
            expect(
                execFileSync(
                    process.execPath,
                    [
                        path.resolve('node_modules/typescript/bin/tsc'),
                        '--project',
                        path.join(directory, 'tsconfig.json'),
                    ],
                    { encoding: 'utf8', timeout: 25000 },
                ),
            ).toBe('');
        } finally {
            if (within()) rmSync(directory, { recursive: true, force: true });
        }
    }, 30000);
});
