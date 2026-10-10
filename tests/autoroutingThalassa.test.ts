/**
 * Auto routes on the phone with Thalassa's own router (2026-10-01).
 *
 * Shane 2026-09-30: "sevenc's has never been connected properly, it does not
 * work, it can go at your leisure". The provider is tryInshoreRoute — the
 * engine every Pro user already runs through the manual ⚡ Auto route — with
 * Auto's stricter framing: plain reasons before the engine runs, never a
 * straight line, the planner's Phase 2a disclosure carried with the route.
 * The engine, the land backstop and the cloud chart fill are mocked here; the
 * real engine on synthetic cells is tests/autoroutingThalassa.engine.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    tryInshoreRoute: vi.fn(),
    hasEncCoverageForRoute: vi.fn(() => true),
    crossesLand: vi.fn(),
    fill: vi.fn(),
    listCells: vi.fn(() => [{ id: 'OC-99-SYN001' }] as unknown[]),
    invoke: vi.fn(),
    packs: vi.fn(async () => [] as unknown[]),
    notices: vi.fn(async () => [] as unknown[]),
    trialOn: true,
    // The boat's Pi (127-C-c): not paired unless a test says otherwise.
    ensureBoatCells: vi.fn(async () => ({ state: 'none', pulled: 0, ms: 0, missing: 0 }) as Record<string, unknown>),
    boatState: 'none' as string,
    boatWhy: null as string | null,
    order: [] as string[],
}));

vi.mock('../services/InshoreRouter', () => ({
    tryInshoreRoute: m.tryInshoreRoute,
    hasEncCoverageForRoute: m.hasEncCoverageForRoute,
    MAX_INSHORE_NM: 50,
}));
vi.mock('../services/routing/landBackstop', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    inshoreRouteCrossesLand: m.crossesLand,
}));
vi.mock('../services/enc/cloudCellSync', () => ({ downloadCloudCellsForBBox: m.fill }));
vi.mock('../services/enc/piCellSync', () => ({
    ensureBoatCells: m.ensureBoatCells,
    boatRegistryState: () => m.boatState,
    boatRegistryWhy: () => m.boatWhy,
    boatName: () => "L'Étoile du Pacifique",
}));
vi.mock('../services/enc/EncCellMetadata', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    listCells: m.listCells,
}));
vi.mock('../services/supabase', () => ({ supabase: { functions: { invoke: m.invoke } } }));
vi.mock('../services/ntmRouting', () => ({ packsForCorridor: m.packs }));
vi.mock('../services/localNotices', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    loadLocalNotices: m.notices,
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// Settings → Preferences → "Auto route (trial)" (2026-10-01): off by default,
// on here unless a test says otherwise (tests/AutorouteTrialSwitch.test.tsx
// runs the real store).
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { autorouteTrialEnabled: m.trialOn } }) },
}));

import {
    calculateThalassaProposal,
    getThalassaAutorouteStatus,
    THALASSA_PLANNED_ONLY_WARNING,
} from '../services/autoroutingThalassa';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { inshoreRouteCaveats } from '../components/map/inshoreRouteNotice';
import { inshoreSegmentStates, surveyAmberMetres } from '../components/map/inshoreRouteState';
import { thalassaVesselWarnings } from '../services/autoroutingVesselProfile';
import { applyWaterPack } from '../services/waterPack/waterPackWords';
import type { AutoroutingVesselProfile } from '../types/autorouting';

// Invented open water in the Tasman Sea; no real chart data.
const DEP = { lat: -31.0, lon: 161.0 };
const DEST = { lat: -31.05, lon: 161.06 };
const PROFILE: AutoroutingVesselProfile = {
    length: { status: 'measured', valueM: 14 },
    beam: { status: 'measured', valueM: 4.9 },
    airDraft: { status: 'measured', valueM: 18 },
    draftStatus: 'measured',
};
const request = (overrides: Record<string, unknown> = {}) => ({
    departure: DEP,
    destination: DEST,
    draftM: 2.4,
    speedKts: 6,
    vesselProfile: structuredClone(PROFILE),
    ...overrides,
});
const polyline: [number, number][] = [
    [DEP.lon, DEP.lat],
    [161.02, -31.01],
    [161.04, -31.03],
    [DEST.lon, DEST.lat],
];
const engineResult = (overrides: Record<string, unknown> = {}) => ({
    polyline: polyline.map(([lon, lat]) => [lon, lat] as [number, number]),
    cautionMask: [false, true, false],
    canalMask: [false, false, false],
    channelMask: [false, false, true],
    offshoreMask: [false, false, false],
    chartedShallowMask: [false, true, false],
    landPaintConflictMask: [false, false, false],
    tideDepthM: [null, 1.2, null],
    tideNeedM: 2.9,
    shallowRuns: [],
    chartedShallowSpans: [],
    surveyRuns: [
        {
            startSeg: 0,
            startT: 0,
            endSeg: 0,
            endT: 1,
            lengthM: 300,
            reason: 'survey-ungraded',
            midLat: -31.005,
            midLon: 161.01,
        },
    ],
    structuresUnknownCells: ['OC-99-SYN001'],
    distanceNM: 4.2,
    cellsUsed: ['OC-99-SYN001'],
    elapsedMs: 1234,
    ...overrides,
});

beforeEach(() => {
    vi.useRealTimers();
    setAuthIdentityScope('user-1');
    m.trialOn = true;
    m.tryInshoreRoute.mockReset();
    m.hasEncCoverageForRoute.mockReset().mockReturnValue(true);
    m.crossesLand.mockReset().mockResolvedValue({ status: 'verified', crossesLand: false, runs: [] });
    m.fill.mockReset();
    m.listCells.mockReset().mockReturnValue([{ id: 'OC-99-SYN001' }]);
    m.invoke.mockReset();
    m.packs.mockReset().mockResolvedValue([]);
    m.notices.mockReset().mockResolvedValue([]);
    m.ensureBoatCells.mockReset().mockResolvedValue({ state: 'none', pulled: 0, ms: 0, missing: 0 });
    m.boatState = 'none';
    m.boatWhy = null;
    m.order = [];
});
afterEach(() => setAuthIdentityScope(null));

describe('Auto status, computed on the phone', () => {
    it('is enabled for a signed-in identity and ready with an installed navigation chart — no network call', () => {
        expect(getThalassaAutorouteStatus()).toEqual({ enabled: true, ready: true });
        expect(m.invoke).not.toHaveBeenCalled();
    });

    it('says to install charts when none are installed, and is disabled signed out', () => {
        m.listCells.mockReturnValue([]);
        expect(getThalassaAutorouteStatus()).toEqual({
            enabled: true,
            ready: false,
            message: 'Install charts for your area to use Auto. Manual is ready.',
        });
        setAuthIdentityScope(null);
        expect(getThalassaAutorouteStatus().enabled).toBe(false);
    });

    // Opt-in (2026-10-01): Pro is every account while the public beta is on,
    // so Auto stays closed until the skipper turns the switch on, and says where.
    it('is closed until Auto route (trial) is switched on in Preferences, and says where the switch is', () => {
        m.trialOn = false;
        expect(getThalassaAutorouteStatus()).toEqual({
            enabled: false,
            ready: false,
            message: 'Auto route (trial) is off. Turn it on in Settings → Preferences. Manual is ready.',
        });
        // Signed out still says sign in first.
        setAuthIdentityScope(null);
        expect(getThalassaAutorouteStatus().message).toBe('Sign in to use Auto routing. Manual is ready.');
        expect(m.invoke).not.toHaveBeenCalled();
    });
});

describe('calculateThalassaProposal', () => {
    it('refuses while Auto route (trial) is off, before the engine, the land check or a chart fill', async () => {
        m.trialOn = false;
        m.tryInshoreRoute.mockResolvedValue(engineResult());
        await expect(calculateThalassaProposal(request())).rejects.toThrow(
            'Auto route (trial) is off. Turn it on in Settings → Preferences. Manual is ready.',
        );
        expect(m.tryInshoreRoute).not.toHaveBeenCalled();
        expect(m.crossesLand).not.toHaveBeenCalled();
        expect(m.fill).not.toHaveBeenCalled();
    });

    it('returns the engine polyline exactly, with the planned-only line, the caveats and the disclosure', async () => {
        const res = engineResult();
        m.tryInshoreRoute.mockResolvedValue(res);
        const progress = vi.fn();
        const before = Date.now();
        const route = await calculateThalassaProposal(request(), undefined, progress);
        expect(route.provider).toBe('Thalassa');
        expect(route.id).toMatch(/^thalassa-[0-9a-z]+-[0-9a-z]+$/);
        expect(Date.parse(route.createdAt)).toBeGreaterThanOrEqual(before - 1000);
        expect(route.coordinates).toEqual(polyline);
        expect(route.vesselProfile).toEqual(PROFILE);
        expect(route.warnings[0]).toBe(THALASSA_PLANNED_ONLY_WARNING);
        expect(route.warnings[1]).toBe(
            'Routed on this phone by Thalassa from your installed charts: draft 2.40 m + 0.5 m under the keel at chart datum (LAT). Tide is shown, never assumed.',
        );
        // Auto draws the survey dots, so the words name them (2026-10-01 review).
        const caveats = inshoreRouteCaveats({
            ...(res as unknown as Parameters<typeof inshoreRouteCaveats>[0]),
            surveyAmber: surveyAmberMetres(
                res.polyline,
                inshoreSegmentStates(res as never),
                res.surveyRuns as never,
                res.chartedShallowSpans,
            ),
        });
        expect(caveats.length).toBeGreaterThan(0);
        expect(caveats.join(' ')).toContain('(amber dots)');
        expect(route.warnings.slice(2, 2 + caveats.length)).toEqual(caveats);
        expect(route.warnings.slice(2 + caveats.length)).toEqual(thalassaVesselWarnings(PROFILE));
        expect(route.engine?.stateMask).toEqual(inshoreSegmentStates(res as never));
        expect(route.engine).toMatchObject({
            cautionMask: res.cautionMask,
            channelMask: res.channelMask,
            tideDepthM: res.tideDepthM,
            tideNeedM: 2.9,
            surveyRuns: res.surveyRuns,
            structuresUnknownCells: ['OC-99-SYN001'],
            cellsUsed: ['OC-99-SYN001'],
            distanceNM: 4.2,
            backstop: 'verified',
        });
        expect(progress).toHaveBeenCalledWith('Following deep water…');
        expect(m.invoke).not.toHaveBeenCalled();
    });

    // 127-ROUTE-W: the router runs in a worker, Auto's ✕ really stops it, and
    // the status says which stage it is at (Shane, 2026-10-10: "yes for a
    // short while it looked as though the app had frozen").
    it('hands the engine its stop signal and a stage listener, and says each stage in plain words', async () => {
        m.tryInshoreRoute.mockImplementation(async (...args: unknown[]) => {
            const opts = args[5] as { onStage?: (stage: string) => void };
            opts.onStage?.('queued');
            opts.onStage?.('routing');
            opts.onStage?.('routing-main');
            opts.onStage?.('done');
            return engineResult();
        });
        const stop = new AbortController();
        const progress = vi.fn();
        await calculateThalassaProposal(request(), stop.signal, progress);
        const opts = m.tryInshoreRoute.mock.calls[0][5];
        expect(opts.signal).toBe(stop.signal);
        expect(opts.onStage).toBeTypeOf('function');
        expect(progress.mock.calls.map((c) => c[0])).toEqual([
            'Following deep water…',
            'Waiting for the route before this one…',
            'Routing round the land…',
            'Routing round the land (the screen may pause)…',
            'Checking the route…',
        ]);
    });

    it('a stop while the router runs ends Auto with an AbortError and no route', async () => {
        const stop = new AbortController();
        m.tryInshoreRoute.mockImplementation(async (...args: unknown[]) => {
            const opts = args[5] as { signal?: AbortSignal };
            stop.abort();
            opts.signal?.throwIfAborted();
            return engineResult();
        });
        await expect(calculateThalassaProposal(request(), stop.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(m.crossesLand).not.toHaveBeenCalled();
    });

    it('calls the engine once, safest, with the air draft and the departure time', async () => {
        m.tryInshoreRoute.mockResolvedValue(engineResult());
        const now = Date.now();
        await calculateThalassaProposal(request());
        expect(m.tryInshoreRoute).toHaveBeenCalledTimes(1);
        const [o, d, draft, air, profile, opts] = m.tryInshoreRoute.mock.calls[0];
        expect(o).toEqual(DEP);
        expect(d).toEqual(DEST);
        expect(draft).toBe(2.4);
        expect(air).toBe(18);
        expect(profile).toBe('safest');
        expect(opts.departureMs).toBeGreaterThanOrEqual(now - 1000);
    });

    it('passes a null air draft when it is not set, so every structure blocks (D5)', async () => {
        m.tryInshoreRoute.mockResolvedValue(engineResult());
        const route = await calculateThalassaProposal(
            request({ vesselProfile: { ...PROFILE, airDraft: { status: 'missing' } } }),
        );
        expect(m.tryInshoreRoute.mock.calls[0][3]).toBeNull();
        expect(route.warnings).toContain('Air draft not set: every bridge and power line blocks the route.');
    });

    it.each([
        [
            'no-tide-clears',
            'No route for 2.4 m draft: the only way through crosses Synthetic Bank, charted 0.5 m; the highest tide is 1.8 m and you need 2.9 m.',
        ],
        ['air-draft-blocked', 'Route not possible: a bridge with 12.0 m clearance blocks your 18.0 m air draft.'],
    ])('throws the %s refusal verbatim and draws nothing', async (code, error) => {
        m.tryInshoreRoute.mockResolvedValue({ error, code });
        await expect(calculateThalassaProposal(request())).rejects.toThrow(error);
        expect(m.crossesLand).not.toHaveBeenCalled();
    });

    it('names the watchdog plainly, and passes other engine refusals whole', async () => {
        m.tryInshoreRoute.mockResolvedValue({ error: 'Inshore routing timed out', code: 'watchdog-timeout' });
        await expect(calculateThalassaProposal(request())).rejects.toThrow(
            'Routing took longer than this phone allows (85 s). Try a shorter passage. Nothing changed.',
        );
        m.tryInshoreRoute.mockResolvedValue({ error: 'Departure is on land.', code: 'origin-on-land' });
        await expect(calculateThalassaProposal(request())).rejects.toThrow('Departure is on land.');
        m.tryInshoreRoute.mockResolvedValue(null);
        await expect(calculateThalassaProposal(request())).rejects.toThrow(
            'Thalassa could not route this passage. Nothing changed.',
        );
    });

    it('refuses over 50 NM and without endpoint coverage before the engine runs', async () => {
        await expect(calculateThalassaProposal(request({ destination: { lat: -32.0, lon: 161.0 } }))).rejects.toThrow(
            /^Auto routes inshore passages up to 50 NM; this one is 60\.0 NM\. Split it, or plot it in Manual\.$/,
        );
        m.hasEncCoverageForRoute.mockImplementation(((a: { lat: number }) => a.lat !== DEST.lat) as never);
        await expect(calculateThalassaProposal(request())).rejects.toThrow(
            'No installed chart covers the destination.',
        );
        expect(m.tryInshoreRoute).not.toHaveBeenCalled();
    });

    it('fills a coverage gap from the cloud once and retries once', async () => {
        m.tryInshoreRoute
            .mockResolvedValueOnce({ error: 'Trusted inshore ENC coverage is incomplete', code: 'coverage-gap' })
            .mockResolvedValueOnce(engineResult());
        m.fill.mockResolvedValue({ downloaded: 2, needed: 2, bucketAvailable: true });
        const route = await calculateThalassaProposal(request());
        expect(m.fill).toHaveBeenCalledTimes(1);
        const [bbox] = m.fill.mock.calls[0];
        expect(bbox[0]).toBeCloseTo(161.0 - 0.03, 9);
        expect(bbox[3]).toBeCloseTo(-31.0 + 0.03, 9);
        expect(m.tryInshoreRoute).toHaveBeenCalledTimes(2);
        expect(route.provider).toBe('Thalassa');
    });

    it('never fills twice, and says why a fill could not help', async () => {
        const gap = { error: 'Trusted inshore ENC coverage is incomplete — gap ~3 NM', code: 'coverage-gap' };
        m.tryInshoreRoute.mockResolvedValue(gap);
        m.fill.mockResolvedValue({ downloaded: 1, needed: 3, bucketAvailable: true });
        await expect(calculateThalassaProposal(request())).rejects.toThrow(gap.error);
        expect(m.fill).toHaveBeenCalledTimes(1);
        expect(m.tryInshoreRoute).toHaveBeenCalledTimes(2);

        // Licensed charts come only from the boat's Pi since 126-20, so a gap
        // the cloud cannot fill points there, not at sign-in or the connection.
        m.fill.mockReset().mockResolvedValue({ downloaded: 0, needed: 2, bucketAvailable: false });
        await expect(calculateThalassaProposal(request())).rejects.toThrow(
            "This passage needs charts this device doesn't hold. Licensed charts come only from your boat's Pi: open them on the boat's Wi-Fi, then try again. Nothing changed.",
        );
        // The shared shelf holds public NOAA charts only: no "licensed" bucket.
        m.fill.mockReset().mockResolvedValue({ downloaded: 0, needed: 2, bucketAvailable: true });
        await expect(calculateThalassaProposal(request())).rejects.toThrow(
            "The missing charts wouldn't download. You're probably not signed in: sign in and try again. Nothing changed.",
        );
    });

    it('refuses a route the satellite land check finds over land, and says when it could not check', async () => {
        // The engine's own chart evidence rides the result into the check
        // (2026-10-02, Coral Sea Marina → Daydream Island): since 127-ROUTE-W
        // as the verdicts the route job worked out at every sample.
        const chartVerdicts = ['water', 'water', 'land', 'water'];
        m.tryInshoreRoute.mockResolvedValue(engineResult({ chartVerdicts }));
        m.crossesLand.mockResolvedValue({ status: 'verified', crossesLand: true, runs: [{}] });
        await expect(calculateThalassaProposal(request())).rejects.toThrow(
            'Satellite relief shows land on this route. The route is not shown. Check that stretch on a detailed chart, or plot this passage in Manual. Nothing changed.',
        );
        expect(m.crossesLand).toHaveBeenLastCalledWith(polyline, { chartVerdicts });
        // Where, and whether the charts are missing there.
        m.crossesLand.mockResolvedValue({
            status: 'verified',
            crossesLand: true,
            runs: [
                {
                    startIdx: 3,
                    samples: 4,
                    lat: -31.01,
                    lon: 161.02,
                    midLat: -31.012,
                    midLon: 161.024,
                    charts: 'uncharted',
                },
            ],
        });
        await expect(calculateThalassaProposal(request())).rejects.toThrow(
            'Satellite relief shows land near 31.012° S, 161.024° E, where none of the charts used for this route is detailed enough to say whether it is water. The route is not shown. Check that stretch on a detailed chart, or plot this passage in Manual. Nothing changed.',
        );
        m.crossesLand.mockResolvedValue({
            status: 'verified',
            crossesLand: true,
            runs: [{ startIdx: 3, samples: 2, lat: -31.01, lon: 161.02, charts: 'land' }],
        });
        await expect(calculateThalassaProposal(request())).rejects.toThrow(
            'Satellite relief shows land near 31.010° S, 161.020° E, and the installed charts show land or drying ground there too. The route is not shown. Plot this passage in Manual. Nothing changed.',
        );
        // The proposal never carries the probe (it is cloned and saved).
        m.crossesLand.mockResolvedValue({ status: 'verified', crossesLand: false, runs: [] });
        const clear = await calculateThalassaProposal(request());
        expect(() => structuredClone(clear)).not.toThrow();
        expect(JSON.stringify(clear)).not.toContain('chartWater');
        m.crossesLand.mockResolvedValue({ status: 'unavailable', crossesLand: false, runs: [] });
        const route = await calculateThalassaProposal(request());
        expect(route.warnings).toContain(
            "Satellite land check couldn't be done just now: the satellite relief didn't come back for the whole route. Checked against the installed charts only — retry the check in Review before saving.",
        );
        expect(route.engine?.backstop).toBe('unavailable');
    });

    // Shane's phone, 2026-10-02 06:21, on Wi-Fi and 4G: "The satellite land
    // check has not run for this route (offline)". It had timed out.
    it('says what stopped the satellite check — "offline" only when the phone is', async () => {
        m.tryInshoreRoute.mockResolvedValue(engineResult());
        const verdicts = ['water', 'water', 'water'];
        m.crossesLand.mockResolvedValue({
            status: 'unavailable',
            crossesLand: false,
            runs: [],
            unavailable: { kind: 'timeout', waitedMs: 12_000 },
            chartVerdicts: verdicts,
        });
        const route = await calculateThalassaProposal(request());
        const note =
            "Satellite land check couldn't be done just now: the satellite relief service didn't answer within 12 s. Checked against the installed charts only — retry the check in Review before saving.";
        expect(route.warnings).toContain(note);
        expect(route.warnings.join(' ')).not.toMatch(/offline/i);
        expect(route.engine).toMatchObject({
            backstop: 'unavailable',
            backstopReason: "the satellite relief service didn't answer within 12 s",
            backstopCharts: verdicts,
        });
        // The proposal is still plain data (it is cloned and saved).
        expect(() => structuredClone(route)).not.toThrow();
        m.crossesLand.mockResolvedValue({
            status: 'unavailable',
            crossesLand: false,
            runs: [],
            unavailable: { kind: 'offline' },
        });
        const offline = await calculateThalassaProposal(request());
        expect(offline.warnings.some((w) => w.includes('this phone is offline'))).toBe(true);
    });

    it("Review's Retry re-runs the satellite check alone, on the same line and proposal", async () => {
        const { recheckThalassaBackstop } = await import('../services/autoroutingThalassa');
        const { isBackstopLandRefusal } = await import('../services/routing/landBackstopWords');
        const { samplePolyline } = await import('../services/routing/landBackstop');
        m.tryInshoreRoute.mockResolvedValue(engineResult());
        const verdicts = samplePolyline(polyline).map(() => 'water');
        m.crossesLand.mockResolvedValue({
            status: 'unavailable',
            crossesLand: false,
            runs: [],
            unavailable: { kind: 'timeout', waitedMs: 12_000 },
            chartVerdicts: verdicts,
        });
        const route = await calculateThalassaProposal(request());
        m.tryInshoreRoute.mockClear();
        m.crossesLand.mockClear();

        // Still failing: the note says what happened this time, in its place.
        m.crossesLand.mockResolvedValue({
            status: 'unavailable',
            crossesLand: false,
            runs: [],
            unavailable: { kind: 'quota', status: 429 },
        });
        const still = await recheckThalassaBackstop(route);
        expect(m.tryInshoreRoute).not.toHaveBeenCalled();
        expect(m.crossesLand).toHaveBeenCalledWith(route.coordinates, { chartVerdicts: verdicts });
        expect(still.id).toBe(route.id);
        expect(still.coordinates).toBe(route.coordinates);
        expect(still.engine?.backstop).toBe('unavailable');
        expect(still.warnings).toHaveLength(route.warnings.length);
        expect(still.warnings).toContain(
            "Satellite land check couldn't be done just now: today's allowance of satellite checks for this account is used up. Checked against the installed charts only — retry the check in Review before saving.",
        );

        // It runs: verified, the note gone, nothing else changed.
        m.crossesLand.mockResolvedValue({ status: 'verified', crossesLand: false, runs: [] });
        const checked = await recheckThalassaBackstop(still);
        expect(m.tryInshoreRoute).not.toHaveBeenCalled();
        expect(checked).toMatchObject({ id: route.id, engine: { backstop: 'verified' } });
        expect(checked.engine).not.toHaveProperty('backstopReason');
        expect(checked.engine).not.toHaveProperty('backstopCharts');
        expect(checked.warnings).toEqual(route.warnings.filter((w) => !/^Satellite land check/.test(w)));

        // It finds land: Auto's refusal, as if the route had found it.
        m.crossesLand.mockResolvedValue({
            status: 'verified',
            crossesLand: true,
            runs: [{ startIdx: 3, samples: 2, lat: -31.01, lon: 161.02, charts: 'land' }],
        });
        const land = await recheckThalassaBackstop(route).catch((failure: unknown) => failure);
        expect(land).toBeInstanceOf(Error);
        expect((land as Error).message).toBe(
            'Satellite relief shows land near 31.010° S, 161.020° E, and the installed charts show land or drying ground there too. The route is not shown. Plot this passage in Manual. Nothing changed.',
        );
        // Typed, so Review removes the route for land and for nothing else
        // (fix-up review, 2026-10-03).
        expect(isBackstopLandRefusal(land)).toBe(true);

        // No kept chart evidence (or an edited line): Recalculate, never a
        // check without the charts — and never taken for land.
        const { backstopCharts: _charts, ...bare } = route.engine!;
        const notKept = await recheckThalassaBackstop({ ...route, engine: bare }).catch((failure: unknown) => failure);
        expect((notKept as Error).message).toMatch(/Recalculate/);
        expect(isBackstopLandRefusal(notKept)).toBe(false);
    });

    it('says when the route ends short of a pin', async () => {
        const short: [number, number][] = [...polyline.slice(0, -1), [161.0573, -31.0484]];
        m.tryInshoreRoute.mockResolvedValue(engineResult({ polyline: short, distanceNM: 4.0 }));
        const route = await calculateThalassaProposal(request());
        expect(
            route.warnings.some((w) =>
                /^The route ends ~\d+ m short of your destination pin; the water beyond could not be reached\.$/.test(
                    w,
                ),
            ),
        ).toBe(true);
        expect(route.warnings.some((w) => /departure pin/.test(w))).toBe(false);
    });

    // Review fix-ups, 2026-10-01 ─────────────────────────────────────────

    it('refuses a route that crosses charted land away from a pin’s edge, naming where', async () => {
        m.tryInshoreRoute.mockResolvedValue(
            engineResult({ hardLand: { totalM: 400, awayM: 400, awayAt: [161.03, -31.02] } }),
        );
        await expect(calculateThalassaProposal(request())).rejects.toThrow(
            'The only way Thalassa found crosses charted land near 31.020° S, 161.030° E. No route. Nothing changed.',
        );
        expect(m.crossesLand).not.toHaveBeenCalled();
        // Land only at a pin's own edge (a pin on land, decision 7) is that pin's.
        m.tryInshoreRoute.mockResolvedValue(engineResult({ hardLand: { totalM: 20, awayM: 0 } }));
        const route = await calculateThalassaProposal(request());
        expect(route.engine?.hardLandAwayM).toBe(0);
    });

    it('refuses red with no charted depth inside a relax zone when the tides were loaded', async () => {
        const zone = { lat: -31.01, lon: 161.02, radiusM: 4000 };
        // Segment 1 is red for no charted depth: caution, not charted-shallow.
        const uncharted = { chartedShallowMask: [false, false, false], tideDepthM: [null, null, null] };
        m.tryInshoreRoute.mockResolvedValue(
            engineResult({ ...uncharted, relaxZones: [zone], tideCeilingsLoaded: true }),
        );
        await expect(calculateThalassaProposal(request())).rejects.toThrow(
            /^The only way Thalassa found runs over water no chart gives a depth for, near 31\.020° S, 161\.030° E\. No route\. Nothing changed\.$/,
        );
        // Not without the tides, not outside the zone, and never for charted-shallow red.
        m.tryInshoreRoute.mockResolvedValue(
            engineResult({ ...uncharted, relaxZones: [zone], tideCeilingsLoaded: false }),
        );
        await expect(calculateThalassaProposal(request())).resolves.toMatchObject({ provider: 'Thalassa' });
        m.tryInshoreRoute.mockResolvedValue(
            engineResult({
                ...uncharted,
                relaxZones: [{ ...zone, lat: -30.9, radiusM: 500 }],
                tideCeilingsLoaded: true,
            }),
        );
        await expect(calculateThalassaProposal(request())).resolves.toMatchObject({ provider: 'Thalassa' });
        m.tryInshoreRoute.mockResolvedValue(engineResult({ relaxZones: [zone], tideCeilingsLoaded: true }));
        const route = await calculateThalassaProposal(request());
        expect(route.engine?.tideCeilingsLoaded).toBe(true);
    });

    it('refuses a route whose far end the engine does not explain: no route by water', async () => {
        // The water ended ~11.6 km short, across a wall from the destination.
        const short: [number, number][] = [
            [DEP.lon, DEP.lat],
            [161.02, -31.01],
        ];
        const masks = {
            cautionMask: [false],
            canalMask: [false],
            channelMask: [false],
            offshoreMask: [false],
            chartedShallowMask: [false],
            landPaintConflictMask: [false],
            tideDepthM: [null],
            surveyRuns: [],
        };
        m.tryInshoreRoute.mockResolvedValue(engineResult({ polyline: short, ...masks }));
        await expect(calculateThalassaProposal(request())).rejects.toThrow(
            /^No route by water to your destination: the nearest water Thalassa could reach is \d+\.\d km from the pin\. Nothing changed\.$/,
        );
        // A pin on land or a drying bank, or an inland pin, explains it (decision 7).
        m.tryInshoreRoute.mockResolvedValue(
            engineResult({ polyline: short, ...masks, pinOffWater: { destination: 'land' } }),
        );
        await expect(calculateThalassaProposal(request())).resolves.toMatchObject({ provider: 'Thalassa' });
        m.tryInshoreRoute.mockResolvedValue(engineResult({ polyline: short, ...masks, destinationInlandTrimM: 6000 }));
        await expect(calculateThalassaProposal(request())).resolves.toMatchObject({ provider: 'Thalassa' });
        // The departure end too.
        m.tryInshoreRoute.mockResolvedValue(
            engineResult({
                polyline: [
                    [161.04, -31.03],
                    [DEST.lon, DEST.lat],
                ],
                ...masks,
            }),
        );
        await expect(calculateThalassaProposal(request())).rejects.toThrow(
            /^No route by water from your departure: the nearest water Thalassa could reach is \d+\.\d km from the pin\. Nothing changed\.$/,
        );
    });

    it('says what a current Notice to Mariners says, as the passage planner does', async () => {
        m.tryInshoreRoute.mockResolvedValue(engineResult());
        m.packs.mockResolvedValue([
            {
                pack: { noticeKey: 'NtM 99/2026', title: 'Synthetic Bar — surveyed depths', surveyed: '2026-09-01' },
                status: { status: 'current' },
                optedOut: false,
            },
            {
                pack: { noticeKey: 'NtM 98/2026', title: 'Opted out', surveyed: '2026-08-01' },
                status: { status: 'current' },
                optedOut: true,
            },
            {
                pack: { noticeKey: 'NtM 97/2026', title: 'Superseded', surveyed: '2026-07-01' },
                status: { status: 'superseded' },
                optedOut: false,
            },
        ]);
        m.notices.mockResolvedValue([
            { id: 'syn-bar', title: 'Synthetic Bar — shoaling', lat: -31.01, lon: 161.02, radiusM: 300 },
            { id: 'far', title: 'Far away', lat: -30.0, lon: 160.0, radiusM: 300 },
        ]);
        const route = await calculateThalassaProposal(request());
        expect(route.warnings).toContain(
            'Routing follows a current Notice to Mariners — NtM 99/2026 — Synthetic Bar — surveyed depths (surveyed 2026-09-01). Surveyed depths and the promulgated track are applied. Read the notice before you go.',
        );
        expect(route.warnings).toContain(
            'Notice to Mariners on this route — Synthetic Bar — shoaling. Read it before you go.',
        );
        expect(route.warnings.join(' ')).not.toMatch(/Opted out|Superseded|Far away/);
        // A lookup that fails says nothing and never holds the route.
        m.packs.mockRejectedValue(new Error('feed down'));
        m.notices.mockRejectedValue(new Error('offline'));
        const quiet = await calculateThalassaProposal(request());
        expect(quiet.warnings.join(' ')).not.toMatch(/Notice to Mariners/);
    });

    it('cancels without a proposal', async () => {
        const controller = new AbortController();
        m.tryInshoreRoute.mockImplementation(async () => {
            controller.abort();
            return engineResult();
        });
        await expect(calculateThalassaProposal(request(), controller.signal)).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(m.crossesLand).not.toHaveBeenCalled();
    });

    it('keeps a desynchronised line unverified: stateMask null', async () => {
        m.tryInshoreRoute.mockResolvedValue(engineResult({ cautionMask: [false] }));
        const route = await calculateThalassaProposal(request());
        expect(route.engine?.stateMask).toBeNull();
        expect(route.coordinates).toEqual(polyline);
    });

    it('refuses a line too long to review', async () => {
        const long: [number, number][] = Array.from({ length: 10_001 }, (_, i) => [
            161.0 + (0.06 * i) / 10_000,
            -31.0 - (0.05 * i) / 10_000,
        ]);
        m.tryInshoreRoute.mockResolvedValue(engineResult({ polyline: long, cautionMask: undefined }));
        await expect(calculateThalassaProposal(request())).rejects.toThrow(/too many points/);
    });

    it('needs a signed-in identity and valid inputs', async () => {
        await expect(calculateThalassaProposal(request({ draftM: 0 }))).rejects.toThrow(/positive draft/);
        setAuthIdentityScope(null);
        await expect(calculateThalassaProposal(request())).rejects.toThrow('Sign in to use Auto routing.');
        expect(m.tryInshoreRoute).not.toHaveBeenCalled();
    });
});

// Phase 2b (2026-10-01), owner decision 2: offline, Auto routes the canal
// when its water is in the phone's pack and says where it came from; when an
// end's water is not saved, its refusals say that first.
describe('the offline water pack', () => {
    const SAVED = new Date(2026, 8, 28, 12).getTime();
    const PACK_LEAD = "No route: the harbour water for the departure isn't on this phone yet";

    it('passes an engine refusal that leads with the pack, whole, with the engine words in it', async () => {
        const engineWords = 'No safe chart-vouched route: the only candidate crosses 0.9 km of charted land';
        m.tryInshoreRoute.mockResolvedValue(
            applyWaterPack(
                { error: engineWords, code: 'hard-land-crossing' },
                { source: 'none', missing: ['departure'], offline: true },
            ),
        );
        const err = await calculateThalassaProposal(request()).catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message.startsWith(PACK_LEAD)).toBe(true);
        expect((err as Error).message).toContain(engineWords);
    });

    it('a route on the pack carries its caveat after the planned-only line', async () => {
        m.tryInshoreRoute.mockResolvedValue(
            engineResult({ waterPack: { source: 'pack', dataAsOf: SAVED, missing: [] } }),
        );
        const route = await calculateThalassaProposal(request());
        expect(route.warnings[0]).toBe(THALASSA_PLANNED_ONLY_WARNING);
        const i = route.warnings.findIndex((w) => w.startsWith('Canal and marina water on this route came from'));
        expect(i).toBeGreaterThan(0);
        expect(route.warnings[i]).toContain('saved on this phone on 28 Sep (© OpenStreetMap contributors)');
    });

    it("its own refusals lead with the pack when that end's water is missing", async () => {
        const masks = {
            cautionMask: [false],
            canalMask: [false],
            channelMask: [false],
            offshoreMask: [false],
            chartedShallowMask: [false],
            landPaintConflictMask: [false],
            tideDepthM: [null],
            surveyRuns: [],
        };
        // The route starts ~1 km off the departure pin, unexplained.
        const start: [number, number][] = [
            [161.01, -31.0],
            [DEST.lon, DEST.lat],
        ];
        m.tryInshoreRoute.mockResolvedValue(
            engineResult({
                polyline: start,
                ...masks,
                waterPack: { source: 'pack', missing: ['departure'], offline: true },
            }),
        );
        const err = (await calculateThalassaProposal(request()).catch((e: Error) => e)) as Error;
        expect(err.message.startsWith(PACK_LEAD)).toBe(true);
        expect(err.message).toMatch(/No route by water from your departure: the nearest water Thalassa could reach is/);
        // The destination's water missing says nothing about the departure end.
        m.tryInshoreRoute.mockResolvedValue(
            engineResult({ polyline: start, ...masks, waterPack: { source: 'pack', missing: ['destination'] } }),
        );
        await expect(calculateThalassaProposal(request())).rejects.toThrow(/^No route by water from your departure/);
        // Charted land away from a pin, with an end's water missing.
        m.tryInshoreRoute.mockResolvedValue(
            engineResult({
                hardLand: { totalM: 400, awayM: 400, awayAt: [161.03, -31.02] },
                waterPack: { source: 'none', missing: ['departure', 'destination'], offline: true },
            }),
        );
        await expect(calculateThalassaProposal(request())).rejects.toThrow(
            /^No route: the harbour water for the departure and the destination isn't on this phone yet.*crosses charted land near 31\.020° S/,
        );
    });

    // Fix-up (2026-10-02): online, the water "couldn't be downloaded just
    // now" — never "route once you're online"; and with both ends saved but
    // water along the way not, the land refusal says that after its words.
    it('online, and on a partial pack, its own refusals say why in words that fit', async () => {
        m.tryInshoreRoute.mockResolvedValue(
            engineResult({
                hardLand: { totalM: 400, awayM: 400, awayAt: [161.03, -31.02] },
                waterPack: { source: 'none', missing: ['departure', 'destination'] },
            }),
        );
        const online = (await calculateThalassaProposal(request()).catch((e: Error) => e)) as Error;
        expect(online.message).toMatch(
            /^No route: the harbour water for the departure and the destination couldn't be downloaded just now and isn't saved on this phone.*Try again shortly\./,
        );
        expect(online.message).not.toMatch(/once you're online/);
        m.tryInshoreRoute.mockResolvedValue(
            engineResult({
                hardLand: { totalM: 400, awayM: 400, awayAt: [161.03, -31.02] },
                waterPack: { source: 'pack', missing: [], gaps: true, offline: true },
            }),
        );
        const partial = (await calculateThalassaProposal(request()).catch((e: Error) => e)) as Error;
        expect(partial.message).toMatch(/^The only way Thalassa found crosses charted land near 31\.020° S/);
        expect(partial.message).toMatch(
            /Some harbour water along this route isn't saved on this phone, so the charts alone were used there; route once you're online to save it\.$/,
        );
    });

    it('an online route reads exactly as before', async () => {
        m.tryInshoreRoute.mockResolvedValue(engineResult());
        const before = await calculateThalassaProposal(request());
        m.tryInshoreRoute.mockResolvedValue(engineResult({ waterPack: { source: 'online', missing: [] } }));
        const after = await calculateThalassaProposal(request());
        expect(after.warnings).toEqual(before.warnings);
    });
});

describe("the boat's licensed charts open from the Pi before the gates (127-C-c decision 8)", () => {
    const COORD = /-?\d{1,3}\.\d{2,}/;
    const NAME = "L'Étoile du Pacifique";

    it('paired with nothing registered yet reads ready; away it says where the charts are', () => {
        m.listCells.mockReturnValue([]);
        m.boatState = 'pending';
        expect(getThalassaAutorouteStatus()).toEqual({ enabled: true, ready: true });
        m.boatState = 'away';
        m.boatWhy = 'away';
        expect(getThalassaAutorouteStatus()).toEqual({
            enabled: true,
            ready: false,
            message: `${NAME}'s charts open on the boat's Wi-Fi. Manual is ready.`,
        });
    });

    it('registers and pulls the endpoint cells before the endpoint gate, then routes', async () => {
        let registered = false;
        m.ensureBoatCells.mockImplementation(async () => {
            m.order.push('ensure');
            registered = true;
            return { state: 'loaded', pulled: 6, ms: 1234, missing: 0 };
        });
        m.hasEncCoverageForRoute.mockImplementation((() => {
            m.order.push('gate');
            return registered;
        }) as never);
        m.tryInshoreRoute.mockResolvedValue(engineResult());
        const route = await calculateThalassaProposal(request());
        expect(m.order[0]).toBe('ensure');
        expect(m.order).toContain('gate');
        const [bbox, opts] = m.ensureBoatCells.mock.calls[0] as unknown as [number[], { maxCells: number }];
        expect(bbox[0]).toBeCloseTo(161.0 - 0.03, 9);
        expect(bbox[1]).toBeCloseTo(-31.05 - 0.03, 9);
        expect(opts).toEqual({ maxCells: 24 });
        expect(route.chartsMs).toBe(1234);
        expect(route.coordinates).toEqual(polyline);
    });

    it('opens more of her charts in the coverage-gap fill before asking the cloud', async () => {
        m.ensureBoatCells
            .mockResolvedValueOnce({ state: 'loaded', pulled: 2, ms: 400, missing: 3 })
            .mockResolvedValueOnce({ state: 'loaded', pulled: 3, ms: 500, missing: 0 });
        m.tryInshoreRoute
            .mockResolvedValueOnce({ error: 'Trusted inshore ENC coverage is incomplete', code: 'coverage-gap' })
            .mockResolvedValueOnce(engineResult());
        const route = await calculateThalassaProposal(request());
        expect(m.ensureBoatCells).toHaveBeenCalledTimes(2);
        expect(m.fill).not.toHaveBeenCalled();
        expect(route.chartsMs).toBe(900);
    });

    it.each([
        ['away', `${NAME}'s licensed charts open on the boat's Wi-Fi.`],
        ['tailnet', `Licensed charts open only on ${NAME}'s own Wi-Fi, not over remote access.`],
        ['off', `Licensed charts stay on ${NAME}'s Pi in this build.`],
    ])('an uncovered end with the Pi %s says where her charts are, and names no position', async (why, words) => {
        m.ensureBoatCells.mockResolvedValue({
            state: why === 'off' ? 'none' : 'away',
            why,
            pulled: 0,
            ms: 3000,
            missing: 0,
        });
        m.hasEncCoverageForRoute.mockReturnValue(false);
        const err = await calculateThalassaProposal(request()).catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain('No installed chart covers the departure or the destination.');
        expect((err as Error).message).toContain(words);
        expect((err as Error).message).not.toMatch(COORD);
        expect(m.tryInshoreRoute).not.toHaveBeenCalled();
    });
});

describe('thalassaVesselWarnings', () => {
    it('says what the router reads and what it does not', () => {
        expect(thalassaVesselWarnings(PROFILE)).toEqual(['Beam and length are not used by the router yet.']);
        expect(
            thalassaVesselWarnings({
                ...PROFILE,
                draftStatus: 'estimated',
                airDraft: { status: 'estimated', valueM: 17 },
            }),
        ).toEqual([
            'Vessel draft is estimated. Depth review is incomplete until the draft is measured and confirmed in Vessel settings.',
            'Air draft is estimated.',
            'Beam and length are not used by the router yet.',
        ]);
        expect(thalassaVesselWarnings({ ...PROFILE, airDraft: { status: 'missing' } })).toContain(
            'Air draft not set: every bridge and power line blocks the route.',
        );
        expect(thalassaVesselWarnings(PROFILE).join(' ')).not.toMatch(/SevenCs/);
    });
});
