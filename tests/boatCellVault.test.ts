// @vitest-environment node
/**
 * The boat-cell vault (127-C-c decision 2): licensed cells held in memory
 * only, gzip-compressed, bounded by a byte budget. o-charts (Roberto,
 * 2026-10-10): "Storing unencrypted data on any medium, and especially in the
 * cloud, is strictly prohibited by the terms of the licenses signed with the
 * chart providers." Fictional ids and synthetic text only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const probes = vi.hoisted(() => new Map<string, () => number>());
vi.mock('../services/memoryCensus', () => ({
    registerCensusProbe: (name: string, read: () => number) => {
        probes.set(name, read);
        return () => probes.delete(name);
    },
}));

import * as vault from '../services/enc/boatCellVault';

const MiB = 1024 * 1024;
/** Synthetic cell text of about `bytes`, compressible like real JSON. */
const text = (id: string, bytes: number) =>
    JSON.stringify({ cellId: id, pad: 'DEPARE '.repeat(Math.ceil(bytes / 7)).slice(0, bytes) });
/** Random-ish text gzip cannot shrink much: drives the byte budget. */
function noisy(id: string, bytes: number): string {
    let s = '';
    let x = 12345;
    while (s.length < bytes) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        s += x.toString(36);
    }
    return JSON.stringify({ cellId: id, pad: s.slice(0, bytes) });
}
const settle = () => vault.whenCompressed();

beforeEach(() => vault.clear());
afterEach(() => {
    vi.unstubAllGlobals();
    vault.clear();
});

describe('boatCellVault — memory only, bounded, gzip', () => {
    it('round-trips cell text through gzip and reports stored bytes below the text', async () => {
        const body = text('OC-99-ZZ0001', 400_000);
        vault.put('OC-99-ZZ0001', body);
        await settle();
        expect(vault.has('oc-99-zz0001')).toBe(true);
        expect(await vault.getText('OC-99-ZZ0001')).toBe(body);
        const stats = vault.stats();
        expect(stats.cells).toBe(1);
        expect(stats.storedBytes).toBeLessThan(stats.textBytes / 10);
    });

    it('serves the text while its compression is still running', async () => {
        const body = text('OC-99-ZZ0002', 50_000);
        vault.put('OC-99-ZZ0002', body);
        expect(await vault.getText('OC-99-ZZ0002')).toBe(body);
        await settle();
        expect(await vault.getText('OC-99-ZZ0002')).toBe(body);
    });

    // Byte-exact budgets on the plain-text path (no CompressionStream): stored
    // bytes are then the text length, so the arithmetic is deterministic.
    it('evicts least-recently-used cells past the byte budget, never below the min-keep floor', async () => {
        vi.stubGlobal('CompressionStream', undefined);
        // 20 cells of 5.5 MiB: 110 MiB > the 96 MiB plain budget; 17 fit.
        for (let i = 0; i < 20; i++) vault.put(`OC-99-ZZ${String(i).padStart(4, '0')}`, 'x'.repeat(5.5 * MiB));
        const stats = vault.stats();
        expect(stats.storedBytes).toBeLessThanOrEqual(vault.budgetBytes());
        expect(stats.cells).toBe(17);
        expect(vault.has('OC-99-ZZ0000')).toBe(false);
        expect(vault.has('OC-99-ZZ0002')).toBe(false);
        expect(vault.has('OC-99-ZZ0003')).toBe(true);
        expect(vault.has('OC-99-ZZ0019')).toBe(true);
    });

    it('keeps the min-keep floor even when 16 cells overrun the budget', async () => {
        vi.stubGlobal('CompressionStream', undefined);
        for (let i = 0; i < 18; i++) vault.put(`OC-99-ZZ${String(i).padStart(4, '0')}`, 'x'.repeat(7 * MiB));
        expect(vault.stats().cells).toBe(vault.VAULT_MIN_KEEP);
    });

    it('a read touches the cell, so it outlives cells read less recently', async () => {
        vi.stubGlobal('CompressionStream', undefined);
        for (let i = 0; i < 17; i++) vault.put(`OC-99-ZZ${String(i).padStart(4, '0')}`, 'x'.repeat(5.5 * MiB));
        await vault.getText('OC-99-ZZ0000');
        for (let i = 17; i < 20; i++) vault.put(`OC-99-ZZ${String(i).padStart(4, '0')}`, 'x'.repeat(5.5 * MiB));
        expect(vault.has('OC-99-ZZ0000')).toBe(true);
        expect(vault.has('OC-99-ZZ0001')).toBe(false);
        expect(vault.has('OC-99-ZZ0003')).toBe(false);
        expect(vault.has('OC-99-ZZ0004')).toBe(true);
    });

    it('the gzip budget is 40 MiB and compressed cells are counted at their compressed size', async () => {
        expect(vault.budgetBytes()).toBe(vault.VAULT_MAX_STORED_BYTES);
        expect(vault.VAULT_MAX_STORED_BYTES).toBe(40 * MiB);
        vault.put('OC-99-ZZ0010', noisy('c', 2 * MiB));
        await settle();
        const { storedBytes, textBytes } = vault.stats();
        expect(storedBytes).toBeLessThan(textBytes);
        expect(storedBytes).toBeGreaterThan(MiB);
    });

    it('falls back to plain text with the larger budget when CompressionStream is missing', async () => {
        vi.stubGlobal('CompressionStream', undefined);
        const body = text('OC-99-ZZ0003', 100_000);
        vault.put('OC-99-ZZ0003', body);
        await settle();
        expect(await vault.getText('OC-99-ZZ0003')).toBe(body);
        expect(vault.stats().storedBytes).toBe(body.length);
        expect(vault.budgetBytes()).toBe(96 * MiB);
    });

    it('trim(0.5) on a memory warning halves what is stored, oldest first', async () => {
        vi.stubGlobal('CompressionStream', undefined);
        for (let i = 0; i < 10; i++) vault.put(`OC-99-ZZ${String(i).padStart(4, '0')}`, 'x'.repeat(MiB));
        const before = vault.stats().storedBytes;
        vault.trim(0.5);
        expect(vault.stats().storedBytes).toBeLessThanOrEqual(before / 2);
        expect(vault.has('OC-99-ZZ0000')).toBe(false);
        expect(vault.has('OC-99-ZZ0009')).toBe(true);
    });

    it('drop and clear forget cells; the census probe reports stored MB', async () => {
        vault.put('OC-99-ZZ0004', noisy('c', 3 * MiB));
        await settle();
        await vi.waitFor(() => expect(probes.has('encVaultMB')).toBe(true));
        expect(probes.get('encVaultMB')!()).toBeGreaterThanOrEqual(2);
        vault.drop('OC-99-ZZ0004');
        expect(vault.has('OC-99-ZZ0004')).toBe(false);
        vault.put('OC-99-ZZ0005', 'x');
        vault.clear();
        expect(vault.stats()).toMatchObject({ cells: 0, storedBytes: 0 });
        expect(await vault.getText('OC-99-ZZ0005')).toBeNull();
    });

    // 127-C-c review: a fresh put used to count its full text before its gzip
    // landed, so three 6 MB pulls threw out up to half a full vault.
    it('a big put still compressing evicts about its gzip size, not its text size', async () => {
        // A full vault of compressed cells: noisy text keeps roughly 2/3 of its size.
        for (let i = 0; i < 70; i++) vault.put(`OC-99-ZZ${String(i).padStart(4, '0')}`, noisy(`f${i}`, MiB));
        await settle();
        const full = vault.stats();
        expect(full.storedBytes).toBeLessThanOrEqual(vault.budgetBytes());
        expect(full.cells).toBeLessThan(70);
        // Full means full: pulls one after another leave it near its budget, not half empty.
        expect(full.storedBytes).toBeGreaterThan(vault.budgetBytes() * 0.9);
        const perCell = full.storedBytes / full.cells;

        vault.put('OC-99-ZZ9000', text('big', 6 * MiB));
        // Before its gzip lands: charged about 1 MiB, so about two cells go, not ~9.
        const evicted = full.cells + 1 - vault.stats().cells;
        expect(evicted).toBeLessThanOrEqual(Math.ceil(MiB / perCell) + 1);
        await settle();
        expect(vault.stats().storedBytes).toBeLessThanOrEqual(vault.budgetBytes());
        expect(await vault.getText('OC-99-ZZ9000')).toBe(text('big', 6 * MiB));
    });

    it('a cell replaced while its compression runs keeps the newer text', async () => {
        vault.put('OC-99-ZZ0006', text('old', 200_000));
        vault.put('OC-99-ZZ0006', text('new', 200_000));
        await settle();
        expect(await vault.getText('OC-99-ZZ0006')).toBe(text('new', 200_000));
        expect(vault.stats().cells).toBe(1);
    });
});
