/**
 * marine — unit conversion and the snap guard.
 *
 * These are the two ways a marine reading corrupts SILENTLY, which on a boat
 * app is the worst failure mode there is: the number still looks plausible.
 *
 * 1. UNITS. Open-Meteo reports waves in METRES and current in KM/H. The report
 *    boundary carries waves in FEET (the sheltered-water damping multiplies by
 *    M_PER_FT to get back to metres) and current in M/S (what StormGlass gave).
 *    A straight port reads waves 3.3x small and current 3.6x fast.
 *
 * 2. THE SNAP. Open-Meteo's marine grid is ocean-only. An inshore request is
 *    not rejected and does not return nulls — it is snapped to the nearest wet
 *    cell and answered confidently. Measured at Newport 2026-07-22: a request
 *    at -27.2100,153.1000 came back from -27.2083,153.2084 — 10.7 km east, out
 *    in Moreton Bay — with wave_height 0.58 m. Open-water swell presented as a
 *    sheltered anchorage.
 */
import { describe, expect, it } from 'vitest';

import { isLocalReading, mapMarine } from '../services/weather/api/marine';

/** The real Newport response, coordinates and all. */
const NEWPORT_SNAPPED = {
    latitude: -27.2083,
    longitude: 153.2084,
    current: {
        wave_height: 0.58,
        wave_period: 6.4,
        wave_direction: 110,
        swell_wave_height: 0.46,
        swell_wave_period: 4.5,
        swell_wave_direction: 100,
        sea_surface_temperature: 17.5,
        ocean_current_velocity: 3.6, // km/h → 1.0 m/s exactly
        ocean_current_direction: 90,
    },
};

describe('mapMarine — units', () => {
    it('converts wave and swell heights METRES → FEET for the report boundary', () => {
        const r = mapMarine(NEWPORT_SNAPPED, -27.2083, 153.2084, 'pi')!;
        expect(r.waveHeight).toBeCloseTo(0.58 * 3.28084, 2);
        expect(r.swellHeight).toBeCloseTo(0.46 * 3.28084, 2);
    });

    it('converts ocean current KM/H → M/S — a straight port reads 3.6x fast', () => {
        const r = mapMarine(NEWPORT_SNAPPED, -27.2083, 153.2084, 'pi')!;
        expect(r.currentSpeed).toBeCloseTo(1.0, 3);
    });

    it('leaves periods, directions and sea temperature in their native units', () => {
        const r = mapMarine(NEWPORT_SNAPPED, -27.2083, 153.2084, 'pi')!;
        expect(r.wavePeriod).toBe(6.4);
        expect(r.swellPeriod).toBe(4.5);
        expect(r.waterTemperature).toBe(17.5);
        expect(r.currentDirection).toBe(90);
        // NOT inverted. StormGlass's mapper added 180 to current direction;
        // carrying that over would flip every current arrow on the chart.
        expect(r.currentDirection).not.toBe(270);
    });

    it('passes nulls through rather than coercing them to zero', () => {
        const r = mapMarine({ latitude: 0, longitude: 0, current: { wave_height: null } }, 0, 0, 'pi')!;
        expect(r.waveHeight).toBeNull();
        expect(r.waterTemperature).toBeNull();
    });
});

describe('mapMarine — the snap guard', () => {
    it('measures the real Newport snap at ~10.7 km', () => {
        const r = mapMarine(NEWPORT_SNAPPED, -27.21, 153.1, 'pi')!;
        expect(r.snappedKm).toBeGreaterThan(10);
        expect(r.snappedKm).toBeLessThan(11.5);
    });

    it('REFUSES the Newport reading as local — this is the safety case', () => {
        // 0.58 m of open-water swell must never be presented as the conditions
        // in a sheltered bay 10.7 km away.
        const r = mapMarine(NEWPORT_SNAPPED, -27.21, 153.1, 'pi');
        expect(isLocalReading(r)).toBe(false);
    });

    it('accepts an offshore point the grid barely moves', () => {
        const offshore = { ...NEWPORT_SNAPPED, latitude: -26.5, longitude: 153.4 };
        const r = mapMarine(offshore, -26.5, 153.402, 'pi');
        expect(r!.snappedKm).toBeLessThan(1);
        expect(isLocalReading(r)).toBe(true);
    });

    it('refuses a reading with no echoed coordinate — unprovable is not local', () => {
        // Without the grid point we cannot show the reading is about here, and
        // for a safety number unprovable is refused rather than assumed.
        expect(mapMarine({ current: { wave_height: 1 } }, -27.21, 153.1, 'pi')).toBeNull();
    });

    it('returns null when there is no current block at all', () => {
        expect(mapMarine({ latitude: -27.21, longitude: 153.1 }, -27.21, 153.1, 'pi')).toBeNull();
        expect(isLocalReading(null)).toBe(false);
    });

    it('records which machine served it, for the parity line', () => {
        expect(mapMarine(NEWPORT_SNAPPED, -27.2083, 153.2084, 'pi')!.via).toBe('pi');
        expect(mapMarine(NEWPORT_SNAPPED, -27.2083, 153.2084, 'supabase')!.via).toBe('supabase');
    });
});
