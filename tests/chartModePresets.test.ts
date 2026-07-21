/**
 * ChartModes presets must never switch on a PARKED layer.
 *
 * Parked layers (waves / seaice / mld) were removed from the layer pickers on
 * 2026-07-18 precisely so they could not be left stuck on. But the 'Offshore'
 * preset still listed 'waves', so one tap turned on a layer with no control to
 * turn it off — the exact failure the parking existed to prevent. It only
 * appeared to heal because restoreActiveLayers drops parked layers at the next
 * launch; within the session it was stuck.
 *
 * This is a rule, not a one-off fix: any future preset that reaches for a
 * parked layer fails here.
 */
import { describe, expect, it } from 'vitest';

import { MODE_SPECS } from '../components/map/ChartModes';
import { PARKED_SEA_LAYERS, isParkedLayer, type WeatherLayer } from '../components/map/mapConstants';

describe('ChartModes presets', () => {
    it('never enable a layer that has no picker to turn it off', () => {
        const offenders = MODE_SPECS.flatMap((m) =>
            (m.sky ?? []).filter((l) => isParkedLayer(l as WeatherLayer)).map((l) => `${m.label} → ${l}`),
        );
        expect(offenders).toEqual([]);
    });

    it('the Offshore preset specifically is clean', () => {
        const offshore = MODE_SPECS.find((m) => m.label === 'Offshore');
        expect(offshore).toBeDefined();
        expect(offshore!.sky).not.toContain('waves');
        // …and still does the job it is named for.
        expect(offshore!.sky).toContain('wind');
    });

    it("each preset's summary does not advertise a layer it no longer enables", () => {
        for (const m of MODE_SPECS) {
            for (const parked of PARKED_SEA_LAYERS) {
                if ((m.summary ?? '').toLowerCase().includes(parked)) {
                    expect((m.sky ?? []).includes(parked)).toBe(true);
                }
            }
        }
    });
});
