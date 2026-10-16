/** Main-thread source admission. No provider activation, WAN, chart writes or
 * serialized authority. Geometry and its real cohort lease live for one run. */
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import type { EncCell, EncConversionResult } from '../enc/types';
import type { InshoreLayers } from '../engine/types';
import type { TideGateArea, TideGatedCandidateRequest, TideGridPath } from '../engine/tideGatedSearch';
import { cellsForBBox, getVersion } from '../enc/EncCellMetadata';
import { loadCellGeoJSON } from '../enc/EncCellStore';
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
import { haversineM } from '../engine/geometry';

const classes = [
    'DEPARE',
    'LNDARE',
    'OBSTRN',
    'WRECKS',
    'UWTROC',
    'SOUNDG',
    'M_QUAL',
    'M_SDAT',
    'RESARE',
    'TSEZNE',
    'BRIDGE',
    'CBLOHD',
    'PIPOHD',
    'CONVYR',
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

export function tideGatedBounds(
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
): HoldingBounds | null {
    if (
        ![from.lat, from.lon, to.lat, to.lon].every(finite) ||
        Math.max(Math.abs(from.lat), Math.abs(to.lat)) > 80 ||
        Math.max(Math.abs(from.lon), Math.abs(to.lon)) > 180 ||
        Math.abs(from.lon - to.lon) > 180
    )
        return null;
    const pad = Math.max(Math.max(Math.abs(from.lat - to.lat), Math.abs(from.lon - to.lon)) * 0.5, 0.08);
    const b = [
        Math.min(from.lon, to.lon) - pad,
        Math.min(from.lat, to.lat) - pad,
        Math.max(from.lon, to.lon) + pad,
        Math.max(from.lat, to.lat) + pad,
    ] as const;
    return b[0] >= -180 && b[2] <= 180 && b[1] >= -85 && b[3] <= 85 ? b : null;
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
            prior !== trackPriorContextKey()
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
                if (!Number.isSafeInteger(cell.sizeBytes) || cell.sizeBytes! <= 0)
                    return held('A Pi chart byte bound is unknown.');
                bytes += cell.sizeBytes!;
            }
            if (bytes > 16 * 1024 * 1024)
                return held('The complete tide chart window exceeds the existing 16 MiB view bound.');
            const blob = cell.noaaPackage ? cohort.blobs.get(cell.id) : await loadCellGeoJSON(cell.id, false);
            check();
            if (
                !blob ||
                blob.cellId !== cell.id ||
                blob.sourceHO !== cell.sourceHO ||
                blob.edition !== cell.edition ||
                blob.updateNumber !== cell.updateNumber ||
                blob.issued !== cell.issued ||
                !cellSoundingDatum(blob)
            )
                return held('An original chart revision or explicit whole-cell sounding datum is unknown.');
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
        // No sounding-datum tide may open an overhead structure. Its original
        // footprint becomes a hard obstacle for this optional route instead.
        for (const { blob } of blobs)
            for (const cls of ['BRIDGE', 'CBLOHD', 'PIPOHD', 'CONVYR'] as const)
                for (const feature of blob.layers[cls]!.features)
                    layers.OBSTRN!.features.push({ ...feature, properties: { _class: 'tide-overhead-exclusion' } });
        for (const cls of ['RESARE', 'TSEZNE'] as const)
            (layers as Record<string, unknown>)[cls] = {
                type: 'FeatureCollection',
                features: blobs.flatMap(({ blob }) => blob.layers[cls]!.features),
            };
        const ownedLayers = freezeOwned(structuredClone(layers));
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
        for (const { blob } of blobs)
            for (const feature of blob.layers.DEPARE!.features) {
                if (!holdingGeometryRelation(feature.geometry, bounds, vertex, compare).intersects) continue;
                const d = feature.properties?.DRVAL1 ?? feature.properties?.drval1;
                if (!finite(d)) return held('An intersecting original depth band has no numeric minimum.');
                if (d <= 0 || d >= r.requiredM) continue;
                if (feature.geometry?.type !== 'Polygon' && feature.geometry?.type !== 'MultiPolygon')
                    return held('A shallow depth band lacks original area geometry.');
                if (areas.length >= 32) return held('The complete shallow-band set exceeds 32 original areas.');
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
                        geometry: structuredClone(feature.geometry) as Polygon | MultiPolygon,
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
        });
        const permit = Object.freeze({
            request,
            layers: ownedLayers,
            bounds: freezeOwned(bounds),
            chartContentKey,
            aboardOnly: cells.some(isProtectedChart),
        });
        issued.set(permit, {
            check,
            finish: async (path) => {
                check();
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
                let distance = 0;
                for (let i = 1; i < path.points.length; i++) {
                    const a = path.points[i - 1],
                        b = path.points[i],
                        length = haversineM(a[1], a[0], b[1], b[0]);
                    distance += length;
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
                            assertCurrent: check,
                        });
                        check();
                        if (!water || !isReviewedWaterInterval(water, c) || water.minLowM < window.minLowM)
                            return false;
                    }
                check();
                return (
                    Date.now() < expiresAtMs &&
                    snapshot ===
                        JSON.stringify([path.points, path.timesMs, path.indices, path.distanceM, path.tideCells])
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
