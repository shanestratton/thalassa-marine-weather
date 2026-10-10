/**
 * Charts stay on the boat (127-C-b): the Route tracer's tide windows never send
 * a charted shallow spot off the device.
 *
 * A needs-tide leg's `minAt` is the shallowest charted sounding on it. The
 * per-leg window ("clears 08:45–14:30 today") and the report's common
 * departure window (also run by the Log's background re-check) asked for the
 * tide curve AT that point, which went to the Pi, the tide proxy and
 * WorldTides at full precision. They now ask for the whole-span curve at its
 * 0.25° bucket centre, as the router's ceilings, Auto's chips and the
 * departure sweep do. Fictional spots: Nouméa lagoon and the Chesapeake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const wt = vi.hoisted(() => ({ at: [] as [number, number][] }));
vi.mock('../services/weather/api/worldtides', () => ({
    fetchWorldTides: vi.fn(async (lat: number, lon: number) => {
        wt.at.push([lat, lon]);
        const t0 = Math.floor(Date.now() / 1000) - 24 * 3600;
        return {
            status: 200,
            responseDatum: 'LAT',
            extremes: Array.from({ length: 40 }, (_, k) => ({
                dt: t0 + k * 22_320,
                date: '',
                height: k % 2 === 0 ? 0.2 : 2.1,
                type: k % 2 === 0 ? 'Low' : 'High',
            })),
        };
    }),
}));

import { clearTideCache } from '../services/TideHeightService';
import { commonDepartureWindowLabel, tideWindowLabelFor, type TraceLegVerdict } from '../services/routeTracer';

const SOUNDINGS = [
    { lat: -22.3011, lon: 166.4233, bucket: [-22.25, 166.5] },
    { lat: 38.9734, lon: -76.4521, bucket: [39, -76.5] },
];

const gated = (at: { lat: number; lon: number }): TraceLegVerdict => ({
    grade: 'caution',
    issues: [],
    minDepthM: 1.4,
    minAt: { lat: at.lat, lon: at.lon },
    needsTide: true,
    nudge: null,
    nudgeTo: null,
});

describe('the tracer asks for tides at the bucket centre, never at the charted sounding', () => {
    beforeEach(() => {
        wt.at.length = 0;
        clearTideCache();
    });

    it('the per-leg tide window', async () => {
        for (const spot of SOUNDINGS) {
            clearTideCache();
            await tideWindowLabelFor(1.4, 2.4, { lat: spot.lat, lon: spot.lon }, Date.now());
            expect(wt.at.at(-1), `${spot.lat},${spot.lon}`).toEqual(spot.bucket);
        }
        expect(wt.at.flat()).not.toContain(-22.3011);
        expect(wt.at.flat()).not.toContain(-76.4521);
    });

    it("the report's common departure window (and the Log's re-check)", async () => {
        const label = await commonDepartureWindowLabel(
            SOUNDINGS.map((spot) => gated(spot)),
            2.4,
            { departureMs: Date.now() },
        );
        expect(label).not.toBeNull();
        expect(wt.at).toEqual(SOUNDINGS.map((spot) => spot.bucket));
    });
});
