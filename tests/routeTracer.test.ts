/**
 * Route Tracer — pure leg-validator unit tests on a synthetic chart:
 * a deep basin (8 m) with a shallow square (1.5 m), a thin strip (3.5 m),
 * a land island, plus hand-placed cardinal / gate-pair / solo-lateral /
 * lead fixtures. Verifies the green/amber/red grading Shane specced
 * 2026-07-08 ("check depth and markers between that pin and the next").
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { FeatureCollection } from 'geojson';
import { buildNavGrid } from '../services/engine/navGrid';
import type { InshoreLayers } from '../services/inshoreRouterEngine';
import {
    validateTraceLeg,
    validateTrace,
    traceHealth,
    traceBbox,
    tracerResolutionM,
    traceAsCuratedFairwaySnippet,
    traceAsVoyagePlan,
    loadSavedTraces,
    saveTrace,
    deleteTrace,
    type TracerContext,
} from '../services/routeTracer';

const poly = (w: number, s: number, e: number, n: number, props: Record<string, unknown> = {}) => ({
    type: 'Feature' as const,
    properties: props,
    geometry: {
        type: 'Polygon' as const,
        coordinates: [
            [
                [w, s],
                [e, s],
                [e, n],
                [w, n],
                [w, s],
            ],
        ],
    },
});
const fc = (features: unknown[]): FeatureCollection => ({ type: 'FeatureCollection', features }) as FeatureCollection;

// Synthetic chart: bbox ≈ 4 km × 2.2 km.
const BBOX: [number, number, number, number] = [153.0, -27.02, 153.04, -27.0];
const DRAFT_M = 2.4; // Serene Summer
// keel floor = draft + 0.5 safety = 2.9 m; thin band up to 3.9 m.

const layers: InshoreLayers = {
    DEPARE: fc([
        poly(153.0, -27.02, 153.036, -27.0, { DRVAL1: 8, DRVAL2: 10 }), // deep basin (charts stop at 153.036)
        poly(153.01, -27.0085, 153.012, -27.0075, { DRVAL1: 1.5, DRVAL2: 1.5 }), // shallow square (sub-keel)
        poly(153.03, -27.02, 153.032, -27.0, { DRVAL1: 3.5, DRVAL2: 3.5 }), // thin strip
    ]),
    LNDARE: fc([poly(153.02, -27.012, 153.022, -27.008)]), // island
};

let baseCtx: TracerContext;

beforeAll(() => {
    const grid = buildNavGrid(layers, BBOX, 10, DRAFT_M, 0.5, 60);
    baseCtx = {
        grid,
        soloLaterals: [],
        cardinals: [],
        gatePairs: [],
        leads: [],
        canalLanes: [],
        draftM: DRAFT_M,
        draftAssumed: false,
        bbox: BBOX,
        resM: 10,
    };
});

describe('routeTracer — depth grading (P1)', () => {
    it('deep leg reads clear with the least depth reported', () => {
        const v = validateTraceLeg({ lat: -27.005, lon: 153.002 }, { lat: -27.005, lon: 153.008 }, baseCtx);
        expect(v.grade).toBe('clear');
        expect(v.minDepthM).toBeCloseTo(8, 0);
        expect(v.needsTide).toBe(false);
    });

    it('sub-keel leg reads danger, needs tide, and pins the shallow spot', () => {
        const v = validateTraceLeg({ lat: -27.008, lon: 153.008 }, { lat: -27.008, lon: 153.014 }, baseCtx);
        expect(v.grade).toBe('danger');
        expect(v.needsTide).toBe(true);
        expect(v.minDepthM).toBeCloseTo(1.5, 1);
        expect(v.issues[0].message).toContain('needs +1.4 m tide');
        expect(v.minAt).not.toBeNull();
        expect(v.minAt!.lon).toBeGreaterThan(153.009);
        expect(v.minAt!.lon).toBeLessThan(153.013);
    });

    it('sub-keel leg gets a deeper-water nudge when relief is a probe away', () => {
        const v = validateTraceLeg({ lat: -27.008, lon: 153.008 }, { lat: -27.008, lon: 153.014 }, baseCtx);
        expect(v.nudge).toMatch(/deeper water ~\d+ m to (port|starboard)/);
    });

    it('thin-water leg reads caution', () => {
        const v = validateTraceLeg({ lat: -27.005, lon: 153.028 }, { lat: -27.005, lon: 153.034 }, baseCtx);
        expect(v.grade).toBe('caution');
        expect(v.issues[0].message).toContain('thin water');
        expect(v.minDepthM).toBeCloseTo(3.5, 1);
    });

    it('leg across the island reads danger — crosses charted land', () => {
        const v = validateTraceLeg({ lat: -27.01, lon: 153.018 }, { lat: -27.01, lon: 153.024 }, baseCtx);
        expect(v.grade).toBe('danger');
        expect(v.issues.some((i) => i.message === 'crosses charted land')).toBe(true);
    });

    it('leg beyond chart coverage flags uncharted', () => {
        const v = validateTraceLeg({ lat: -27.005, lon: 153.0365 }, { lat: -27.005, lon: 153.0395 }, baseCtx);
        expect(v.grade).toBe('caution');
        expect(v.issues.some((i) => i.message.includes('no charted depth'))).toBe(true);
    });
});

describe('routeTracer — marker discipline (P2)', () => {
    it('leg on the WRONG side of a north cardinal is a danger with plain-english advice', () => {
        const ctx = { ...baseCtx, cardinals: [{ lat: -27.005, lon: 153.005, dir: 'n' as const, radiusM: 100 }] };
        const wrong = validateTraceLeg({ lat: -27.006, lon: 153.003 }, { lat: -27.006, lon: 153.007 }, ctx);
        expect(wrong.grade).toBe('danger');
        expect(wrong.issues[0].message).toContain('wrong side of the north cardinal');
        const right = validateTraceLeg({ lat: -27.003, lon: 153.003 }, { lat: -27.003, lon: 153.007 }, ctx);
        expect(right.issues.filter((i) => i.message.includes('cardinal'))).toHaveLength(0);
    });

    it('shaving a cardinal on the safe side is a caution', () => {
        const ctx = { ...baseCtx, cardinals: [{ lat: -27.005, lon: 153.005, dir: 'n' as const, radiusM: 100 }] };
        // ~55 m north of the mark — safe side, inside the 90 m clearance.
        const v = validateTraceLeg({ lat: -27.0045, lon: 153.003 }, { lat: -27.0045, lon: 153.007 }, ctx);
        expect(v.grade).toBe('caution');
        expect(v.issues[0].message).toContain('shaves the north cardinal');
    });

    it('threading a gate pair is clean; passing just outside a mark is a danger', () => {
        const ctx = {
            ...baseCtx,
            gatePairs: [{ port: { lat: -27.005, lon: 153.004 }, stbd: { lat: -27.005, lon: 153.006 } }],
        };
        const threaded = validateTraceLeg({ lat: -27.007, lon: 153.005 }, { lat: -27.003, lon: 153.005 }, ctx);
        expect(threaded.issues.filter((i) => i.message.includes('mark'))).toHaveLength(0);
        // ~150 m past the midpoint of a 200 m gate — inside 2× half-width.
        const outside = validateTraceLeg({ lat: -27.007, lon: 153.0065 }, { lat: -27.003, lon: 153.0065 }, ctx);
        expect(outside.grade).toBe('danger');
        expect(outside.issues[0].message).toContain('green (starboard) mark');
    });

    it('crossing the gate line WELL beyond the marks is an unrelated arm — no false red', () => {
        // Audit 1.10: Math.max(halfM*2, 300) flagged honest deep water 250 m
        // abeam of a narrow club channel. Cutoff now scales with the gate.
        const ctx = {
            ...baseCtx,
            gatePairs: [{ port: { lat: -27.005, lon: 153.004 }, stbd: { lat: -27.005, lon: 153.006 } }],
        };
        // ~250 m past the midpoint of the 200 m gate (2× half-width = 200 m).
        const wellPast = validateTraceLeg({ lat: -27.007, lon: 153.0075 }, { lat: -27.003, lon: 153.0075 }, ctx);
        expect(wellPast.issues.filter((i) => i.message.includes('mark'))).toHaveLength(0);
    });

    it('close approach to a solo lateral asks the skipper to verify the side', () => {
        const ctx = {
            ...baseCtx,
            soloLaterals: [{ lat: -27.005, lon: 153.005, side: 'port' as const, key: 'NUM', seq: 3, name: '3' }],
        };
        // ~30 m south of the mark.
        const v = validateTraceLeg({ lat: -27.00527, lon: 153.004 }, { lat: -27.00527, lon: 153.006 }, ctx);
        expect(v.grade).toBe('caution');
        expect(v.issues[0].message).toContain('verify your side');
    });
});

describe('routeTracer — leads (P3)', () => {
    it('riding ~50 m off a parallel lead is a caution with the offset', () => {
        const ctx = {
            ...baseCtx,
            leads: [
                {
                    pts: [
                        { lat: -27.005, lon: 153.002 },
                        { lat: -27.005, lon: 153.008 },
                    ],
                },
            ],
        };
        const v = validateTraceLeg({ lat: -27.00455, lon: 153.003 }, { lat: -27.00455, lon: 153.007 }, ctx);
        expect(v.grade).toBe('caution');
        expect(v.issues[0].message).toMatch(/\d+ m off the lead/);
    });

    it('a crossing (non-parallel) leg near the lead is NOT flagged', () => {
        const ctx = {
            ...baseCtx,
            leads: [
                {
                    pts: [
                        { lat: -27.005, lon: 153.002 },
                        { lat: -27.005, lon: 153.008 },
                    ],
                },
            ],
        };
        const v = validateTraceLeg({ lat: -27.007, lon: 153.005 }, { lat: -27.003, lon: 153.005 }, ctx);
        expect(v.issues.filter((i) => i.message.includes('lead'))).toHaveLength(0);
    });
});

describe('routeTracer — trace plumbing (P4)', () => {
    it('validateTrace grades every leg and traceHealth aggregates honestly', () => {
        const pts = [
            { lat: -27.005, lon: 153.002 }, // deep
            { lat: -27.005, lon: 153.008 }, // deep → clear
            { lat: -27.008, lon: 153.011 }, // into the shallow square → danger
        ];
        const verdicts = validateTrace(pts, baseCtx);
        expect(verdicts).toHaveLength(2);
        const h = traceHealth(verdicts);
        expect(h.danger).toBe(1);
        expect(h.tone).toBe('danger');
        expect(h.label).toContain('no-go');
    });

    it('curated-fairway snippet is paste-ready [lon,lat] with a padded bbox', () => {
        const pts = [
            { lat: -27.005, lon: 153.002 },
            { lat: -27.006, lon: 153.01 },
        ];
        const snippet = JSON.parse(traceAsCuratedFairwaySnippet('My Channel', pts));
        expect(snippet.id).toBe('my-channel');
        expect(snippet.line).toEqual([
            [153.002, -27.005],
            [153.01, -27.006],
        ]);
        const [w, s, e, n] = snippet.bbox;
        expect(w).toBeLessThan(153.002);
        expect(s).toBeLessThan(-27.006);
        expect(e).toBeGreaterThan(153.01);
        expect(n).toBeGreaterThan(-27.005);
        expect(traceBbox(pts)[0]).toBeLessThan(153.002);
    });

    it('traceAsVoyagePlan carries the exact line, interior waypoints only, parseable duration', () => {
        const pts = [
            { lat: -27.005, lon: 153.002 },
            { lat: -27.005, lon: 153.01 },
            { lat: -27.005, lon: 153.02 },
        ];
        const plan = traceAsVoyagePlan('Test run', pts);
        // Endpoints live in origin/destinationCoordinates — duplicating them
        // into waypoints made 32 log rows for 30 pins (audit 1.7).
        expect(plan.waypoints).toHaveLength(1);
        expect(plan.waypoints[0].name).toBe('Pin 2');
        expect(plan.routeGeoJSON?.geometry.coordinates).toEqual([
            [153.002, -27.005],
            [153.01, -27.005],
            [153.02, -27.005],
        ]);
        expect(plan.routeGeoJSON?.properties?._source).toBe('route-tracer');
        // Fractional hours ALWAYS — "NN minutes" parsed to null and became a
        // 12-hour log spread (audit 1.7).
        expect(plan.durationApprox).toMatch(/^\d+\.\d hours$/);
        expect(plan.originCoordinates).toEqual({ lat: -27.005, lon: 153.002 });
        expect(plan.destinationCoordinates).toEqual({ lat: -27.005, lon: 153.02 });
        // Unnamed traces get a time-stamped label so the same-day logbook
        // duplicate check can't collide (audit 1.6).
        const unnamed = traceAsVoyagePlan('', pts);
        expect(unnamed.origin).toMatch(/Traced route \d{2}:\d{2} \(3 pins\) — start/);
    });

    it('save / load / delete round-trips through localStorage and reports persistence honestly', () => {
        const store = new Map<string, string>();
        (globalThis as Record<string, unknown>).localStorage = {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        };
        const { trace: saved, persisted } = saveTrace('Round trip', [
            { lat: -27.005, lon: 153.002 },
            { lat: -27.005, lon: 153.02 },
        ]);
        expect(persisted).toBe(true);
        expect(loadSavedTraces().map((t) => t.id)).toContain(saved.id);
        deleteTrace(saved.id);
        expect(loadSavedTraces()).toHaveLength(0);
        // Quota-refused write must report persisted=false — the UI used to
        // flash "Saved ✓" over a trace that wouldn't exist next session.
        (globalThis as Record<string, unknown>).localStorage = {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: () => {
                throw new Error('QuotaExceededError');
            },
            removeItem: (k: string) => void store.delete(k),
        };
        const refused = saveTrace('No room', [
            { lat: -27.005, lon: 153.002 },
            { lat: -27.005, lon: 153.02 },
        ]);
        expect(refused.persisted).toBe(false);
        delete (globalThis as Record<string, unknown>).localStorage;
    });
});

describe('routeTracer — Phase 1 hardening', () => {
    it('marks-only context (no grid) says "depth unchecked", never guesses', () => {
        const ctx: TracerContext = { ...baseCtx, grid: null };
        const v = validateTraceLeg({ lat: -27.005, lon: 153.002 }, { lat: -27.005, lon: 153.008 }, ctx);
        expect(v.grade).toBe('caution');
        expect(v.issues[0].message).toContain('depth unchecked');
        expect(v.minDepthM).toBeNull();
        expect(v.needsTide).toBe(false);
    });

    it('fallback-draft verdicts downgrade clear → caution with the reason', () => {
        const ctx: TracerContext = { ...baseCtx, draftAssumed: true };
        const v = validateTraceLeg({ lat: -27.005, lon: 153.002 }, { lat: -27.005, lon: 153.008 }, ctx);
        expect(v.grade).toBe('caution');
        expect(v.issues[0].message).toContain('default 2.5 m draft');
        // Real issues still outrank the draft note — a danger stays a danger.
        const danger = validateTraceLeg({ lat: -27.008, lon: 153.008 }, { lat: -27.008, lon: 153.014 }, ctx);
        expect(danger.grade).toBe('danger');
    });

    it('a carved canal LANE overrides chart-land bleed within its half-width — and only there', () => {
        // The island leg is a hard 'crosses charted land' danger normally…
        const laneCtx: TracerContext = {
            ...baseCtx,
            canalLanes: [
                {
                    pts: [
                        { lat: -27.01, lon: 153.017 },
                        { lat: -27.01, lon: 153.025 },
                    ],
                },
            ],
        };
        // …but with a curated lane down the middle it grades caution (the
        // lane is navigable, depth-unknown), matching the engine's carve.
        const v = validateTraceLeg({ lat: -27.01, lon: 153.018 }, { lat: -27.01, lon: 153.024 }, laneCtx);
        expect(v.issues.filter((i) => i.message === 'crosses charted land')).toHaveLength(0);
        expect(v.grade).toBe('caution');
        // ~90 m off the lane the same land is STILL land — the lane is a
        // lane, not an amnesty (the v1 over-the-spit fairway must stay red).
        const off = validateTraceLeg(
            { lat: -27.0105, lon: 153.018 },
            { lat: -27.0105, lon: 153.024 },
            {
                ...laneCtx,
                canalLanes: [
                    {
                        pts: [
                            { lat: -27.01131, lon: 153.017 }, // lane moved ~90 m away
                            { lat: -27.01131, lon: 153.025 },
                        ],
                    },
                ],
            },
        );
        expect(off.issues.some((i) => i.message === 'crosses charted land')).toBe(true);
    });

    it('resolution scales with bbox — the cell budget is never exceeded (no 60 m cap inversion)', () => {
        // Marina scale: fine (berth carve active).
        expect(tracerResolutionM([153.0, -27.02, 153.03, -27.0])).toBeLessThan(20);
        // A 2°×2° monster (audit critical 1.2: the old Math.min(60,…) pinned
        // this at 60 m → ~42M cells ≈ 800 MB → jetsam kill). Now the grid
        // coarsens past 60 m so cells stay bounded.
        const bigRes = tracerResolutionM([153.0, -29.0, 155.0, -27.0]);
        expect(bigRes).toBeGreaterThan(60);
        const spanM = 2 * 110_540;
        expect((spanM / bigRes) * ((2 * 111_320 * Math.cos((-28 * Math.PI) / 180)) / bigRes)).toBeLessThan(2_100_000);
    });
});
