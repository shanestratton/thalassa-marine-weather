/**
 * putCell must be a TRUE upsert — kill #41 (2026-08-12, /plan, 15.6 h
 * session). The sync passes (personalCellSync + cloudCellSync) re-assert
 * every cell's metadata on each lap. putCell wrote and notify()'d
 * unconditionally; notify() bumps the registry version; the version is baked
 * into the merge cache key — so every no-op lap invalidated EVERY cached
 * merge, and the fatal trail shows the same 3-cell/8.1 MB window re-merged
 * six times in 24 s, ~100 MB of parse transient per lap, until WebKit
 * reaped the page. Identical in ⇒ nothing out: no write, no version bump.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { putCell, getVersion, getCell, clearAllCellMetadata } from '../services/enc/EncCellMetadata';
import type { EncCell } from '../services/enc/types';

const cell = (over: Partial<EncCell> = {}): EncCell => ({
    id: 'AU5MB01P',
    sourceHO: 'AHO',
    edition: 3,
    issued: '2026-01-15',
    importedAt: '2026-08-01T00:00:00.000Z',
    bbox: [153.0, -27.5, 153.5, -27.0],
    geojsonPath: 'enc/AU5MB01P.json',
    hazardCount: 12,
    usage: 'navigation',
    ...over,
});

beforeEach(() => {
    localStorage.clear();
    clearAllCellMetadata();
});

describe('putCell true-upsert (kill #41)', () => {
    it('a byte-identical re-record bumps NOTHING — no version, no merge-cache invalidation', () => {
        putCell(cell());
        const versionAfterFirst = getVersion();
        putCell(cell());
        putCell(cell());
        putCell(cell());
        expect(getVersion()).toBe(versionAfterFirst);
        expect(getCell('AU5MB01P')?.edition).toBe(3);
    });

    it('a REAL change still writes and bumps the version', () => {
        putCell(cell());
        const versionAfterFirst = getVersion();
        putCell(cell({ edition: 4, sizeBytes: 999 } as Partial<EncCell>));
        expect(getVersion()).toBeGreaterThan(versionAfterFirst);
        expect(getCell('AU5MB01P')?.edition).toBe(4);
    });

    it('an alias cleanup is a real change even with identical record bytes', () => {
        // Two ids sharing one storage identity (case difference) — the
        // canonical write must still collapse the alias and notify.
        putCell(cell());
        localStorage.setItem('thalassa.enc.cell:au5mb01p', JSON.stringify(cell({ id: 'au5mb01p' })));
        const raw = localStorage.getItem('thalassa.enc.cell.index');
        const ids = raw ? (JSON.parse(raw) as string[]) : [];
        localStorage.setItem('thalassa.enc.cell.index', JSON.stringify([...ids, 'au5mb01p']));
        const versionBefore = getVersion();
        putCell(cell());
        expect(getVersion()).toBeGreaterThan(versionBefore);
    });
});
