import { describe, expect, it } from 'vitest';
import type { ShipLogEntry } from '../types';
import { stripInitialTrackWarmupRebounds } from '../services/shiplog/initialTrackWarmupGuard';

const LAT = -27.5;
const LON = 153;
const METRES_PER_DEG_LAT = 111_320;
const METRES_PER_DEG_LON = METRES_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);
const T0 = Date.parse('2026-07-26T00:00:00.000Z');

function entry(
    id: string,
    northM: number,
    eastM: number,
    elapsedMs: number,
    overrides: Partial<ShipLogEntry> = {},
): ShipLogEntry {
    return {
        id,
        userId: 'skipper',
        voyageId: 'voyage-1',
        timestamp: new Date(T0 + elapsedMs).toISOString(),
        latitude: LAT + northM / METRES_PER_DEG_LAT,
        longitude: LON + eastM / METRES_PER_DEG_LON,
        positionFormatted: '',
        entryType: 'auto',
        source: 'device',
        ...overrides,
    } as ShipLogEntry;
}

function voyageStart(id = 'start', elapsedMs = 0): ShipLogEntry {
    return entry(id, 0, 0, elapsedMs, { entryType: 'waypoint', waypointName: 'Voyage Start' });
}

describe('stripInitialTrackWarmupRebounds', () => {
    it('removes only the distant middle fix in the early Voyage Start → A → B rebound', () => {
        const entries = [
            voyageStart(),
            entry('warmup-outlier', 0, 120, 5_000),
            entry('corroborated-fix', 4, 6, 10_000),
            entry('underway', 20, 40, 15_000),
        ];

        const result = stripInitialTrackWarmupRebounds(entries);

        expect(result.map(({ id }) => id)).toEqual(['start', 'corroborated-fix', 'underway']);
        expect(entries.map(({ id }) => id)).toEqual(['start', 'warmup-outlier', 'corroborated-fix', 'underway']);
    });

    it('keeps a normal early departure that does not return to the start', () => {
        const entries = [voyageStart(), entry('first-leg', 0, 90, 5_000), entry('second-leg', 0, 180, 10_000)];

        expect(stripInitialTrackWarmupRebounds(entries).map(({ id }) => id)).toEqual(entries.map(({ id }) => id));
    });

    it('keeps a rebound that is not tightly adjacent to startup acquisition', () => {
        const entries = [voyageStart(), entry('first-leg', 0, 100, 5_000), entry('return-later', 0, 5, 65_000)];

        expect(stripInitialTrackWarmupRebounds(entries).map(({ id }) => id)).toEqual(entries.map(({ id }) => id));
    });

    it('does not infer a rebound without a real Voyage Start marker', () => {
        const entries = [entry('first-fix', 0, 0, 0), entry('middle', 0, 120, 5_000), entry('return', 4, 6, 10_000)];

        expect(stripInitialTrackWarmupRebounds(entries).map(({ id }) => id)).toEqual(entries.map(({ id }) => id));
    });

    it('isolates the detection to the matching voyage', () => {
        const entries = [
            voyageStart('v1-start'),
            entry('v1-outlier', 0, 120, 5_000),
            entry('v1-return', 4, 6, 10_000),
            entry('v2-start', 0, 0, 0, { voyageId: 'voyage-2', entryType: 'waypoint', waypointName: 'Voyage Start' }),
            entry('v2-first', 0, 100, 5_000, { voyageId: 'voyage-2' }),
            entry('v2-away', 0, 200, 10_000, { voyageId: 'voyage-2' }),
        ];

        expect(stripInitialTrackWarmupRebounds(entries).map(({ id }) => id)).toEqual([
            'v1-start',
            'v1-return',
            'v2-start',
            'v2-first',
            'v2-away',
        ]);
    });
});
