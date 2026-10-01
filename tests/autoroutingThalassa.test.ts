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
}));

vi.mock('../services/InshoreRouter', () => ({
    tryInshoreRoute: m.tryInshoreRoute,
    hasEncCoverageForRoute: m.hasEncCoverageForRoute,
    MAX_INSHORE_NM: 50,
}));
vi.mock('../services/routing/landBackstop', () => ({ inshoreRouteCrossesLand: m.crossesLand }));
vi.mock('../services/enc/cloudCellSync', () => ({ downloadCloudCellsForBBox: m.fill }));
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

        m.fill.mockReset().mockResolvedValue({ downloaded: 0, needed: 2, bucketAvailable: false });
        await expect(calculateThalassaProposal(request())).rejects.toThrow(/chart cloud isn't reachable/);
        m.fill.mockReset().mockResolvedValue({ downloaded: 0, needed: 2, bucketAvailable: true });
        await expect(calculateThalassaProposal(request())).rejects.toThrow(/not signed in/);
    });

    it('refuses a route the satellite land check finds over land, and says when it could not check', async () => {
        m.tryInshoreRoute.mockResolvedValue(engineResult());
        m.crossesLand.mockResolvedValue({ status: 'verified', crossesLand: true, runs: [{}] });
        await expect(calculateThalassaProposal(request())).rejects.toThrow(
            'Satellite relief shows land on this route, so it is not shown. Check charts are installed for the whole passage.',
        );
        m.crossesLand.mockResolvedValue({ status: 'unavailable', crossesLand: false, runs: [] });
        const route = await calculateThalassaProposal(request());
        expect(route.warnings).toContain(
            'Satellite land check unavailable (offline): checked against the installed charts only.',
        );
        expect(route.engine?.backstop).toBe('unavailable');
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
