/** Main-thread source admission. No provider activation, WAN, chart writes or
 * serialized authority. Geometry and its real cohort lease live for one run. */
import type { FeatureCollection, MultiPolygon, Polygon, Geometry } from 'geojson';
import type { EncCell, EncConversionResult } from '../enc/types';
import type { InshoreLayers } from '../engine/types';
import type { TideGateArea, TideGatedCandidateRequest, TideGridPath } from '../engine/tideGatedSearch';
import { tideGatedBounds, tideGatedGridLayout } from '../engine/tideGatedSearch';
export { tideGatedBounds } from '../engine/tideGatedSearch';
import { cellsForBBox, getVersion } from '../enc/EncCellMetadata';
import { peekCellGeoJSON, readRetainedCellGeoJSONBytes } from '../enc/EncCellStore';
import { loadNoaaPackageCohort } from '../enc/noaaPackageWindow';
import { readPiChartReadEvidence, isPiChartReadEvidenceCurrent } from '../enc/piCellSync';
import { encCellContentIdentity } from '../enc/cellContentIdentity';
import { cellSoundingDatum } from '../enc/chartDatum';
import { isProtectedChart } from '../enc/chartLicence';
import { loadPassageTideSources } from '../tides/passageTideSources';
import { REVIEWED_SAMPLED_TIDE_AUTHORITY } from '../tides/sampledTideNavigation';
import {
    reviewWaterInterval,
    isReviewedWaterInterval,
    type WaterIntervalContext,
} from '../tides/reviewedWaterInterval';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { trackPriorContextKey } from './trackRoutingPriors';
import { holdingGeometryRelation, type HoldingBounds } from '../enc/holdingFootprint';
import { haversineM, bboxBuckets } from '../engine/geometry';
import { chartFindGeneration } from '../enc/chartFindMemory';

const classes = [
    'DEPARE',
    'LNDARE',
    'COALNE',
    'OBSTRN',
    'WRECKS',
    'UWTROC',
    'SOUNDG',
    'M_QUAL',
    'M_SDAT',
    'RESARE',
    'TSEZNE',
    'TSSLPT',
    'BRIDGE',
    'CBLOHD',
    'PIPOHD',
    'CONVYR',
    'SLCONS',
    'DAMCON',
    'PILPNT',
    'PONTON',
    'MARCUL',
] as const;
const gridClasses = ['DEPARE', 'LNDARE', 'OBSTRN', 'WRECKS', 'UWTROC', 'M_QUAL'] as const;
const issued = new WeakMap<object, { check: () => void; finish: (path: TideGridPath) => Promise<boolean> }>();
export interface TideGatedSourceRequest {
    from: { lat: number; lon: number };
    to: { lat: number; lon: number };
    departureMs: number;
    speedKts: number;
    requiredM: number;
    lifetimeKey: string;
    uncertaintyMs: number;
}
export interface TideGatedSourcePermit {
    readonly request: TideGatedCandidateRequest;
    readonly layers: InshoreLayers;
    readonly bounds: HoldingBounds;
    readonly chartContentKey: string;
    readonly aboardOnly: boolean;
    readonly sourceSummary: string;
}
export type TideGatedSourceReview =
    | { kind: 'held'; reason: string; release: () => void }
    | { kind: 'ready'; permit: TideGatedSourcePermit; release: () => void };
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
function freezeOwned<T>(value: T): T {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) freezeOwned(child);
    }
    return value;
}
function originalBounds(geometry: Geometry): HoldingBounds {
    const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = (v: unknown): void => {
        if (!Array.isArray(v)) throw Error('An original footprint is malformed.');
        if (typeof v[0] === 'number') {
            b[0] = Math.min(b[0], v[0]);
            b[1] = Math.min(b[1], v[1]);
            b[2] = Math.max(b[2], v[0]);
            b[3] = Math.max(b[3], v[1]);
        } else for (const child of v) walk(child);
    };
    if (geometry.type === 'GeometryCollection') throw Error('An original footprint has no bounded geometry.');
    walk(geometry.coordinates);
    return b;
}

/** Current adapters return no navigationSeries: their extrema, local model or
 * untied WorldTides display predictions cannot mint a source permit. A future
 * explicitly reviewed adapter/rights/tie can pass the same actual reader. */
export async function prepareTideGatedSources(
    input: TideGatedSourceRequest,
    options: { signal: AbortSignal; assertCurrent: () => void },
): Promise<TideGatedSourceReview> {
    const r = Object.freeze({ ...input, from: Object.freeze({ ...input.from }), to: Object.freeze({ ...input.to }) });
    const scope = getAuthIdentityScope(),
        version = getVersion(),
        prior = trackPriorContextKey(),
        chartLifetime = chartFindGeneration(),
        started = Date.now();
    let released = false,
        cohort: Awaited<ReturnType<typeof loadNoaaPackageCohort>> | null = null;
    const receipts: Array<{ cell: EncCell; receipt: NonNullable<ReturnType<typeof readPiChartReadEvidence>> }> = [];
    const checkBase = () => {
        options.signal.throwIfAborted();
        options.assertCurrent();
        const now = Date.now();
        if (
            released ||
            now < started ||
            now >= started + 5 * 60_000 ||
            !isAuthIdentityScopeCurrent(scope) ||
            version !== getVersion() ||
            prior !== trackPriorContextKey() ||
            chartLifetime !== chartFindGeneration()
        )
            throw new DOMException('Tide source run retired.', 'AbortError');
        for (const { cell, receipt } of receipts)
            if (!isPiChartReadEvidenceCurrent(receipt, cell, now))
                throw new DOMException('Actual Pi chart read retired.', 'AbortError');
    };
    const check = () => {
        checkBase();
        cohort?.check();
    };
    const release = () => {
        released = true;
        cohort?.release();
    };
    const held = (reason: string): TideGatedSourceReview => {
        release();
        return { kind: 'held', reason, release };
    };
    try {
        check();
        const bounds = tideGatedBounds(r.from, r.to);
        if (
            !bounds ||
            ![r.departureMs, r.speedKts, r.requiredM, r.uncertaintyMs].every(finite) ||
            r.speedKts <= 0 ||
            r.speedKts > 100 ||
            r.requiredM <= 0 ||
            r.uncertaintyMs < 60_000 ||
            r.uncertaintyMs > 3_600_000 ||
            !r.lifetimeKey ||
            r.lifetimeKey.length > 160
        )
            return held('Exact departure, vessel speed, depth margin or arrival uncertainty is missing.');
        const source = await loadPassageTideSources(
            { lat: (r.from.lat + r.to.lat) / 2, lon: (r.from.lon + r.to.lon) / 2 },
            r.departureMs,
            'aboard',
            { signal: options.signal, assertCurrent: check },
        );
        check();
        if (!source.navigationSeries.length)
            return held(
                'No original sampled tide product with reviewed navigation rights and a current chart-datum tie is aboard. Official high/low tables and WorldTides remain informational.',
            );
        if (source.navigationSeries.length > 3) return held('The tide source set exceeds the three-station bound.');
        const cells = cellsForBBox([...bounds]);
        if (!cells.length || cells.length > 14)
            return held('The complete original chart window is absent or exceeds 14 cells.');
        cohort = await loadNoaaPackageCohort(
            cells.filter((c) => c.noaaPackage),
            [...bounds],
            checkBase,
        );
        check();
        const blobs: Array<{ cell: EncCell; blob: EncConversionResult }> = [];
        const soundings: Array<{ lon: number; lat: number; depthM: number }> = [];
        let bytes = cohort.bytes,
            objects = 0,
            vertices = 0,
            comparisons = 0,
            qualityCover = false;
        const vertex = () => {
            if (++vertices > 65536) throw Error('Tide chart window exceeds 65,536 vertices.');
            if (vertices % 256 === 0) check();
        };
        const compare = () => {
            if (++comparisons > 500000) throw Error('Tide chart window exceeds 500,000 boundary comparisons.');
            if (comparisons % 256 === 0) check();
        };
        for (const cell of cells) {
            check();
            if (!cell.noaaPackage) {
                const receipt = readPiChartReadEvidence(cell);
                if (!receipt)
                    return held(
                        'An original chart has no current verified Pi read receipt or retained public-package lease.',
                    );
                receipts.push({ cell, receipt });
            }
            const blob = cell.noaaPackage ? cohort.blobs.get(cell.id) : peekCellGeoJSON(cell.id);
            check();
            if (!cell.noaaPackage && blob) {
                const measured = readRetainedCellGeoJSONBytes(cell.id, blob);
                if (measured === null) return held('An original Pi chart has no current measured RAM byte proof.');
                bytes += measured;
            }
            if (bytes > 16 * 1024 * 1024)
                return held('The complete tide chart window exceeds the existing 16 MiB view bound.');
            if (
                !blob ||
                blob.cellId !== cell.id ||
                blob.sourceHO !== cell.sourceHO ||
                blob.edition !== cell.edition ||
                blob.updateNumber !== cell.updateNumber ||
                blob.issued !== cell.issued ||
                !cellSoundingDatum(blob)
            )
                return held(
                    'An original chart is absent from the current complete RAM window, or its revision/whole-cell sounding datum is unknown.',
                );
            for (const cls of classes) {
                const fc = blob.layers[cls];
                if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features))
                    return held(`Original chart class ${cls} was not completely extracted.`);
                for (const feature of fc.features) {
                    if (++objects > 16000) return held('The original chart window exceeds 16,000 objects.');
                    const relation = holdingGeometryRelation(feature.geometry, bounds, vertex, compare);
                    if (cls === 'M_QUAL' && relation.intersects) {
                        if (![1, 2, 3].includes(Number(feature.properties?.CATZOC ?? feature.properties?.catzoc)))
                            return held('Original survey confidence is unknown or CATZOC C/D/U in this window.');
                        qualityCover ||= relation.covers;
                    }
                }
            }
            for (const f of blob.layers.SOUNDG!.features) {
                const coordinates =
                    f.geometry.type === 'Point'
                        ? [f.geometry.coordinates]
                        : f.geometry.type === 'MultiPoint'
                          ? f.geometry.coordinates
                          : null;
                const p = f.properties ?? {},
                    originalPlane = p.depths ?? p.DEPTHS;
                const plane = Array.isArray(originalPlane) ? originalPlane : null;
                if (!coordinates || (originalPlane !== undefined && (!plane || plane.length !== coordinates.length)))
                    return held('An original sounding depth plane is missing or misaligned.');
                for (let i = 0; i < coordinates.length; i++) {
                    const point = coordinates[i];
                    if (point[0] < bounds[0] || point[0] > bounds[2] || point[1] < bounds[1] || point[1] > bounds[3])
                        continue;
                    const depthM = plane
                        ? plane[i]
                        : (point[2] ??
                          (f.geometry.type === 'Point' ? (p.VALSOU ?? p.valsou ?? p.DEPTH ?? p.depth) : undefined));
                    if (!finite(depthM))
                        return held('An original sounding in the shortcut window has no numeric depth.');
                    soundings.push({ lon: point[0], lat: point[1], depthM });
                }
            }
            blobs.push({ cell, blob });
        }
        if (!qualityCover) return held('No original acceptable survey polygon covers the complete shortcut window.');
        const chartContentKey = cells.map(encCellContentIdentity).sort().join('|');
        const datums = new Set(blobs.map(({ blob }) => cellSoundingDatum(blob)));
        if (datums.size !== 1) return held('The complete chart window has conflicting sounding datums.');
        const datum = [...datums][0]!;
        const layers: InshoreLayers = {};
        for (const cls of gridClasses)
            layers[cls] = {
                type: 'FeatureCollection',
                features: blobs.flatMap(({ blob }) => blob.layers[cls]!.features),
            } as FeatureCollection;
        layers.COASTLINE = {
            type: 'FeatureCollection',
            features: blobs.flatMap(({ blob }) => blob.layers.COALNE!.features),
        };
        // No sounding-datum tide may open an overhead structure. Its original
        // footprint becomes a hard obstacle for this optional route instead.
        for (const { blob } of blobs)
            for (const cls of [
                'BRIDGE',
                'CBLOHD',
                'PIPOHD',
                'CONVYR',
                'SLCONS',
                'DAMCON',
                'PILPNT',
                'PONTON',
                'MARCUL',
            ] as const)
                for (const feature of blob.layers[cls]!.features)
                    layers.OBSTRN!.features.push({ ...feature, properties: { _class: 'tide-overhead-exclusion' } });
        for (const cls of ['RESARE', 'TSEZNE', 'TSSLPT'] as const)
            (layers as Record<string, unknown>)[cls] = {
                type: 'FeatureCollection',
                features: blobs.flatMap(({ blob }) => blob.layers[cls]!.features),
            };
        const ownedLayers = freezeOwned(structuredClone(layers));
        const { buildTideDepthCoverage } = await import('../enc/tideDepthCoverage');
        check();
        const depthCoverage = buildTideDepthCoverage(ownedLayers.DEPARE!.features, bounds, check);
        if (!depthCoverage) return held('The complete positive-depth coverage union is unavailable.');
        const layout = tideGatedGridLayout(bounds).grid;
        const hardObjects = ['LNDARE', 'OBSTRN', 'WRECKS', 'UWTROC', 'COASTLINE']
            .flatMap((cls) => ownedLayers[cls as keyof InshoreLayers]?.features ?? [])
            .map((feature) => ({ geometry: feature.geometry, bbox: originalBounds(feature.geometry) }));
        const hardQuery = bboxBuckets(hardObjects, (item) => item.bbox);
        const soundQuery = bboxBuckets(soundings, (point) => [point.lon, point.lat, point.lon, point.lat]);
        // Restrictions are not depth credit. Keep their original geometries in
        // the worker exclusion compiler; no tide permit can reopen its masks.
        const areas: TideGateArea[] = [],
            proofs: Array<{
                area: TideGateArea;
                context: WaterIntervalContext;
                series: (typeof source.navigationSeries)[number];
            }> = [];
        let reviews = 0,
            expiresAtMs = started + 5 * 60_000;
        {
            const d = depthCoverage.minimumPositiveM;
            if (d >= r.requiredM)
                return held('This complete original window has no positive charted bank that needs a tide shortcut.');
            const candidates = source.navigationSeries.flatMap((series) =>
                REVIEWED_SAMPLED_TIDE_AUTHORITY.ties
                    .filter(
                        (tie) =>
                            tie.use === 'sounding' &&
                            tie.chartContentKey === chartContentKey &&
                            tie.targetDatumId === datum &&
                            tie.targetDatumEpoch &&
                            tie.provider === series.provider &&
                            tie.productId === series.productId &&
                            tie.stationId === series.stationId,
                    )
                    .map((tie) => ({ series, tie })),
            );
            if (candidates.length !== 1)
                return held('A unique reviewed station-to-complete-window datum/epoch tie is missing.');
            const { series, tie } = candidates[0];
            for (const coverage of tie.coverage) {
                const center = { lat: (coverage[1] + coverage[3]) / 2, lon: (coverage[0] + coverage[2]) / 2 };
                const context: WaterIntervalContext = {
                    ...center,
                    lifetimeKey: r.lifetimeKey,
                    nowMs: started,
                    chartContentKey,
                    targetDatumId: datum,
                    targetDatumEpoch: tie.targetDatumEpoch,
                    use: 'sounding',
                    protectedChart: cells.some(isProtectedChart),
                    fromMs: 0,
                    untilMs: 0,
                };
                const area: TideGateArea = {
                    id: `bank-${areas.length}`,
                    geometry: structuredClone(depthCoverage.geometry) as Polygon | MultiPolygon,
                    coverage: [...coverage],
                    station: { lat: series.lat, lon: series.lon },
                    maxDistanceKm: tie.maxDistanceKm,
                    chartedDepthM: d,
                    windows: [],
                };
                const windows: Array<{ fromMs: number; untilMs: number; minLowM: number }> = [];
                for (let i = 1; i < series.samples.length; i++) {
                    const fromMs = Math.max(series.samples[i - 1].timeMs, r.departureMs - r.uncertaintyMs - 300000),
                        untilMs = Math.min(
                            series.samples[i].timeMs,
                            r.departureMs + 86400000 + r.uncertaintyMs + 300000,
                        );
                    if (untilMs <= fromMs) continue;
                    if (++reviews > 512 || Date.now() - started > 30000)
                        return held('Full original-interval review exceeds its 512-bracket /30-second bound.');
                    const c = { ...context, fromMs, untilMs, nowMs: Date.now() };
                    const water = await reviewWaterInterval([series], c, {
                        signal: options.signal,
                        assertCurrent: check,
                    });
                    check();
                    if (!water || !isReviewedWaterInterval(water, c) || d + water.minLowM < r.requiredM) continue;
                    expiresAtMs = Math.min(expiresAtMs, water.expiresAtMs);
                    const previous = windows[windows.length - 1];
                    if (previous?.untilMs === fromMs && untilMs - previous.fromMs <= 86400000) {
                        previous.untilMs = untilMs;
                        previous.minLowM = Math.min(previous.minLowM, water.minLowM);
                    } else windows.push({ fromMs, untilMs, minLowM: water.minLowM });
                }
                if (windows.length) {
                    if (areas.length >= 32) return held('The complete shallow-band set exceeds 32 original areas.');
                    area.windows = windows;
                    freezeOwned(area);
                    areas.push(area);
                    proofs.push({ area, context, series });
                }
            }
        }
        if (!areas.length)
            return held(
                'No full original-sample interval clears a charted bank with the reviewed uncertainty and datum transfer.',
            );
        const request = Object.freeze({
            enabled: true,
            from: r.from,
            to: r.to,
            departureMs: r.departureMs,
            speedKts: r.speedKts,
            requiredM: r.requiredM,
            expiresAtMs,
            uncertaintyMs: r.uncertaintyMs,
            maxJourneyMs: 86400000,
            areas: Object.freeze(areas),
            soundings: freezeOwned(soundings),
            sourceBounds: freezeOwned(bounds),
        });
        const permit = Object.freeze({
            request,
            layers: ownedLayers,
            bounds: freezeOwned(bounds),
            chartContentKey,
            aboardOnly: cells.some(isProtectedChart),
            sourceSummary: source.navigationSeries
                .map(
                    (s) =>
                        `${s.provider} ${s.stationName}; original issue ${s.sourceAtMs === null ? 'unknown' : new Date(s.sourceAtMs).toISOString()}`,
                )
                .join(' · '),
        });
        issued.set(permit, {
            check,
            finish: async (path) => {
                check();
                const finalStarted = Date.now();
                const finalCheck = () => {
                    check();
                    if (Date.now() < finalStarted || Date.now() - finalStarted > 30000)
                        throw new DOMException('Final tide source review exceeded 30 seconds.', 'AbortError');
                };
                if (
                    Date.now() >= expiresAtMs ||
                    !path ||
                    !Array.isArray(path.points) ||
                    !Array.isArray(path.timesMs) ||
                    !Array.isArray(path.indices) ||
                    !Array.isArray(path.tideCells) ||
                    path.tideCells.length < 1 ||
                    path.points.length !== path.timesMs.length ||
                    path.points.length !== path.indices.length ||
                    path.points.length < 2 ||
                    path.points.length > 25000 ||
                    !path.grid ||
                    Object.keys(layout).some(
                        (key) => path.grid[key as keyof typeof layout] !== layout[key as keyof typeof layout],
                    ) ||
                    new Set(path.indices).size !== path.indices.length ||
                    path.indices.some((i) => !Number.isInteger(i) || i < 0 || i >= 2500000) ||
                    path.points.some(
                        (p) =>
                            !Array.isArray(p) ||
                            p.length !== 2 ||
                            !p.every(finite) ||
                            p[0] < bounds[0] ||
                            p[0] > bounds[2] ||
                            p[1] < bounds[1] ||
                            p[1] > bounds[3],
                    ) ||
                    path.points[0][0] !== r.from.lon ||
                    path.points[0][1] !== r.from.lat ||
                    path.points.at(-1)![0] !== r.to.lon ||
                    path.points.at(-1)![1] !== r.to.lat ||
                    path.timesMs[0] !== r.departureMs
                )
                    return false;
                let footprintVertices = 0,
                    footprintComparisons = 0;
                const pv = () => {
                    if (++footprintVertices > 262144) throw Error('Final original footprint exceeds its vertex bound.');
                };
                const pc = () => {
                    if (++footprintComparisons > 500000)
                        throw Error('Final original footprint exceeds its comparison bound.');
                };
                const cells = new Map<number, { bounds: HoldingBounds; depth: number }>();
                const cell = (index: number) => {
                    finalCheck();
                    const previous = cells.get(index);
                    if (previous) return previous;
                    if (cells.size >= 4096) return null;
                    const x = index % layout.width,
                        y = Math.floor(index / layout.width);
                    if (x < 0 || y < 0 || x >= layout.width || y >= layout.height) return null;
                    const box = [
                        layout.minLon + x * layout.dLon,
                        layout.minLat + y * layout.dLat,
                        layout.minLon + (x + 1) * layout.dLon,
                        layout.minLat + (y + 1) * layout.dLat,
                    ] as const;
                    if (
                        box[0] < bounds[0] ||
                        box[1] < bounds[1] ||
                        box[2] > bounds[2] ||
                        box[3] > bounds[3] ||
                        !holdingGeometryRelation(depthCoverage.geometry, box, pv, pc).covers
                    )
                        return null;
                    const marginLat = 60 / 111320,
                        marginLon = marginLat / Math.cos((((box[1] + box[3]) / 2) * Math.PI) / 180);
                    const expanded = [
                        box[0] - marginLon,
                        box[1] - marginLat,
                        box[2] + marginLon,
                        box[3] + marginLat,
                    ] as const;
                    for (const object of hardQuery(expanded))
                        if (holdingGeometryRelation(object.geometry, expanded, pv, pc).intersects) return null;
                    let depth = depthCoverage.minimumAt(box);
                    if (depth === null || depth <= 0) return null;
                    for (const point of soundQuery([
                        box[0] - layout.dLon,
                        box[1] - layout.dLat,
                        box[2] + layout.dLon,
                        box[3] + layout.dLat,
                    ]))
                        depth = Math.min(depth, point.depthM);
                    if (depth <= 0) return null;
                    const value = { bounds: box, depth };
                    cells.set(index, value);
                    return value;
                };
                const admitted = (index: number, from: number, until: number) => {
                    const facts = cell(index);
                    if (!facts) return false;
                    if (facts.depth >= r.requiredM) return true;
                    const lo = r.departureMs + Math.floor((from - r.departureMs) / 300000) * 300000 - r.uncertaintyMs,
                        hi = r.departureMs + Math.ceil((until - r.departureMs) / 300000) * 300000 + r.uncertaintyMs;
                    const b = facts.bounds,
                        at = { lat: (b[1] + b[3]) / 2, lon: (b[0] + b[2]) / 2 },
                        radius = haversineM(b[1], b[0], b[3], b[2]);
                    return areas.some(
                        (area) =>
                            b[0] >= area.coverage[0] &&
                            b[1] >= area.coverage[1] &&
                            b[2] <= area.coverage[2] &&
                            b[3] <= area.coverage[3] &&
                            haversineM(at.lat, at.lon, area.station.lat, area.station.lon) + radius <=
                                area.maxDistanceKm * 1000 &&
                            area.windows.some(
                                (window) =>
                                    window.fromMs <= lo &&
                                    window.untilMs >= hi &&
                                    Math.min(facts.depth, area.chartedDepthM) + window.minLowM >= r.requiredM,
                            ),
                    );
                };
                let distance = 0;
                const firstIndex =
                        Math.floor((r.from.lat - layout.minLat) / layout.dLat) * layout.width +
                        Math.floor((r.from.lon - layout.minLon) / layout.dLon),
                    lastIndex =
                        Math.floor((r.to.lat - layout.minLat) / layout.dLat) * layout.width +
                        Math.floor((r.to.lon - layout.minLon) / layout.dLon);
                if (path.indices[0] !== firstIndex || path.indices.at(-1) !== lastIndex) return false;
                for (let i = 0; i < path.indices.length; i++) {
                    const idx = path.indices[i],
                        point = path.points[i],
                        expected =
                            idx === firstIndex
                                ? [r.from.lon, r.from.lat]
                                : idx === lastIndex
                                  ? [r.to.lon, r.to.lat]
                                  : [
                                        layout.minLon + ((idx % layout.width) + 0.5) * layout.dLon,
                                        layout.minLat + (Math.floor(idx / layout.width) + 0.5) * layout.dLat,
                                    ];
                    if (point[0] !== expected[0] || point[1] !== expected[1]) return false;
                }
                for (let i = 1; i < path.points.length; i++) {
                    const a = path.points[i - 1],
                        b = path.points[i],
                        length = haversineM(a[1], a[0], b[1], b[0]);
                    distance += length;
                    const aIndex = path.indices[i - 1],
                        bIndex = path.indices[i],
                        ax = aIndex % layout.width,
                        ay = Math.floor(aIndex / layout.width),
                        bx = bIndex % layout.width,
                        by = Math.floor(bIndex / layout.width);
                    if (
                        Math.abs(ax - bx) > 1 ||
                        Math.abs(ay - by) > 1 ||
                        !admitted(aIndex, path.timesMs[i - 1], path.timesMs[i]) ||
                        !admitted(bIndex, path.timesMs[i - 1], path.timesMs[i]) ||
                        (ax !== bx &&
                            ay !== by &&
                            (!admitted(ay * layout.width + bx, path.timesMs[i - 1], path.timesMs[i]) ||
                                !admitted(by * layout.width + ax, path.timesMs[i - 1], path.timesMs[i])))
                    )
                        return false;
                    if (
                        length <= 0 ||
                        path.timesMs[i] !== path.timesMs[i - 1] + (length / ((r.speedKts * 1852) / 3600)) * 1000
                    )
                        return false;
                }
                if (path.distanceM !== distance || path.timesMs.at(-1)! - r.departureMs > 86400000) return false;
                const snapshot = JSON.stringify([
                    path.points,
                    path.timesMs,
                    path.indices,
                    path.distanceM,
                    path.tideCells,
                    path.grid,
                ]);
                // Final exact candidate must remain within the issued original
                // windows; the grid verifier separately rechecks all touched cells.
                for (const proof of proofs)
                    for (const window of proof.area.windows) {
                        const c = {
                            ...proof.context,
                            fromMs: window.fromMs,
                            untilMs: window.untilMs,
                            nowMs: Date.now(),
                        };
                        const water = await reviewWaterInterval([proof.series], c, {
                            signal: options.signal,
                            assertCurrent: finalCheck,
                        });
                        finalCheck();
                        if (!water || !isReviewedWaterInterval(water, c) || water.minLowM < window.minLowM)
                            return false;
                    }
                finalCheck();
                return (
                    Date.now() < expiresAtMs &&
                    snapshot ===
                        JSON.stringify([
                            path.points,
                            path.timesMs,
                            path.indices,
                            path.distanceM,
                            path.tideCells,
                            path.grid,
                        ])
                );
            },
        });
        check();
        return { kind: 'ready', permit, release };
    } catch (error) {
        release();
        options.signal.throwIfAborted();
        options.assertCurrent();
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        return {
            kind: 'held',
            reason: error instanceof Error ? error.message : 'The complete original tide source window is unavailable.',
            release,
        };
    }
}

export function checkTideGatedSourcePermit(permit: TideGatedSourcePermit): boolean {
    const record = issued.get(permit);
    if (!record) return false;
    record.check();
    return true;
}
export async function recheckTideGatedSourcePermit(
    permit: TideGatedSourcePermit,
    path: TideGridPath,
): Promise<boolean> {
    const record = issued.get(permit);
    return record ? record.finish(path) : false;
}
