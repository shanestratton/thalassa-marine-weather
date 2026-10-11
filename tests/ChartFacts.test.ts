/**
 * Charts stay on the boat (127-C-b): the licence classifier and the rules that
 * keep chart numbers and positions off every disk.
 *
 * o-charts, 2026-10-10: "Storing unencrypted data on any medium, and especially
 * in the cloud, is strictly prohibited by the terms of the licenses signed with
 * the chart providers." What may be kept is the skipper's own line and plain
 * words (vision §4.1 rules 2 and 3). Each stripper here is run on a fixture
 * with every field filled: no chart figure, position or name survives it, the
 * land words do, and NOAA (public domain) data is left exactly as it was.
 *
 * Fictional cells only: OC-99-ZZTEST (Nouméa) and ZZ5TEST1 (Tromsø) are
 * protected, US5XX01M (Chesapeake) is open. The app is global.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllCellMetadata, putCell } from '../services/enc/EncCellMetadata';
import type { EncCell } from '../services/enc/types';
import { anyProtectedChart, chartLicenceOf, isOpenChartCell, isProtectedChart } from '../services/enc/chartLicence';
import {
    CHART_FACTS_MAY_BE_STORED,
    CHART_FACTS_STAY_ABOARD,
    CHART_NOTES_ABOARD,
    DRY_LINE_ABOARD,
    SAVE_ROUTES_FROM_LICENSED_CHARTS,
    TRACE_LAND_CROSSING_MESSAGE,
    chartFactsKeeper,
    chartFreeEvidence,
    chartFreeLegEntries,
    chartFreeOutcomeLegs,
    chartFreeVoyagePlan,
    idsFromFingerprint,
    proposalUsedProtectedCharts,
    protectedChartsUnder,
} from '../services/chartFacts';
import { buildFollowRoutePlanFromRoute } from '../services/shiplog/followRoutePlan';
import {
    autoroutingProposalGeometryKey,
    normaliseAutoroutingProposalEvidence,
    type SavedAutoroutingProposalEvidence,
} from '../services/autoroutingProposalEvidence';
import { THALASSA_PLANNED_ONLY_WARNING, THALASSA_ROUTED_ON_PHONE } from '../services/autoroutingNotes';
import { thalassaVesselWarnings } from '../services/autoroutingVesselProfile';
import { DRY_RUN_CAVEAT_PREFIX, plannedRouteDryFinding } from '../services/routing/dryRunWords';
import type { TraceLegVerdict } from '../services/routeTracer';
import type { VoyagePlan } from '../types';

const SHA = 'a'.repeat(64);
const noumeaCell: EncCell = {
    id: 'OC-99-ZZTEST',
    sourceHO: 'FR',
    edition: 2,
    issued: '2026-08-01',
    importedAt: '2026-09-01T00:00:00.000Z',
    bbox: [166.3, -22.4, 166.5, -22.2],
    geojsonPath: 'enc/OC-99-ZZTEST.json',
    hazardCount: 10,
    usage: 'navigation',
};
const tromsoCell: EncCell = {
    ...noumeaCell,
    id: 'ZZ5TEST1',
    sourceHO: 'ZZ',
    bbox: [18.8, 69.6, 19.1, 69.7],
    geojsonPath: 'enc/ZZ5TEST1.json',
};
const chesapeakeCell: EncCell = {
    ...noumeaCell,
    id: 'US5XX01M',
    sourceHO: 'US',
    contentSha256: SHA,
    bbox: [-76.5, 38.9, -76.3, 39.1],
    geojsonPath: 'enc/US5XX01M.json',
};
const OPEN_FP = `US5XX01M@2@2026-08-01@unknown@sha256-${SHA}`;
const PROTECTED_FP = 'OC-99-ZZTEST@2@2026-08-01@unknown';

/** Every finite number in a value's structure (strings are checked separately). */
function numbersIn(value: unknown, out: number[] = []): number[] {
    if (typeof value === 'number') out.push(value);
    else if (Array.isArray(value)) for (const v of value) numbersIn(v, out);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) numbersIn(v, out);
    return out;
}

/** The fixture's chart figures, positions and names: none may survive a strip. */
const CHART_FIGURES = [
    '1.37',
    '0.43',
    '0.57',
    '2.47',
    '1.66',
    '166.4233',
    '-22.3011',
    '166.4377',
    '-22.3166',
    '166.4219',
    '-22.2987',
    '412',
    '288',
    '133',
    '437',
    'Passe Fictive',
    'Récif Fictif',
];
const expectNoChartFigures = (value: unknown): void => {
    const text = JSON.stringify(value);
    for (const figure of CHART_FIGURES) expect(text, figure).not.toContain(figure);
};

const key = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): string =>
    `${a.lat.toFixed(6)},${a.lon.toFixed(6)}|${b.lat.toFixed(6)},${b.lon.toFixed(6)}`;
const noumeaLeg = key({ lat: -22.27, lon: 166.41 }, { lat: -22.31, lon: 166.43 });
const chesapeakeLeg = key({ lat: 38.95, lon: -76.45 }, { lat: 38.99, lon: -76.4 });
const openSeaLeg = key({ lat: 10.1, lon: -30.1 }, { lat: 10.2, lon: -30.2 });

const fullVerdict = (grade: TraceLegVerdict['grade'], message = 'thin water — 1.37 m charted at low tide (LAT)') =>
    ({
        grade,
        issues: [
            {
                severity: grade === 'clear' ? 'info' : grade,
                message,
                at: { lat: -22.3011, lon: 166.4233 },
                mark: { lat: -22.3166, lon: 166.4377 },
                chartTrack: { id: 'lead-1', label: 'Passe Fictive', kind: 'leading-line', offsetM: 133 },
            },
        ],
        minDepthM: 1.37,
        minAt: { lat: -22.3011, lon: 166.4233 },
        needsTide: grade === 'caution',
        nudge: 'deeper water ~412 m to port',
        nudgeTo: { lat: -22.2987, lon: 166.4219 },
    }) as TraceLegVerdict;

beforeEach(() => {
    localStorage.clear();
    clearAllCellMetadata();
});

describe('the licence classifier (one rule, fail closed)', () => {
    it("is 'open' only for a NOAA id from producer US, or none, that no source called protected", () => {
        expect(chartLicenceOf({ id: 'US5XX01M', sourceHO: 'US' })).toBe('open');
        expect(chartLicenceOf({ id: 'us5xx01m' })).toBe('open');
        expect(chartLicenceOf({ id: 'US5XX01M', sourceHO: 'US', licence: 'protected' })).toBe('protected');
        expect(chartLicenceOf({ id: 'US5XX01M', sourceHO: 'GB' })).toBe('protected');
        for (const id of ['OC-99-ZZTEST', 'ZZ5TEST1', 'FR466870', 'GB501494', 'USX12345', 'US5XX01MZ', '', 'x'])
            expect(chartLicenceOf({ id }), id).toBe('protected');
        // A Pi saying 'open' never opens a licensed id: it can only make a cell stricter.
        expect(chartLicenceOf({ id: 'OC-99-ZZTEST', sourceHO: 'FR', licence: 'open' })).toBe('protected');
        expect(chartLicenceOf({} as never)).toBe('protected');
        expect(isProtectedChart({ id: 'ZZ5TEST1' })).toBe(true);
        expect(isOpenChartCell({ id: 'US5XX01M' })).toBe(true);
        expect(anyProtectedChart(['US5XX01M', 'US4XX02M'])).toBe(false);
        expect(anyProtectedChart(['US5XX01M', 'OC-99-ZZTEST'])).toBe(true);
        expect(anyProtectedChart([])).toBe(false);
    });

    it('holds its switches where 127 decided them', () => {
        expect(CHART_FACTS_MAY_BE_STORED).toBe(false);
        expect(SAVE_ROUTES_FROM_LICENSED_CHARTS).toBe(true);
        expect(CHART_FACTS_STAY_ABOARD).toBe(true);
        expect(TRACE_LAND_CROSSING_MESSAGE).toBe('crosses charted land');
    });

    it('reads cell ids out of a real-shaped registry fingerprint', () => {
        expect(
            idsFromFingerprint(
                `US5XX01M@3@2026-09-01@123456@update-2@sha256-${SHA}|OC-99-ZZTEST@2@2026-08-01@99999|ZZ5TEST1@1@@unknown`,
            ),
        ).toEqual(['US5XX01M', 'OC-99-ZZTEST', 'ZZ5TEST1']);
        expect(idsFromFingerprint('')).toEqual([]);
    });

    it('finds every registered protected cell under a box, not only navigation ones', () => {
        putCell(noumeaCell);
        putCell({ ...tromsoCell, usage: 'reference' });
        putCell(chesapeakeCell);
        expect(protectedChartsUnder([166.4, -22.35, 166.45, -22.3]).map((c) => c.id)).toEqual(['OC-99-ZZTEST']);
        expect(protectedChartsUnder([18.9, 69.62, 18.95, 69.65]).map((c) => c.id)).toEqual(['ZZ5TEST1']);
        expect(protectedChartsUnder([-76.45, 38.95, -76.4, 39])).toEqual([]);
    });
});

describe('leg verdicts: grade stubs over licensed charts, NOAA kept in full', () => {
    beforeEach(() => {
        putCell(noumeaCell);
        putCell(chesapeakeCell);
    });

    it('keeps the grade, needs-tide and land words and nothing else over a protected chart', () => {
        const land = fullVerdict('danger', TRACE_LAND_CROSSING_MESSAGE);
        const [[k1, caution], [, danger]] = chartFreeLegEntries(
            [
                [noumeaLeg, fullVerdict('caution')],
                [key({ lat: -22.31, lon: 166.43 }, { lat: -22.33, lon: 166.45 }), land],
            ],
            `${PROTECTED_FP}|${OPEN_FP}`,
        );
        expect(k1).toBe(noumeaLeg);
        expect(caution).toEqual({
            grade: 'caution',
            needsTide: true,
            issues: [],
            minDepthM: null,
            minAt: null,
            nudge: null,
            nudgeTo: null,
            stub: true,
        });
        expect(danger.issues).toEqual([{ severity: 'danger', message: TRACE_LAND_CROSSING_MESSAGE }]);
        expect(danger.stub).toBe(true);
        expectNoChartFigures([caution, danger]);
        expect(numbersIn([caution, danger])).toEqual([]);
    });

    it('keeps an open-water NOAA leg in full', () => {
        const verdict = fullVerdict('caution');
        const [[, kept]] = chartFreeLegEntries([[chesapeakeLeg, verdict]], OPEN_FP);
        expect(kept).toBe(verdict);
    });

    it('fails closed: no chart under the leg, a key it cannot read, or a stamp naming an unknown cell', () => {
        const verdict = fullVerdict('caution');
        for (const [legKey, fp] of [
            [openSeaLeg, OPEN_FP],
            ['not-a-leg-key', OPEN_FP],
            [chesapeakeLeg, `${OPEN_FP}|ZZ9GONE1@1@@unknown`],
            [chesapeakeLeg, `${OPEN_FP}|US5XX09M@1@@unknown`],
        ] as const) {
            const [[, kept]] = chartFreeLegEntries([[legKey, verdict]], fp);
            expect(kept.stub, `${legKey} ${fp}`).toBe(true);
        }
        // Registry gone (127-C-c: memory-only, empty at unpair): every leg stubs.
        clearAllCellMetadata();
        expect(chartFreeLegEntries([[chesapeakeLeg, verdict]], '')[0][1].stub).toBe(true);
    });

    it('a protected chart overlapping NOAA water stubs the leg', () => {
        putCell({ ...tromsoCell, bbox: [-76.5, 38.9, -76.3, 39.1] });
        const [[, kept]] = chartFreeLegEntries([[chesapeakeLeg, fullVerdict('clear')]], OPEN_FP);
        expect(kept.stub).toBe(true);
    });

    it("a protected chart just beyond the leg's ends stubs it: its words reach marks up to 400 m off", () => {
        const verdict = fullVerdict('caution');
        // ~330 m north of the leg's northern end (38.99): a cardinal from it can be named.
        putCell({ ...tromsoCell, bbox: [-76.5, 38.993, -76.3, 39.1] });
        expect(chartFreeLegEntries([[chesapeakeLeg, verdict]], OPEN_FP)[0][1].stub).toBe(true);
        expect(chartFactsKeeper(OPEN_FP)({ lat: 38.95, lon: -76.45 }, { lat: 38.99, lon: -76.4 })).toBe(false);
        // ~2 km off: the leg keeps its figures.
        putCell({ ...tromsoCell, bbox: [-76.5, 39.008, -76.3, 39.1] });
        expect(chartFreeLegEntries([[chesapeakeLeg, verdict]], OPEN_FP)[0][1]).toBe(verdict);
    });

    it('a NOAA shelf cell still waiting to download decides nothing', () => {
        const verdict = fullVerdict('caution');
        putCell({
            ...chesapeakeCell,
            id: 'US3XX02M',
            sourceHO: 'cloud',
            edition: 0,
            issued: '',
            bbox: [-77, 38.5, -76, 39.5],
            hazardCount: 0,
            usage: 'pending',
        });
        expect(chartFreeLegEntries([[chesapeakeLeg, verdict]], OPEN_FP)[0][1]).toBe(verdict);
        expect(proposalUsedProtectedCharts(['US5XX01M', 'US3XX02M'], OPEN_FP)).toBe(false);
        expect(protectedChartsUnder([-76.45, 38.95, -76.4, 38.99])).toEqual([]);
    });

    it('answers per leg for the report: Chesapeake keeps its figures, Nouméa does not', () => {
        const keep = chartFactsKeeper(`${PROTECTED_FP}|${OPEN_FP}`);
        expect(keep({ lat: 38.95, lon: -76.45 }, { lat: 38.99, lon: -76.4 })).toBe(true);
        expect(keep({ lat: -22.27, lon: 166.41 }, { lat: -22.31, lon: 166.43 })).toBe(false);
        expect(keep({ lat: 69.63, lon: 18.9 }, { lat: 69.64, lon: 18.95 })).toBe(false);
    });
});

describe('route-check outcomes: the land words, else "no-go leg"', () => {
    it('drops charted figures and mark names from danger legs over protected charts', () => {
        const legs = [
            { from: 2, to: 3, message: 'thin water — 1.37 m charted at Passe Fictive' },
            { from: 4, to: 5, message: TRACE_LAND_CROSSING_MESSAGE },
        ];
        expect(chartFreeOutcomeLegs(legs, PROTECTED_FP)).toEqual([
            { from: 2, to: 3, message: 'no-go leg' },
            { from: 4, to: 5, message: TRACE_LAND_CROSSING_MESSAGE },
        ]);
        expect(chartFreeOutcomeLegs(legs, '')[0].message).toBe('no-go leg');
        expect(chartFreeOutcomeLegs(legs, OPEN_FP)).toBe(legs);
    });
});

const evidencePoints = [
    { lat: -22.27, lon: 166.41 },
    { lat: -22.31, lon: 166.43 },
    { lat: -22.33, lon: 166.45 },
];
const ROUTED = `${THALASSA_ROUTED_ON_PHONE} draft 2.40 m + 0.5 m under the keel at chart datum (LAT). Tide is shown, never assumed.`;
function evidence(fingerprint: string): SavedAutoroutingProposalEvidence {
    return {
        version: 1,
        origin: 'thalassa-inshore',
        proposalId: 'proposal-nc',
        providerCreatedAt: '2026-10-10T01:00:00.000Z',
        savedAt: '2026-10-10T01:02:00.000Z',
        plannedOnlyAcknowledged: true,
        basis: {
            proposalId: 'proposal-nc',
            geometryKey: autoroutingProposalGeometryKey(evidencePoints.map((p) => [p.lon, p.lat])),
            draftM: 2.4,
            draftAssumed: false,
            registryFingerprint: fingerprint,
            checkedAt: '2026-10-10T01:01:00.000Z',
            vesselProfileKey: 'null',
        },
        warnings: [
            THALASSA_PLANNED_ONLY_WARNING,
            ROUTED,
            'Water charted 1.37 m at Passe Fictive: needs +0.43 m of tide.',
            'The route ends ~437 m short of your destination pin; the water beyond could not be reached.',
            ...thalassaVesselWarnings(undefined),
        ],
        legs: [
            {
                grade: 'caution',
                incomplete: false,
                minDepthM: 1.37,
                minAt: { lat: -22.3011, lon: 166.4233 },
                issues: [
                    {
                        severity: 'caution',
                        message: 'thin water — 1.37 m charted',
                        at: { lat: -22.3011, lon: 166.4233 },
                        mark: { lat: -22.3166, lon: 166.4377 },
                        chartTrack: { id: 'lead-1', label: 'Passe Fictive', kind: 'leading-line', offsetM: 133 },
                    },
                ],
            },
            { grade: 'clear', incomplete: true, minDepthM: 2.47, minAt: null, issues: [] },
        ],
    };
}

describe('proposal evidence: a line, grades and her own words over licensed charts', () => {
    it('strips depths, positions and chart notes; keeps grades and her own words; still valid', () => {
        const full = evidence(PROTECTED_FP);
        const before = JSON.stringify(full);
        const stripped = chartFreeEvidence(full);
        expect(JSON.stringify(full)).toBe(before); // never mutates its input
        expect(stripped.legs).toEqual([
            { grade: 'caution', incomplete: false, minDepthM: null, minAt: null, issues: [] },
            { grade: 'clear', incomplete: true, minDepthM: null, minAt: null, issues: [] },
        ]);
        expect(stripped.warnings).toEqual([
            THALASSA_PLANNED_ONLY_WARNING,
            ROUTED,
            ...thalassaVesselWarnings(undefined),
            CHART_NOTES_ABOARD,
        ]);
        expect(normaliseAutoroutingProposalEvidence(stripped, evidencePoints)).toEqual(stripped);
        expectNoChartFigures(stripped);
        // Version 1 and her draft are the only numbers left.
        expect(new Set(numbersIn(stripped))).toEqual(new Set([1, 2.4]));
        // Stripping a stripped copy changes nothing (no re-push loop).
        expect(chartFreeEvidence(stripped)).toBe(stripped);
    });

    it('strips when the route used a protected cell even if the stamp is open, and when nothing is known', () => {
        expect(chartFreeEvidence(evidence(OPEN_FP), ['US5XX01M', 'ZZ5TEST1']).legs[0].minDepthM).toBeNull();
        expect(chartFreeEvidence(evidence(''), []).legs[0].minDepthM).toBeNull();
    });

    it('an all-NOAA proposal keeps its full evidence', () => {
        const full = evidence(OPEN_FP);
        expect(chartFreeEvidence(full, ['US5XX01M'])).toBe(full);
    });
});

const line: [number, number][] = [
    [166.41, -22.27],
    [166.43, -22.31],
    [166.45, -22.33],
];
function inshorePlan(cellsUsed: string[] | undefined): VoyagePlan {
    return {
        origin: 'Port Moselle',
        destination: 'Ilot Maitre',
        departureDate: '2026-10-11T07:00:00.000Z',
        originCoordinates: { lat: -22.27, lon: 166.41 },
        destinationCoordinates: { lat: -22.33, lon: 166.45 },
        distanceApprox: '3.1 NM',
        durationApprox: '0.6 hours',
        overview: 'Inshore passage',
        waypoints: [],
        routeGeoJSON: {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: line },
            properties: {
                source: 'inshore-router',
                distanceNM: 3.1,
                ...(cellsUsed ? { cellsUsed } : {}),
                shallowRuns: [
                    {
                        startSeg: 0,
                        endSeg: 1,
                        lengthM: 412,
                        minDepthM: 1.37,
                        midLat: -22.2987,
                        midLon: 166.4219,
                        minAtLat: -22.3011,
                        minAtLon: 166.4233,
                    },
                ],
                structuresUnknownCells: ['OC-99-ZZTEST'],
                pinOffWater: { origin: 'drying' },
                pinTail: { destination: { depthM: 0.43, needsM: 2.47, direct: false, why: 'Récif Fictif' } },
                dryRuns: [
                    {
                        startSeg: 1,
                        startT: 0.2,
                        endSeg: 1,
                        endT: 0.6,
                        lengthM: 288,
                        mid: [166.4377, -22.3166],
                        place: 'Récif Fictif',
                        shallowestM: -0.57,
                        deepestM: 0.43,
                        draftM: 2.4,
                        needM: 2.9,
                        tide: { topM: 1.66, days: 14 },
                    },
                ],
                surveyRuns: [
                    {
                        reason: 'survey-margin',
                        startSeg: 0,
                        startT: 0.1,
                        endSeg: 0,
                        endT: 0.5,
                        lengthM: 133,
                        catzoc: 4,
                    },
                ],
                surveyUncheckedCells: ['OC-99-ZZTEST'],
                tideCheck: 'not-loaded',
                nearShallow: { stretches: 1, clearanceM: 133, depthM: 1.37, requiredM: 2.47 },
                destinationInlandTrimM: 437,
                waterPack: { source: 'pack', dataAsOf: 1_760_000_000_000, missing: ['destination'], offline: true },
                origin: { lat: -22.27, lon: 166.41 },
                destination: { lat: -22.33, lon: 166.45 },
            },
        },
        __inshoreRouting: {
            status: 'success',
            ...(cellsUsed ? { cellsUsed } : {}),
            distanceNM: 3.1,
            caveats: [
                `${DRY_RUN_CAVEAT_PREFIX}: the Récif Fictif dries 0.57 m (2.40 m draft + 0.50 m under the keel).`,
                'Your destination pin is in 0.43 m charted water — the route ends there and needs +2.47 m of tide.',
            ],
        },
    } as VoyagePlan;
}

const KEPT_PROPERTIES = [
    'source',
    'distanceNM',
    'cellsUsed',
    'structuresUnknownCells',
    'pinOffWater',
    'tideCheck',
    'waterPack',
    '_source',
    'legGrades',
    'traceVerification',
    'chartFacts',
    'dryStretches',
    'tideGates',
];

describe('voyage plans: kept as a line, distance and number-free notes over licensed charts', () => {
    beforeEach(() => putCell(noumeaCell));

    it('keeps only the allow-listed facts, marks the plan aboard-only and rebuilds number-free notes', () => {
        const full = inshorePlan(['OC-99-ZZTEST']);
        const before = JSON.stringify(full);
        const stripped = chartFreeVoyagePlan(full);
        expect(JSON.stringify(full)).toBe(before);
        const props = stripped.routeGeoJSON!.properties as Record<string, unknown>;
        for (const k of Object.keys(props)) expect(KEPT_PROPERTIES, k).toContain(k);
        expect(props.chartFacts).toBe('aboard-only');
        expect(props.dryStretches).toBe(true);
        // That it had tide gates, never where (the departure planner).
        expect(props.tideGates).toBe(true);
        expect(props.pinOffWater).toEqual({ origin: 'drying' });
        expect(stripped.routeGeoJSON!.geometry.coordinates).toEqual(line);
        const caveats = stripped.__inshoreRouting!.caveats!;
        expect(caveats).toContain(DRY_LINE_ABOARD);
        expect(caveats).toContain(CHART_NOTES_ABOARD);
        expect(caveats.some((c) => c.includes('drying bank'))).toBe(true);
        // The follow gate still finds the red line in the Log notes.
        expect(plannedRouteDryFinding(caveats)?.tone).toBe('finding');
        expectNoChartFigures(stripped);
        const allowed = new Set([...line.flat(), 3.1, 1_760_000_000_000, -22.27, 166.41, -22.33, 166.45]);
        for (const n of numbersIn(stripped)) expect(allowed, String(n)).toContain(n);
        // Stripping again changes nothing (a boot load does not re-save every
        // launch): the same object, also as read back from the disk.
        expect(chartFreeVoyagePlan(stripped)).toBe(stripped);
        const disk = JSON.parse(JSON.stringify(stripped)) as VoyagePlan;
        expect(chartFreeVoyagePlan(disk)).toBe(disk);
    });

    it('passes null through: the planner resets the plan by saving null', () => {
        expect(chartFreeVoyagePlan(null as unknown as VoyagePlan)).toBeNull();
    });

    it('a route with no tide gates is not marked as having them', () => {
        const full = inshorePlan(['OC-99-ZZTEST']);
        (full.routeGeoJSON!.properties as Record<string, unknown>).shallowRuns = [];
        const props = chartFreeVoyagePlan(full).routeGeoJSON!.properties as Record<string, unknown>;
        expect(props.chartFacts).toBe('aboard-only');
        expect(props.tideGates).toBeUndefined();
    });

    it('a plan carrying only notes keeps the ones with no chart figure; with NOAA cells, every one', () => {
        const bridges =
            'Bridges and power lines not checked on 2 of the charts on this route — known bridges are. Check the chart for anything overhead against your air draft before you pass under it.';
        const pin = "Your departure pin is on charted land — the route starts at the water's edge.";
        const depth =
            'Your destination pin is in 0.43 m charted water — the route ends there and needs +2.47 m of tide.';
        const bend = 'At 22°18.066′S 166°25.398′E the route bends north to reach charted deeper water sooner.';
        const notesOnly = (cellsUsed?: string[]) =>
            ({
                origin: 'A',
                destination: 'B',
                __inshoreRouting: { status: 'success', caveats: [bridges, pin, depth, bend], cellsUsed },
            }) as unknown as VoyagePlan;
        // The map planner's Save to Log, over licensed charts or none known.
        for (const cells of [['OC-99-ZZTEST'], undefined]) {
            const kept = chartFreeVoyagePlan(notesOnly(cells)).__inshoreRouting!.caveats;
            expect(kept, String(cells)).toEqual([bridges, pin, CHART_NOTES_ABOARD]);
        }
        // NOAA (public domain): written exactly as worked out.
        const noaa = notesOnly(['US5XX01M']);
        expect(chartFreeVoyagePlan(noaa)).toBe(noaa);
        // A route followed from the Log carries no cells: its number-free lines stay.
        const followed = buildFollowRoutePlanFromRoute({
            label: 'Annapolis → Oxford',
            points: [
                { lat: 38.97, lon: -76.48 },
                { lat: 38.69, lon: -76.17 },
            ],
            distanceNm: 21,
            timestamp: '2026-10-10T07:00:00.000Z',
            caveats: [bridges, pin],
        } as unknown as Parameters<typeof buildFollowRoutePlanFromRoute>[0])!;
        expect(chartFreeVoyagePlan(followed).__inshoreRouting!.caveats).toEqual([bridges, pin]);
    });

    it('fails closed when cellsUsed is missing but chart facts are present', () => {
        const stripped = chartFreeVoyagePlan(inshorePlan(undefined));
        expect((stripped.routeGeoJSON!.properties as Record<string, unknown>).chartFacts).toBe('aboard-only');
        expectNoChartFigures(stripped);
    });

    it('leaves an all-NOAA plan, a hand-traced plan and a plain offshore plan exactly as they were', () => {
        const noaa = inshorePlan(['US5XX01M']);
        expect(chartFreeVoyagePlan(noaa)).toBe(noaa);
        const traced = {
            ...inshorePlan(undefined),
            __inshoreRouting: undefined,
            routeGeoJSON: {
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: line },
                properties: { _source: 'route-tracer', legGrades: ['clear', 'caution'] },
            },
        } as VoyagePlan;
        expect(chartFreeVoyagePlan(traced)).toBe(traced);
        const offshore = { ...traced, routeGeoJSON: { ...traced.routeGeoJSON!, properties: { source: 'isochrone' } } };
        expect(chartFreeVoyagePlan(offshore as VoyagePlan)).toBe(offshore);
    });

    it("a refusal worked out on licensed charts keeps its words but not the chart's figures", () => {
        const refused = {
            ...inshorePlan(undefined),
            routeGeoJSON: undefined,
            __inshoreRouting: {
                status: 'failed',
                errorCode: 'no-tide-clears',
                cellsUsed: ['OC-99-ZZTEST'],
                error: 'The Récif Fictif dries 0.57 m and you need 2.9 m: no tide clears it.',
            },
        } as VoyagePlan;
        const stripped = chartFreeVoyagePlan(refused);
        expect(stripped.__inshoreRouting?.status).toBe('failed');
        expect(stripped.__inshoreRouting?.errorCode).toBe('no-tide-clears');
        expect(stripped.__inshoreRouting?.error).toBeTruthy();
        expect(stripped.__inshoreRouting?.error).not.toMatch(/\d/);
        expectNoChartFigures(stripped);
    });
});
