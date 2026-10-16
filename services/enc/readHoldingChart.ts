/** Leased, installed charts only. No raw licensed geometry escapes this read. */
import { cellsForBBox, getVersion } from './EncCellMetadata';
import { loadCellGeoJSON } from './EncCellStore';
import { loadNoaaPackageCohort } from './noaaPackageWindow';
import { MAX_MERGE_CELLS } from './mergeCap';
import { encCellContentIdentity } from './cellContentIdentity';
import { cellSoundingDatum } from './chartDatum';
import { isProtectedChart } from './chartLicence';
import { chartBottomNature } from './seabed';
import { holdingFootprint, holdingGeometryRelation, type HoldingBounds } from './holdingFootprint';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import type { EncConversionResult } from './types';

export const HOLDING_REQUIRED_CLASSES = [
    'DEPARE',
    'DRGARE',
    'SBDARE',
    'WEDKLP',
    'LNDARE',
    'COALNE',
    'OBSTRN',
    'WRECKS',
    'UWTROC',
    'SOUNDG',
    'SLCONS',
    'DAMCON',
    'PILPNT',
    'BRIDGE',
    'PONTON',
    'CBLOHD',
    'PIPOHD',
    'CONVYR',
    'RESARE',
    'CBLARE',
    'PIPARE',
    'TSSLPT',
    'CTNARE',
    'TSEZNE',
    'TSELNE',
    'TSSBND',
    'PRCARE',
    'DWRTPT',
    'ACHARE',
    'MARCUL',
    'M_QUAL',
    'M_SDAT',
] as const satisfies readonly (keyof EncConversionResult['layers'])[];
export interface HoldingChartRead {
    bounds: HoldingBounds | null;
    chartContentKey: string;
    aboardOnly: boolean;
    completeCircleAndApproach: boolean;
    minimumChartedDepthM: number | null;
    datumId: string;
    datumEpoch: string;
    hazards: 'clear' | 'blocked' | 'unknown';
    permission: 'allowed' | 'prohibited' | 'unknown';
    bottom: 'charted' | 'poor' | 'unknown';
    bottomIsPointSample: false;
    notes: string[];
}
export async function readHoldingChart(
    at: { lat: number; lon: number },
    incoming: { lat: number; lon: number } | null,
    radiusM: number,
    options: { signal: AbortSignal; assertCurrent: () => void },
): Promise<HoldingChartRead> {
    const bounds = holdingFootprint(at, incoming, radiusM),
        version = getVersion(),
        scope = getAuthIdentityScope();
    const result: HoldingChartRead = {
        bounds,
        chartContentKey: '',
        aboardOnly: true,
        completeCircleAndApproach: false,
        minimumChartedDepthM: null,
        datumId: '',
        datumEpoch: '',
        hazards: 'unknown',
        permission: 'unknown',
        bottom: 'unknown',
        bottomIsPointSample: false,
        notes: [],
    };
    const notes = new Set<string>();
    const check = () => {
        options.signal.throwIfAborted();
        options.assertCurrent();
        if (getVersion() !== version || !isAuthIdentityScopeCurrent(scope))
            throw new DOMException('Holding chart cohort changed.', 'AbortError');
    };
    check();
    if (!bounds)
        return {
            ...result,
            notes: [
                'A complete incoming leg of at most 10 km, away from polar/dateline boundaries, is required for this bounded holding-area read.',
            ],
        };
    const cells = cellsForBBox([...bounds]);
    if (!cells.length || cells.length > MAX_MERGE_CELLS)
        return {
            ...result,
            notes: ['The complete installed holding cohort is absent or exceeds the existing 14-cell limit.'],
        };
    const cohort = await loadNoaaPackageCohort(
        cells.filter((c) => c.noaaPackage),
        [...bounds],
        check,
    );
    let complete = true,
        depthCover = false,
        bottomCover = false,
        qualityCover = false,
        poor = false,
        blocked = false,
        unknownDepth = false,
        prohibited = false,
        objects = 0,
        vertices = 0,
        unknownDatum = false;
    let comparisons = 0;
    const compare = () => {
        if (++comparisons > 500000) throw Error('Holding cohort exceeds 500,000 boundary comparisons.');
        if (comparisons % 256 === 0) check();
    };
    const depths: number[] = [],
        datums = new Set<string>(),
        keys: string[] = [];
    const missing = new Set<string>();
    const vertex = () => {
        if (++vertices > 65536) throw Error('Holding chart review exceeds 65,536 vertices.');
        if (vertices % 256 === 0) check();
    };
    try {
        result.aboardOnly = false;
        for (const cell of cells) {
            check();
            result.aboardOnly ||= isProtectedChart(cell);
            const blob = cell.noaaPackage ? cohort.blobs.get(cell.id) : await loadCellGeoJSON(cell.id, false);
            check();
            if (
                !blob ||
                blob.cellId !== cell.id ||
                blob.edition !== cell.edition ||
                blob.sourceHO !== cell.sourceHO ||
                blob.updateNumber !== cell.updateNumber
            ) {
                complete = false;
                notes.add('A required chart revision could not be read; the whole cohort remains incomplete.');
                continue;
            }
            keys.push(encCellContentIdentity(cell));
            const datum = cellSoundingDatum(blob);
            if (datum) datums.add(datum);
            else {
                complete = false;
                unknownDatum = true;
            }
            for (const cls of HOLDING_REQUIRED_CLASSES) {
                const layer = blob.layers[cls];
                if (!layer || layer.type !== 'FeatureCollection' || !Array.isArray(layer.features)) {
                    complete = false;
                    missing.add(cls);
                    continue;
                }
                if ((objects += layer.features.length) > 16000)
                    throw Error('Holding chart review exceeds 16,000 objects.');
                for (const f of layer.features) {
                    check();
                    if (!f?.geometry || !f.properties) {
                        complete = false;
                        continue;
                    }
                    if (
                        ['DEPARE', 'DRGARE', 'M_QUAL', 'M_SDAT'].includes(cls) &&
                        f.geometry.type !== 'Polygon' &&
                        f.geometry.type !== 'MultiPolygon'
                    ) {
                        complete = false;
                        if (cls === 'DEPARE' || cls === 'DRGARE') unknownDepth = true;
                        notes.add(`The ${cls} class has non-area geometry; full coverage is unverified.`);
                        continue;
                    }
                    const relation = holdingGeometryRelation(f.geometry, bounds, vertex, compare),
                        p = f.properties;
                    if (!relation.intersects) continue;
                    const restrictions = String(p.RESTRN ?? p.restrn ?? '')
                        .split(/[,/]/)
                        .map((s) => s.trim());
                    if (restrictions.includes('7')) {
                        prohibited = true;
                        notes.add(`Original ${cls} RESTRN prohibits anchoring in the envelope.`);
                    }
                    const depth = p.DRVAL1 ?? p.drval1;
                    if (cls === 'DEPARE' || cls === 'DRGARE') {
                        if (typeof depth === 'number' && Number.isFinite(depth)) {
                            depths.push(depth);
                            depthCover ||= relation.covers;
                        } else unknownDepth = true;
                    } else if (cls === 'SBDARE' || cls === 'WEDKLP') {
                        const nature = chartBottomNature({ ...p, _caution: cls });
                        if (nature.poor) poor = true;
                        if (nature.unknown) {
                            complete = false;
                            notes.add('An intersecting bottom area has unknown original NATSUR/CATWED.');
                        } else if (!nature.poor) bottomCover ||= relation.covers;
                        if (f.geometry.type === 'Point' || f.geometry.type === 'MultiPoint')
                            notes.add('Bottom point observations were read but cannot establish whole-area holding.');
                    } else if (cls === 'M_QUAL') {
                        const q = Number(p.CATZOC ?? p.catzoc);
                        if (![1, 2, 3].includes(q)) {
                            complete = false;
                            notes.add('Survey confidence is unknown or CATZOC C/D/U in the footprint.');
                        } else qualityCover ||= relation.covers;
                    } else if (cls === 'M_SDAT') {
                        // Whole-cell datum contract was checked above; no epoch is inferred.
                    } else if (cls === 'ACHARE') {
                        notes.add('A charted anchorage is a designation, not verified current anchoring permission.');
                    } else if (
                        [
                            'RESARE',
                            'CBLARE',
                            'PIPARE',
                            'TSSLPT',
                            'CTNARE',
                            'TSEZNE',
                            'TSELNE',
                            'TSSBND',
                            'PRCARE',
                            'DWRTPT',
                            'MARCUL',
                        ].includes(cls)
                    ) {
                        complete = false;
                        if (cls === 'MARCUL') blocked = true;
                        notes.add(
                            `The footprint intersects ${cls}; current restrictions/permission require verification.`,
                        );
                    } else {
                        // All intersecting physical objects, soundings, land, coastline and
                        // overhead structures are conservative holds; never assign tide credit.
                        blocked = true;
                        notes.add(`The footprint intersects ${cls}; physical/underwater/overhead clearance is held.`);
                    }
                }
            }
        }
        check();
    } catch (error) {
        check(); // Never convert retirement/cancellation into a usable partial read.
        complete = false;
        notes.add(error instanceof Error ? error.message : 'Holding chart read failed.');
    } finally {
        cohort.release();
    }
    check();
    if (missing.size)
        notes.add(`Missing extracted classes: ${[...missing].sort().join(', ')}. Missing is not empty/clear.`);
    if (!depthCover)
        notes.add('No single original depth polygon contains the entire conservative circle/approach envelope.');
    if (!bottomCover)
        notes.add(
            'No suitable original SBDARE polygon contains the entire envelope; point samples and polygon unions are not promoted.',
        );
    if (!qualityCover) notes.add('Complete acceptable M_QUAL survey coverage is unproved.');
    notes.add('Current anchoring permission and chart datum epoch/station tie are unverified.');
    notes.add(
        'The envelope includes the whole incoming leg and holding circle; conservative over-coverage may hold a usable site.',
    );
    return {
        ...result,
        chartContentKey: keys.sort().join('|'),
        completeCircleAndApproach: complete && depthCover && bottomCover && qualityCover,
        minimumChartedDepthM: !unknownDepth && depthCover && depths.length ? Math.min(...depths) : null,
        datumId: !unknownDatum && datums.size === 1 ? [...datums][0] : '',
        hazards: blocked ? 'blocked' : complete ? 'clear' : 'unknown',
        permission: prohibited ? 'prohibited' : 'unknown',
        bottom: poor ? 'poor' : bottomCover ? 'charted' : 'unknown',
        notes: [...notes],
    };
}
