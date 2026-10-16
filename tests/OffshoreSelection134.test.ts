import { describe, expect, it, vi } from 'vitest';
import { runOffshoreJob } from '../services/routing/offshoreJob';
import { verifyOffshoreSelection } from '../services/routing/offshoreSelection';
import type { OffshoreJob } from '../services/routing/offshoreProtocol';
import type { IsochroneEnvironment } from '../services/routing/isochroneEnvironment';
function job(): OffshoreJob {
    const frame = (value: number) => new Float32Array(9).fill(value);
    return {
        origin: { lat: 0, lon: -30 },
        destination: { lat: 0, lon: -29.8 },
        departureTime: '2026-10-17T00:00:00Z',
        polar: {
            angles: [40, 90, 180],
            windSpeeds: [5, 20],
            matrix: [
                [6, 7],
                [6, 7],
                [6, 7],
            ],
        },
        wind: {
            u: Array.from({ length: 24 }, () => frame(5)),
            v: Array.from({ length: 24 }, () => frame(0)),
            speed: Array.from({ length: 24 }, () => frame(5)),
            gust: Array.from({ length: 24 }, () => frame(9)),
            width: 3,
            height: 3,
            lats: [-2, 0, 2],
            lons: [-32, -30, -28],
            north: 2,
            south: -2,
            west: -32,
            east: -28,
            totalHours: 24,
            refTime: '2026-10-17T00:00:00Z',
        },
        bathymetry: {
            south: -2,
            north: 2,
            west: -32,
            east: -28,
            latStep: 2,
            lonStep: 2,
            rows: 3,
            cols: 3,
            data: frame(-2000),
        },
        environment: {
            departureMs: Date.parse('2026-10-17T00:00:00Z'),
            currentVectors: null,
            waves: null,
            cyclones: null,
        },
        config: { timeStepHours: 1, maxHours: 24, bearingCount: 12, powerVessel: true, motoringSpeed: 6 },
        deadlineMs: Date.now() + 60_000,
    };
}

async function fixture() {
    const input = job();
    const candidate = (await runOffshoreJob(input))!;
    const environment: IsochroneEnvironment = {
        departureMs: Date.parse(input.departureTime),
        currentField: null,
        waveField: null,
        exclusionField: null,
        notes: ['Synthetic environment — fields unknown.'],
        snapshot: input.environment,
    };
    const report = { cellsConsulted: 1, bufferNm: 1, entries: [], advisories: [] };
    const validate = vi.fn(async (route: typeof candidate.result.route) => ({
        route,
        verified: true,
        hazardReport: report,
    }));
    return {
        candidate,
        job: input,
        environment,
        cruisingSpeed: 6,
        withTerminals: (route: typeof candidate.result.route) => route,
        validate,
        isCurrent: () => true,
    };
}
describe('final offshore candidate promotion', () => {
    it('adds only current accepted number-free routing-area caveats to the selected result', async () => {
        const opts = await fixture(),
            words = 'No verified marine park dataset is retained; marine park caution is unavailable.';
        opts.validate.mockImplementation(async (route) => ({
            route,
            verified: true,
            hazardReport: null as never,
            areaCaveats: [words, 'Private chart coordinates 153.5 -27.5'],
        }));
        const selected = await verifyOffshoreSelection(opts);
        expect(selected.result.environmentNotes).toContain(words);
        expect(selected.result.environmentNotes?.join(' ')).not.toContain('Private chart coordinates');
        expect(opts.candidate.result.environmentNotes ?? []).not.toContain(words);
    });
    it('preserves the modeled clock only for unchanged verified geometry, retaining a private hazard report', async () => {
        const opts = await fixture();
        const selected = await verifyOffshoreSelection(opts);
        expect(selected.verification).toBe('verified-final-geometry');
        expect(selected.result.routeCoordinates).toEqual(opts.candidate.result.routeCoordinates);
        expect(selected.result.totalDurationHours).toBe(opts.candidate.result.totalDurationHours);
        expect(selected.result.motorHours).toBeGreaterThan(0);
        expect(selected.hazardReport).toEqual({ cellsConsulted: 1, bufferNm: 1, entries: [], advisories: [] });
        expect(opts.candidate.verification).toBe('unverified-public-data');
    });
    it('uses the actual checked detour and marks propulsion unknown instead of attaching the old route metrics', async () => {
        const opts = await fixture();
        opts.validate.mockImplementation(async (route) => ({
            route: route.map((point, i) => (i === 1 ? { ...point, lat: point.lat + 0.05 } : point)),
            verified: true,
            hazardReport: null as never,
        }));
        const selected = await verifyOffshoreSelection(opts);
        expect(selected.result.route[1].lat).not.toBe(opts.candidate.result.route[1].lat);
        expect(selected.result.routeCoordinates[1]).toEqual([
            selected.result.route[1].lon,
            selected.result.route[1].lat,
        ]);
        expect(selected.result.motorHours).toBeNull();
        expect(selected.upwindPercent).toBeNull();
        expect(selected.result.environmentNotes!.join(' ')).toContain('Chart verification changed');
    });
    it('rejects a failed chart verdict and a stale async verdict', async () => {
        const opts = await fixture();
        opts.validate.mockImplementation(async (route) => ({ route, verified: false, hazardReport: null as never }));
        await expect(verifyOffshoreSelection(opts)).rejects.toThrow('verification did not complete');
        let current = true;
        opts.isCurrent = () => current;
        opts.validate.mockImplementation(async (route) => {
            current = false;
            return { route, verified: true, hazardReport: null as never };
        });
        await expect(verifyOffshoreSelection(opts)).rejects.toThrow('no longer current');
    });
    it('rejects a chart detour outside the original model grid rather than reusing raw candidate wind', async () => {
        const opts = await fixture();
        opts.validate.mockImplementation(async (route) => ({
            route: route.map((point, i) => (i === 1 ? { ...point, lat: 8 } : point)),
            verified: true,
            hazardReport: null as never,
        }));
        await expect(verifyOffshoreSelection(opts)).rejects.toThrow('forecast coverage');
    });
    it('rechecks exclusions on the exact final route and refuses actual gust exceedance', async () => {
        const opts = await fixture();
        opts.environment.exclusionField = { isExcluded: () => true };
        await expect(verifyOffshoreSelection(opts)).rejects.toThrow('cyclone exclusion');
        opts.environment.exclusionField = null;
        opts.job.config.comfortParams = { maxGustKts: 5 };
        await expect(verifyOffshoreSelection(opts)).rejects.toThrow('wind/gust limits');
    });
    it('does not extend the forecast for a late departure', async () => {
        const opts = await fixture();
        opts.job.departureTime = '2026-10-17T23:00:00Z';
        await expect(verifyOffshoreSelection(opts)).rejects.toThrow('forecast coverage');
    });
});
