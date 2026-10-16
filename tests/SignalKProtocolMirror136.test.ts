// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { SIGNALK_PROTOCOL_SYNCED_FROM } from '../pi-cache/src/signalkProtocolSyncedFrom';

const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
describe('app-owned portable Signal K protocol', () => {
    it('keeps the standalone Pi byte-exact behind its generated header and checked source digest', () => {
        const source = read('utils/signalkProtocol.ts');
        const mirror = read('pi-cache/src/signalkProtocol.ts');
        expect(mirror.slice(mirror.indexOf('\n\n') + 2)).toBe(source);
        expect(SIGNALK_PROTOCOL_SYNCED_FROM.sha256).toBe(createHash('sha256').update(source).digest('hex'));
        expect(SIGNALK_PROTOCOL_SYNCED_FROM.source).toBe('utils/signalkProtocol.ts');
        expect(
            execFileSync(process.execPath, ['pi-cache/scripts/sync-signalk-protocol.mjs', '--check'], {
                encoding: 'utf8',
            }),
        ).toContain('in sync');
    });
    it('can be type-checked without a Pi or Node runtime dependency in the uploaded app', () => {
        const source = read('utils/signalkProtocol.ts');
        expect(ts.preProcessFile(source).importedFiles).toEqual([]);
        for (const file of [
            'components/vessel/SignalKNotifications.tsx',
            'services/signalk/snapshot.ts',
            'services/signalk/piNotifications.ts',
            'services/signalk/PairedPiNotifications.ts',
            'services/signalk/notificationAudio.ts',
            'services/signalk/DirectSignalKService.ts',
        ]) {
            const imports = ts.preProcessFile(read(file)).importedFiles.map((entry) => entry.fileName);
            expect(imports, file).toContain('../../utils/signalkProtocol');
            expect(
                imports.filter((name) => name.includes('pi-cache/')),
                file,
            ).toEqual([]);
        }
    });
});
