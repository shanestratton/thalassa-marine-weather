// @vitest-environment node
import { createHash, webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { partitionNoaaRecords } from '../scripts/noaa-enc/partition-records';
import { parseNoaaPart } from '../services/enc/noaaPackageContract';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
const state = vi.hoisted(() => ({
    files: new Map<string, string>(),
    fail: '',
    writes: 0,
    active: 0,
    maxActive: 0,
    resident: 0,
    maximumResident: 0,
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock('@capacitor/filesystem', () => ({
    Directory: { Data: 'DATA', Library: 'LIBRARY' },
    Encoding: { UTF8: 'utf8' },
    Filesystem: {
        stat: async ({ path }: { path: string }) => {
            if (state.fail === 'stat') throw Error('EACCES');
            if (state.files.has(path)) return { size: Buffer.byteLength(state.files.get(path)!) };
            if ([...state.files.keys()].some((p) => p.startsWith(path + '/'))) return { size: 0 };
            throw Error('ENOENT');
        },
        readFile: async ({ path }: { path: string }) => {
            if (state.fail === 'read') throw Error('EIO');
            if (!state.files.has(path)) throw Error('ENOENT');
            return { data: state.fail === 'tamper' ? '{}' : state.files.get(path) };
        },
        writeFile: async ({ path, data }: { path: string; data: string }) => {
            state.writes++;
            if (state.fail === 'write' && state.writes > 1) throw Error('ENOSPC');
            state.files.set(path, data);
        },
        rmdir: async ({ path }: { path: string }) => {
            if (state.fail === 'delete' || state.fail === 'stat') throw Error('EACCES');
            for (const p of state.files.keys()) if (p.startsWith(path + '/')) state.files.delete(p);
        },
    },
}));
vi.mock('../services/enc/EncCellStore', () => ({
    storeReady: async () => undefined,
    reserveNoaaResident: (bytes: number) => {
        state.resident += bytes;
        state.maximumResident = Math.max(state.maximumResident, state.resident);
        return {
            release: () => {
                state.resident -= bytes;
            },
        };
    },
    parseNoaaPartOffThread: async (
        text: string,
        manifest: Parameters<typeof parseNoaaPart>[1],
        descriptor: Parameters<typeof parseNoaaPart>[2],
    ) => {
        expect(state.resident).toBe(4 * 1024 * 1024);
        state.active++;
        state.maxActive = Math.max(state.maxActive, state.active);
        await Promise.resolve();
        parseNoaaPart(JSON.parse(text), manifest, descriptor);
        state.active--;
        return { ...manifest.metadata, layers: {}, selectedBytes: 0 };
    },
}));
import {
    stageNoaaPackage,
    assertStagedNoaaPackage,
    noaaPackagePath,
    deleteNoaaPackage,
    readNoaaPackage,
} from '../services/enc/noaaPackageStore';
import type { EncCell, EncConversionResult } from '../services/enc/types';
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
function fixture() {
    const source: EncConversionResult = {
        cellId: 'US3AK1EX',
        sourceHO: 'US',
        edition: 1,
        updateNumber: 0,
        issued: '2026-03-16',
        bbox: [-134, 55, -132, 56],
        layers: {
            DEPARE: {
                type: 'FeatureCollection',
                features: Array.from({ length: 8 }, (_, i) => ({
                    type: 'Feature',
                    properties: { synthetic: 'x'.repeat(600) },
                    geometry: { type: 'Point', coordinates: [-133 + i / 100, 55.5] },
                })),
            },
        },
    };
    const packaged = partitionNoaaRecords(source, 'a'.repeat(64), 2048),
        text = JSON.stringify(packaged.manifest),
        sha256 = hash(text);
    const object = { key: `objects/${sha256}.json`, bytes: Buffer.byteLength(text), sha256 };
    const scope = getAuthIdentityScope();
    const assert = (): void => {
        if (getAuthIdentityScope() !== scope) throw Error('Account changed');
    };
    return {
        ...packaged,
        text,
        object,
        scope,
        assert,
        download: async (part: { sha256: string }) =>
            new TextEncoder().encode(packaged.parts.find((t) => hash(t) === part.sha256)!),
    };
}
beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    state.files.clear();
    state.fail = '';
    state.writes = 0;
    state.active = 0;
    state.maxActive = 0;
    state.resident = 0;
    state.maximumResident = 0;
    setAuthIdentityScope('package-test-a');
});
describe('atomic public NOAA package staging', () => {
    it('checks every sequential part/readback, retains one complete manifest and grants one-use activation authority', async () => {
        const f = fixture(),
            ref = await stageNoaaPackage(f.manifest, f.text, f.object, f.scope, f.download, f.assert);
        expect(state.maxActive).toBe(1);
        expect(state.maximumResident).toBe(4 * 1024 * 1024);
        expect(state.resident).toBe(0);
        expect(state.files.size).toBe(f.parts.length + 1);
        assertStagedNoaaPackage(f.manifest, ref);
        expect(() => assertStagedNoaaPackage(f.manifest, ref)).toThrow();
        const cell = {
            id: 'US3AK1EX',
            sourceHO: 'US',
            edition: 1,
            updateNumber: 0,
            issued: '2026-03-16',
            bbox: [-134, 55, -132, 56],
            licence: 'open',
            contentSha256: f.object.sha256,
            noaaPackage: ref,
        } as EncCell;
        expect(await readNoaaPackage(cell)).toEqual(f.manifest);
        setAuthIdentityScope('package-test-b');
        await expect(readNoaaPackage(cell)).rejects.toThrow('authority');
    });
    it.each(['write', 'read', 'tamper'])(
        'never grants activation after %s failure and keeps the reserved journal',
        async (fault) => {
            const f = fixture();
            state.fail = fault;
            await expect(
                stageNoaaPackage(f.manifest, f.text, f.object, f.scope, f.download, f.assert),
            ).rejects.toThrow();
            expect(state.files.size).toBeGreaterThan(0);
            expect(state.resident).toBe(0);
            expect(() =>
                assertStagedNoaaPackage(f.manifest, { owner: f.scope.key, manifestSha256: f.object.sha256, path: '' }),
            ).toThrow();
        },
    );
    it('account changes cannot finish a delayed part or expose previous account files', async () => {
        const f = fixture();
        await expect(
            stageNoaaPackage(
                f.manifest,
                f.text,
                f.object,
                f.scope,
                async (p) => {
                    setAuthIdentityScope('package-test-b');
                    return f.download(p);
                },
                f.assert,
            ),
        ).rejects.toThrow(/account changed/i);
        expect(state.files.size).toBe(1);
    });
    it('checks the exact account/hash directory and refuses uncertain cleanup instead of releasing quota', async () => {
        const f = fixture();
        await stageNoaaPackage(f.manifest, f.text, f.object, f.scope, f.download, f.assert);
        state.fail = 'stat';
        await expect(deleteNoaaPackage(f.object.sha256, f.scope)).rejects.toThrow('EACCES');
        expect(state.files.size).toBeGreaterThan(0);
        state.fail = '';
        await deleteNoaaPackage(f.object.sha256, f.scope);
        expect(state.files.size).toBe(0);
        await expect(noaaPackagePath('../escape')).rejects.toThrow();
    });
});
