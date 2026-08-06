import { describe, expect, it } from 'vitest';
import { validatePiInstalledCellsForTest } from '../services/EncImportService';

/**
 * The Pi chart index must accept cells the Pi legitimately produced.
 *
 * Shane's Pi served 345 charts — Nouméa, Port Vila and 320 Australian cells —
 * while the app reported "No verified ENC charts installed" for a day. The
 * index validator rejected 344 of them over `source: 'pi-decrypt'`, a value it
 * had never been taught, and 342 over a producer-code rule that does not apply
 * to o-charts identifiers. One bad entry throws away the WHOLE index, and
 * listPiInstalledCharts then swallowed the error and returned [] — which is
 * indistinguishable from "the Pi has no charts".
 *
 * These fixtures are real shapes taken from that Pi.
 */
const auOChartsCell = {
    // o-charts identifier: "OC" is the SET prefix, not a producer code. The
    // cell is Australian and correctly declares sourceHO "AU".
    cellId: 'OC-61-051031',
    sourceHO: 'AU',
    edition: 16,
    issued: '2026-01-16',
    bbox: [150.1, -35.2, 151.4, -33.8],
    featureCount: 4741,
    sizeBytes: 2_929_751,
    installedAt: '2026-08-05T07:55:00.000Z',
    source: 'pi-decrypt',
};
const s57Cell = {
    // Genuine S-57 name: the producer code IS the first two characters, so the
    // cross-check is meaningful here and must stay enforced.
    cellId: 'FR466870',
    sourceHO: 'FR',
    edition: 2,
    issued: '2026-01-16',
    bbox: [166.2, -22.5, 166.6, -22.1],
    featureCount: 2804,
    sizeBytes: 15_460_883,
    installedAt: '2026-08-05T07:55:00.000Z',
    source: 'pi-decrypt',
};

describe('Pi installed-chart index validation', () => {
    it("accepts the Pi's own decrypt source", () => {
        const [cell] = validatePiInstalledCellsForTest({ cells: [auOChartsCell] });
        expect(cell.cellId).toBe('OC-61-051031');
        expect(cell.source).toBe('pi-decrypt');
    });

    it('accepts o-charts identifiers whose prefix is not a producer code', () => {
        expect(validatePiInstalledCellsForTest({ cells: [auOChartsCell] })).toHaveLength(1);
    });

    it('STILL enforces the producer code on genuine S-57 names', () => {
        // This is a real anti-tampering property and must not be lost.
        expect(() => validatePiInstalledCellsForTest({ cells: [{ ...s57Cell, sourceHO: 'AU' }] })).toThrow();
        expect(validatePiInstalledCellsForTest({ cells: [s57Cell] })).toHaveLength(1);
    });

    it('still rejects a non-HO source and a nonsense office code', () => {
        expect(() =>
            validatePiInstalledCellsForTest({ cells: [{ ...auOChartsCell, source: 'somewhere-else' }] }),
        ).toThrow();
        expect(() =>
            validatePiInstalledCellsForTest({ cells: [{ ...auOChartsCell, sourceHO: 'NOT-A-CODE' }] }),
        ).toThrow();
    });

    it('accepts a mixed real-world index rather than discarding all of it', () => {
        expect(validatePiInstalledCellsForTest({ cells: [auOChartsCell, s57Cell] })).toHaveLength(2);
    });
});
