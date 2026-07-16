/**
 * publishRouteNotValidated (2026-07-17 audit, silent-failure cluster):
 * when a validation race times out or throws, the drawn route used to ship
 * silently while the panel kept the PREVIOUS route's clean report. This
 * locks the loud replacement.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/enc/EncHazardService', () => ({ getIndexForCell: vi.fn() }));
vi.mock('../../services/enc/EncCellMetadata', () => ({ listCells: vi.fn(async () => []) }));

import {
    getLastReport,
    publishRouteNotValidated,
    setLastReport,
    subscribeToReport,
} from '../../services/enc/EncHazardReportService';

describe('publishRouteNotValidated', () => {
    beforeEach(() => setLastReport(null));

    it('publishes a loud caution report naming the reason', () => {
        publishRouteNotValidated('depth validation timed out (30 s)');
        const r = getLastReport();
        expect(r).not.toBeNull();
        expect(r!.entries).toEqual([]);
        expect(r!.advisories).toHaveLength(1);
        expect(r!.advisories![0].severity).toBe('caution');
        expect(r!.advisories![0].text).toContain('Route NOT verified');
        expect(r!.advisories![0].text).toContain('timed out (30 s)');
    });

    it('REPLACES a stale clean report — never leaves the previous green face up', () => {
        setLastReport({ cellsConsulted: 5, bufferNm: 1.0, entries: [], advisories: [] });
        publishRouteNotValidated('depth validation failed');
        const r = getLastReport();
        expect(r!.cellsConsulted).toBe(0);
        expect(r!.advisories![0].text).toContain('NOT verified');
    });

    it('notifies report subscribers so the panel re-renders', () => {
        const listener = vi.fn();
        const unsub = subscribeToReport(listener);
        publishRouteNotValidated('x');
        expect(listener).toHaveBeenCalledTimes(1);
        unsub();
    });
});
