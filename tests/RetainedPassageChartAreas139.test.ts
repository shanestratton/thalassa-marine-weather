import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionResult } from '../services/enc/types';
import type { Feature, Polygon } from 'geojson';
const h = vi.hoisted(() => ({
    cells: [] as EncCell[],
    cache: new Map<string, { blob: EncConversionResult; bytes: number }>(),
    receipts: new Map<string, object>(),
    version: 1,
    consent: true,
    consentRead: vi.fn(),
    permission: true,
    load: vi.fn(),
    touch: vi.fn(),
    query: vi.fn(),
    segments: vi.fn(),
    find: vi.fn(),
    publish: vi.fn(),
}));
vi.mock('../services/enc/EncCellMetadata', () => ({ cellsForBBox: () => h.cells, getVersion: () => h.version }));
vi.mock('../services/enc/EncCellStore', () => ({
    peekCellGeoJSON: (id: string) => h.cache.get(id)?.blob,
    readRetainedCellGeoJSONBytes: (id: string, blob: EncConversionResult) =>
        h.cache.get(id)?.blob === blob ? h.cache.get(id)!.bytes : null,
    loadCellGeoJSON: h.load,
}));
vi.mock('../services/enc/piCellSync', () => ({
    readPiChartReadEvidence: (cell: EncCell) => (h.permission ? (h.receipts.get(cell.id) ?? null) : null),
    isPiChartReadEvidenceCurrent: (receipt: object, cell: EncCell) =>
        h.permission && h.receipts.get(cell.id) === receipt,
}));
vi.mock('../services/enc/noaaAgreement', () => ({ noaaAgreementAccepted: h.consentRead }));
vi.mock('../services/routing/routingExclusions', () => ({
    routingExclusionContextKey: () => 'fixture-no-private-policy',
    readCurrentRoutingExclusions: async ({ signal }: { signal: AbortSignal }) => {
        let active = true;
        return {
            manual: undefined,
            marineParks: undefined,
            advisories: [],
            isCurrent: () => active && !signal.aborted,
            release: () => {
                active = false;
            },
        };
    },
}));
vi.mock('../services/HazardQueryService', () => ({
    GEBCO_MSL_TO_LAT_PESSIMISM_M: 1.3,
    regionalGebcoDatumDeltaM: () => 1.3,
    hazardDepthForDraft: () => -3,
    hasEncCoverageFor: () => true,
    preloadEncForBBox: async () => {},
    queryHazards: h.query,
    querySegmentHazards: h.segments,
    querySegmentCautions: async (segments: unknown[]) => segments.map(() => []),
}));
vi.mock('../services/enc/EncHazardReportService', () => ({ setLastReport: h.publish, findHazardsAlongRoute: h.find }));
vi.mock('../services/enc/encIndexCache', () => ({ failedCellIds: () => [] }));

import {
    readRetainedPassageChartAreas,
    type RetainedPassageChartAreas,
} from '../services/enc/readRetainedPassageChartAreas';
import { registerRetainedNoaaWindow, borrowRetainedNoaaWindow } from '../services/enc/noaaRetainedWindow';
import {
    reserveRetainedAreaField,
    retainedAreaFieldBytes,
    RETAINED_AREA_FIELD_BYTES,
} from '../services/enc/retainedAreaBudget';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { ROUTING_AREA_CAVEATS } from '../services/routing/routeAreaWords';
import { validateRouteSegments } from '../services/isochrone/landAvoidance';
const window = [-1, -1, 1, 1] as const;
const line: [number, number][] = [
    [-0.5, 0],
    [0.5, 0],
];
const readers: RetainedPassageChartAreas[] = [],
    owners: Array<() => void> = [];
function cell(id = 'AU500001'): EncCell {
    return {
        id,
        sourceHO: id.startsWith('US') ? 'US' : 'AHO',
        edition: 1,
        updateNumber: 0,
        issued: '2026-10-17',
        importedAt: '2026-10-17',
        bbox: [-1, -1, 1, 1],
        geojsonPath: 'fixture',
        hazardCount: 0,
        usage: 'navigation',
        contentSha256: 'a'.repeat(64),
        sizeBytes: 1,
    };
}
function area(properties: Record<string, unknown> = {}): Feature<Polygon> {
    return {
        type: 'Feature',
        properties,
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [-0.1, -0.1],
                    [0.1, -0.1],
                    [0.1, 0.1],
                    [-0.1, 0.1],
                    [-0.1, -0.1],
                ],
            ],
        },
    };
}
function blob(c: EncCell): EncConversionResult {
    return {
        cellId: c.id,
        sourceHO: c.sourceHO,
        edition: c.edition,
        updateNumber: c.updateNumber,
        issued: c.issued,
        bbox: [...c.bbox],
        layers: Object.fromEntries(
            ['RESARE', 'TSEZNE', 'TSSLPT'].map((name) => [name, { type: 'FeatureCollection', features: [] }]),
        ),
    };
}
function install(c = cell(), b = blob(c), bytes = 1024) {
    h.cells.push(c);
    h.cache.set(c.id, { blob: b, bytes });
    h.receipts.set(c.id, {});
    return b;
}
async function read(signal = new AbortController().signal) {
    const result = await readRetainedPassageChartAreas({ bbox: window, signal, assertCurrent: () => {} });
    readers.push(result);
    return result;
}
beforeEach(() => {
    vi.clearAllMocks();
    h.cells = [];
    h.cache.clear();
    h.receipts.clear();
    h.version = 1;
    h.consent = true;
    h.consentRead.mockImplementation(async () => h.consent);
    h.permission = true;
    setAuthIdentityScope('retained-chart-owner');
    h.query.mockImplementation(async (points: { lat: number; lon: number }[]) =>
        points.map((p) => ({ ...p, isHazard: false, source: 'enc', depth_m: -40, catzoc: 1 })),
    );
    h.segments.mockImplementation(async (segments: unknown[]) =>
        segments.map(() => ({ isHazard: false, source: 'enc', depth_m: -40 })),
    );
    h.find.mockResolvedValue({ cellsConsulted: 1, bufferNm: 1, entries: [], advisories: [] });
});
afterEach(() => {
    readers.splice(0).forEach((r) => r.release());
    owners.splice(0).forEach((f) => f());
    expect(retainedAreaFieldBytes()).toBe(0);
});
describe('genuine bounded retained-original passage area reader', () => {
    it('distinguishes extracted empty classes from geographic coverage without reading or touching cache order', async () => {
        install();
        const r = await read();
        expect(r.classes).toEqual({ RESARE: 'extracted', TSEZNE: 'extracted', TSSLPT: 'extracted' });
        expect(r.geographicCoverage).toBe('unknown');
        expect(r.auditFinishedRoute(line, () => {})).toEqual({
            exclusionsUnchecked: true,
            notes: [ROUTING_AREA_CAVEATS[6]],
        });
        expect(h.load).not.toHaveBeenCalled();
        expect(h.touch).not.toHaveBeenCalled();
    });
    it.each(['7', '8'])('refuses original RESARE%s even while another original class is unavailable', async (code) => {
        const b = install();
        b.layers.RESARE!.features.push(area({ RESTRN: code, OBJNAM: 'never exported' }));
        delete b.layers.TSEZNE;
        const r = await read();
        expect(r.classes.TSEZNE).toBe('unavailable');
        expect(r.auditFinishedRoute(line, () => {}).refusal?.code).toBe('route-exclusion');
        expect(JSON.stringify(r)).not.toContain('never exported');
    });
    it('keeps original TSEZNE closed even with unknown chart coverage', async () => {
        install().layers.TSEZNE!.features.push(area());
        expect((await read()).auditFinishedRoute(line, () => {}).refusal?.error).toContain('separation zone');
    });
    it.each([
        [90, 'charted-flow'],
        [null, 'orientation-unknown'],
    ] as const)('uses original ORIENT%j and emits planned-course caveats', async (orient, expected) => {
        install().layers.TSSLPT!.features.push(area({ ORIENT: orient }));
        const r = await read(),
            verdict = r.auditFinishedRoute(line, () => {});
        expect(verdict.refusal).toBeUndefined();
        expect(verdict.trafficLaneGuidance).toBe(expected);
        expect(verdict.notes).toContain(ROUTING_AREA_CAVEATS[expected === 'charted-flow' ? 7 : 8]);
        expect(verdict.notes).toContain(ROUTING_AREA_CAVEATS[9]);
    });
    it('refuses opposing and oblique courses from a later finished splice', async () => {
        install().layers.TSSLPT!.features.push(area({ ORIENT: 90 }));
        const r = await read();
        expect(r.auditFinishedRoute([...line].reverse(), () => {}).refusal?.code).toBe('route-exclusion');
        expect(
            r.auditFinishedRoute(
                [
                    [-0.5, -0.5],
                    [0.5, 0.5],
                ],
                () => {},
            ).refusal?.code,
        ).toBe('route-exclusion');
    });
    it('does not infer geometry from cells with absent receipts, missing RAM, wrong revision or refused consent', async () => {
        const b = install();
        b.layers.RESARE!.features.push(area({ RESTRN: 7 }));
        h.receipts.clear();
        expect((await read()).classes.RESARE).toBe('unavailable');
        h.receipts.set(h.cells[0].id, {});
        h.cache.clear();
        expect((await read()).classes.RESARE).toBe('unavailable');
        h.cache.set(b.cellId, { blob: { ...b, edition: 2 }, bytes: 1024 });
        expect((await read()).classes.RESARE).toBe('unavailable');
        h.cells = [];
        h.cache.clear();
        const c = cell('US5CA1LK');
        install(c, blob(c));
        h.consent = false;
        expect((await read()).classes.RESARE).toBe('unavailable');
    });
    it('rejects actual object replacement/eviction, auth A/B/A, metadata revision and Pi authority changes', async () => {
        const b = install();
        const r = await read();
        const proof = r.authorityCurrent;
        r.release();
        expect(proof()).toBe(true);
        h.cache.set(b.cellId, { blob: { ...b }, bytes: 1024 });
        expect(proof()).toBe(false);
        h.cache.set(b.cellId, { blob: b, bytes: 1024 });
        const revision = await read();
        h.version++;
        expect(revision.isCurrent()).toBe(false);
        h.version--;
        const auth = await read();
        setAuthIdentityScope('other-retained-owner');
        setAuthIdentityScope('retained-chart-owner');
        expect(auth.isCurrent()).toBe(false);
        const pi = await read();
        h.permission = false;
        expect(pi.isCurrent()).toBe(false);
    });
    it('rechecks NOAA consent at the final awaited confirmation', async () => {
        const c = cell('US5CA1LK');
        install(c, blob(c));
        const r = await read();
        h.consent = false;
        expect(await r.confirmCurrent()).toBe(false);
    });
    it('borrows only an active NOAA owner window and invalidates immediately when that owner releases', async () => {
        const c = cell('US5CA1LK');
        c.noaaPackage = { owner: 'user:retained-chart-owner', manifestSha256: 'b'.repeat(64), path: 'fixture' };
        const b = install(c, blob(c));
        b.layers.RESARE!.features.push(area({ RESTRN: 7 }));
        h.cache.clear();
        expect((await read()).classes.RESARE).toBe('unavailable');
        const retire = registerRetainedNoaaWindow(c, window, b, 1024);
        owners.push(retire);
        const r = await read(),
            borrowed = borrowRetainedNoaaWindow(c, window)!;
        expect(r.auditFinishedRoute(line, () => {}).refusal?.code).toBe('route-exclusion');
        retire();
        expect(borrowed.blob).toBeUndefined();
        expect(r.isCurrent()).toBe(false);
        expect(r.auditFinishedRoute(line, () => {}).refusal?.code).toBe('exclusion-unavailable');
        borrowed.release();
    });
    it('does not borrow an owner window that only partially covers the original requested window', async () => {
        const c = cell('US5CA1LK');
        c.noaaPackage = { owner: 'user:retained-chart-owner', manifestSha256: 'b'.repeat(64), path: 'fixture' };
        const b = install(c, blob(c));
        h.cache.clear();
        owners.push(registerRetainedNoaaWindow(c, [-0.1, -0.1, 0.1, 0.1], b, 1024));
        expect((await read()).classes.RESARE).toBe('unavailable');
    });
    it('uses actual cache-accounted bytes rather than a tiny metadata size and refuses >14 cells', async () => {
        install(undefined, undefined, 16 * 1024 * 1024 + 1);
        expect((await read()).classes.RESARE).toBe('unavailable');
        h.cells = [];
        h.cache.clear();
        for (let i = 0; i < 15; i++) install(cell('AU5' + String(i).padStart(5, '0')));
        expect((await read()).classes.RESARE).toBe('unavailable');
    });
    it('shares the selected4MiB budget across active readers without evicting or refreshing map data', async () => {
        install();
        const held = reserveRetainedAreaField();
        held.resize(RETAINED_AREA_FIELD_BYTES);
        try {
            const r = await read();
            expect(r.classes.RESARE).toBe('unavailable');
            expect(h.cache.size).toBe(1);
            expect(retainedAreaFieldBytes()).toBe(RETAINED_AREA_FIELD_BYTES);
        } finally {
            held.release();
        }
        const r = await read();
        expect(retainedAreaFieldBytes()).toBeGreaterThan(0);
        r.release();
        r.release();
        expect(retainedAreaFieldBytes()).toBe(0);
    });
    it('refuses a selected-field overbudget and keeps unsupported geometry explicitly unavailable', async () => {
        const b = install();
        b.layers.RESARE!.features.push(area({ RESTRN: '7,'.repeat(2200000) }));
        expect((await read()).classes.RESARE).toBe('unavailable');
        expect(retainedAreaFieldBytes()).toBe(0);
        b.layers.RESARE!.features = [
            { type: 'Feature', properties: { RESTRN: 7 }, geometry: { type: 'Point', coordinates: [0, 0] } },
        ];
        expect((await read()).classes.RESARE).toBe('unavailable');
    });
    it('releases selected data exactly once on abort and cannot adopt a finished line outside the original window', async () => {
        install().layers.TSEZNE!.features.push(area());
        const abort = new AbortController();
        const r = await read(abort.signal);
        expect(
            r.auditFinishedRoute(
                [
                    [-2, 0],
                    [2, 0],
                ],
                () => {},
            ).refusal?.code,
        ).toBe('exclusion-unavailable');
        abort.abort();
        r.release();
        expect(retainedAreaFieldBytes()).toBe(0);
        expect(r.isCurrent()).toBe(false);
    });
    it('never mutates or retains chart attributes in its selected original field', async () => {
        const b = install();
        const feature = area({ ORIENT: 90, OBJNAM: 'licensed original label' });
        b.layers.TSSLPT!.features.push(feature);
        const before = JSON.stringify(b),
            r = await read();
        expect(r.auditFinishedRoute(line, () => {}).trafficLaneGuidance).toBe('charted-flow');
        expect(JSON.stringify(r)).not.toContain('licensed original label');
        expect(JSON.stringify(b)).toBe(before);
    });
});

function nodes() {
    return [-0.5, 0.5].map((lon, i) => ({
        lat: 0,
        lon,
        timeHours: i,
        bearing: 90,
        speed: 6,
        tws: 15,
        twa: 90,
        distance: i * 60,
        parentIndex: null,
    }));
}
describe('real passage validator original-area final enforcement', () => {
    it.each(['RESARE', 'TSEZNE', 'TSSLPT'] as const)(
        'holds original %s violations before any success/report publication',
        async (cls) => {
            install().layers[cls]!.features.push(
                area(cls === 'RESARE' ? { RESTRN: 7 } : cls === 'TSSLPT' ? { ORIENT: 270 } : {}),
            );
            const outcome = vi.fn(),
                reports = vi.fn();
            await expect(
                validateRouteSegments(nodes(), { onVerificationOutcome: outcome, onHazardReport: reports }),
            ).rejects.toMatchObject({ code: 'route-exclusion' });
            expect(outcome).not.toHaveBeenCalled();
            expect(reports).not.toHaveBeenCalled();
            expect(h.publish).not.toHaveBeenCalled();
            expect(retainedAreaFieldBytes()).toBe(0);
        },
    );
    it('checks original area geometry against a new land detour, rather than the unmodified candidate', async () => {
        const feature = area();
        feature.geometry.coordinates = [
            [
                [-0.02, 0.07],
                [0.02, 0.07],
                [0.02, 0.1],
                [-0.02, 0.1],
                [-0.02, 0.07],
            ],
        ];
        install().layers.TSEZNE!.features.push(feature);
        h.segments.mockImplementationOnce(async (segments: unknown[]) =>
            segments.map(() => ({ isHazard: true, source: 'enc', depth_m: -1 })),
        );
        await expect(validateRouteSegments(nodes())).rejects.toMatchObject({ code: 'route-exclusion' });
        expect(h.publish).not.toHaveBeenCalled();
        expect(retainedAreaFieldBytes()).toBe(0);
    });
    it('retains the initial chart content fence during the final async hazard phase', async () => {
        install();
        let finish!: (value: unknown) => void;
        h.find.mockReturnValueOnce(
            new Promise((r) => {
                finish = r;
            }),
        );
        const outcome = vi.fn();
        const task = validateRouteSegments(nodes(), { onVerificationOutcome: outcome });
        const rejection = expect(task).rejects.toMatchObject({ code: 'exclusion-unavailable' });
        await vi.waitFor(() => expect(h.find).toHaveBeenCalledOnce());
        h.version++;
        finish({ cellsConsulted: 1, bufferNm: 1, entries: [], advisories: [] });
        await rejection;
        expect(outcome).not.toHaveBeenCalled();
        expect(h.publish).not.toHaveBeenCalled();
        expect(retainedAreaFieldBytes()).toBe(0);
    });
    it('confirms actual NOAA consent after the hazard phase and before final synchronous audits', async () => {
        const c = cell('US5CA1LK');
        install(c, blob(c));
        h.consentRead.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const outcome = vi.fn();
        await expect(validateRouteSegments(nodes(), { onVerificationOutcome: outcome })).rejects.toMatchObject({
            code: 'exclusion-unavailable',
        });
        expect(outcome).not.toHaveBeenCalled();
        expect(h.publish).not.toHaveBeenCalled();
        expect(retainedAreaFieldBytes()).toBe(0);
    });
    it('uses benign same-content cache warming from the staged core without an unnecessary source-retirement retry', async () => {
        const b = install();
        b.layers.TSSLPT!.features.push(area({ ORIENT: 90 }));
        h.cache.clear();
        h.query.mockImplementationOnce(async (points: { lat: number; lon: number }[]) => {
            h.cache.set(b.cellId, { blob: b, bytes: 1024 });
            return points.map((p) => ({ ...p, isHazard: false, source: 'enc', depth_m: -40, catzoc: 1 }));
        });
        const caveats = vi.fn();
        const result = await validateRouteSegments(nodes(), { onRouteAreaCaveats: caveats });
        expect(result).toHaveLength(2);
        expect(caveats.mock.calls[0][0]).toContain(ROUTING_AREA_CAVEATS[7]);
        expect(retainedAreaFieldBytes()).toBe(0);
    });
    it.each(['metadata revision', 'original content identity'])(
        'rejects a core-await %s change before acquiring a fresh final generation',
        async (kind) => {
            install();
            const outcome = vi.fn();
            h.query.mockImplementationOnce(async (points: { lat: number; lon: number }[]) => {
                if (kind === 'metadata revision') h.version++;
                else h.cells[0].contentSha256 = 'b'.repeat(64);
                return points.map((p) => ({ ...p, isHazard: false, source: 'enc', depth_m: -40, catzoc: 1 }));
            });
            await expect(validateRouteSegments(nodes(), { onVerificationOutcome: outcome })).rejects.toMatchObject({
                code: 'exclusion-unavailable',
            });
            expect(outcome).not.toHaveBeenCalled();
            expect(h.publish).not.toHaveBeenCalled();
            expect(retainedAreaFieldBytes()).toBe(0);
        },
    );
    it('supplies a useful weak adoption check after release without retaining selected geometry or source reservations', async () => {
        const b = install();
        b.layers.TSSLPT!.features.push(area({ ORIENT: 90 }));
        let sourceCurrent: (() => boolean) | undefined;
        let notes: readonly string[] = [];
        await validateRouteSegments(nodes(), {
            onRouteAreaCaveats: (value, current) => {
                notes = value;
                sourceCurrent = current;
            },
        });
        expect(retainedAreaFieldBytes()).toBe(0);
        expect(sourceCurrent?.()).toBe(true);
        expect(notes).toContain(ROUTING_AREA_CAVEATS[7]);
        expect(notes).toContain(ROUTING_AREA_CAVEATS[9]);
        h.cache.set(b.cellId, { blob: { ...b }, bytes: 1024 });
        expect(sourceCurrent?.()).toBe(false);
    });
    it('releases the selected original field if a final consumer callback fails', async () => {
        install();
        await expect(
            validateRouteSegments(nodes(), {
                onRouteAreaCaveats: () => {
                    throw Error('consumer failed');
                },
            }),
        ).rejects.toMatchObject({ code: 'exclusion-unavailable' });
        expect(h.publish).not.toHaveBeenCalled();
        expect(retainedAreaFieldBytes()).toBe(0);
    });
});
