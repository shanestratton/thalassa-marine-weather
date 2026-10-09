/**
 * anchorAreaCheck: is the anchor inside a charted area where anchoring is a
 * problem? (build 126, 126-07d)
 *
 * Said, never enforced. The page runs it only after the watch is armed, and
 * the Move anchor sheet runs it on the point it would move to; neither waits
 * for it, and nothing it finds stops, delays or undoes anything (Cast Off and
 * anchor rules are advisory). It never throws: a source that fails or takes
 * longer than ANCHOR_AREA_CHECK_MS gives nothing, with a log.warn reason, and
 * the other source's answer still counts. No position ever goes in a log.
 *
 * Sources, global first:
 *  1. The official chart cells on the phone (the 125-04 caution layer:
 *     RESARE, CBLARE, PIPARE, TSSLPT, services/enc/encHazardParse.ts
 *     buildCautionAreas), queried as a one-point segment through
 *     HazardQueryService.querySegmentCautions. Worldwide, and aboard with no
 *     signal. A RESARE warns only for the RESTRN codes that matter to an
 *     anchored boat (below); one for fishing or diving alone does not.
 *  2. National extras: the GBRMPA no-anchoring polygons (CC BY, credited on
 *     every line) from the anchorage atlas, offline once seen. More (other
 *     parks, OSM seamark:restricted_area) plug in beside it.
 *
 * Every line names its source ("official chart", or "GBRMPA, <legal>, CC BY")
 * and never claims an area is absent. `charts` says what the official chart
 * could say here, and only the chart counts: a national atlas never looks for
 * cables or pipelines, so with no chart cell a caller says "No chart areas
 * loaded here" rather than leave a silence that reads as clear. A chart that
 * covers the point but did not answer in time, or could not be read, is
 * 'unchecked', never "no charts" (126-07d review).
 *
 * The first ask in a new place builds the index of every chart cell there (a
 * file read and a parse each), which can outlast the deadline. It keeps going
 * and caches them, and the next ask waits for it instead of building them all
 * again beside it, so asking again soon answers.
 *
 * Loaded with a dynamic import, so none of it is in the eager bundle.
 */
import { AnchorageService } from './anchorages/AnchorageService';
import { querySegmentCautions } from './HazardQueryService';
import { cellsForBBox } from './enc/EncCellMetadata';
import { failedCellIds } from './enc/encIndexCache';
import type { EncCautionArea } from './enc/EncSpatialIndex';
import { restrnCodes, restrnMeaning } from './enc/s57Restrn';
import { pointInGeometry } from './engine/geometry';
import { DeadlineExceeded, withDeadline } from '../utils/deadline';
import { createLogger } from '../utils/createLogger';

const log = createLogger('AnchorAreaCheck');

/** Each source gets this long by default; both run at once, so the whole check does too. */
export const ANCHOR_AREA_CHECK_MS = 3_000;
/**
 * After the watch is armed nothing waits on the answer, so the page gives the
 * first ask in a new place (every chart cell's index to build) this long.
 */
export const ANCHOR_AREA_AFTER_ARM_MS = 15_000;
/** The atlas tiles read around the anchor (NM): the tile it is in, and a neighbour across an edge. */
const ATLAS_RADIUS_NM = 2;

export type AnchorAreaKind = 'entry' | 'anchoring' | 'cable' | 'pipeline' | 'tss' | 'avoid';

export interface AnchorAreaWarning {
    kind: AnchorAreaKind;
    /** The area's own name (OBJNAM, or the atlas name), when it has one. */
    name?: string;
    source: 'ENC' | 'GBRMPA';
    /** The atlas's legal reference (a plan of management clause). */
    legal?: string;
    /** What the point is inside: "a submarine cable area", "Bait Reef no-anchoring area". */
    area: string;
    /** Where that comes from: "official chart", or "GBRMPA, <legal>, CC BY". */
    credit: string;
    /** The whole sentence, for the note under the radar. */
    words: string;
    /**
     * The short form for the Move anchor sheet's one line: what kind of area,
     * and the source with its credit, no name or clause ("a pipeline area
     * (official chart)", "a no-anchoring area (GBRMPA, CC BY)"). Bounded, so
     * the sheet fits a small phone whatever the chart calls the area.
     */
    brief: string;
}

/**
 * What the official chart could say about the point:
 *  - 'checked': chart cells cover it, and every one of them answered;
 *  - 'none': no chart cell covers it, so nothing there was looked at;
 *  - 'unchecked': cells cover it, but did not answer in time or one could not
 *    be read. Ask again, or say the chart could not be checked; never "none".
 */
export type ChartAnswer = 'checked' | 'none' | 'unchecked';

export interface AnchorAreaCheck {
    /** The most serious first, one per area. Empty says nothing, never "clear". */
    warnings: AnchorAreaWarning[];
    /** What the official chart could say here. A national atlas never counts. */
    charts: ChartAnswer;
}

/** Entry > anchoring > cable/pipeline > traffic lane > restricted-other (an area to be avoided). */
const RANK: Readonly<Record<AnchorAreaKind, number>> = {
    entry: 0,
    anchoring: 1,
    cable: 2,
    pipeline: 2,
    tss: 3,
    avoid: 4,
};

/**
 * The S-57 RESTRN codes that are an anchored boat's business, and the kind
 * each makes. Entry prohibited or restricted is worse than anchoring;
 * dragging and stopping prohibited go with anchoring (a boat at anchor is
 * stopped, and her anchor can drag).
 */
const RESTRN_KIND: Readonly<Record<string, AnchorAreaKind>> = {
    '7': 'entry',
    '8': 'entry',
    '1': 'anchoring',
    '2': 'anchoring',
    '24': 'anchoring',
    '25': 'anchoring',
    '14': 'avoid',
};

/** What each charted class is, and what to say about anchoring in it. */
const CHART_CLASS: Readonly<Record<string, { kind: AnchorAreaKind; what: string; advice?: string }>> = {
    RESARE: { kind: 'avoid', what: 'a restricted area' },
    CBLARE: {
        kind: 'cable',
        what: 'a submarine cable area',
        advice: 'Anchoring here can damage the cable and your anchor.',
    },
    PIPARE: {
        kind: 'pipeline',
        what: 'a pipeline area',
        advice: 'Anchoring here can damage the pipeline and your anchor.',
    },
    TSSLPT: {
        kind: 'tss',
        what: 'a traffic lane',
        advice: 'Avoid anchoring in a traffic separation scheme (COLREG Rule 10(g)).',
    },
};

interface Ranked {
    warning: AnchorAreaWarning;
    rank: number;
}

function warning(
    kind: AnchorAreaKind,
    source: AnchorAreaWarning['source'],
    area: string,
    credit: string,
    advice: string | undefined,
    extra: Pick<AnchorAreaWarning, 'name' | 'legal' | 'brief'>,
): AnchorAreaWarning {
    return {
        kind,
        ...extra,
        source,
        area,
        credit,
        words: `Inside ${area} (${credit}).${advice ? ` ${advice}` : ''}`,
    };
}

/** One charted caution area, in the IHO's words, or null when it is no anchored boat's business. */
function chartWarning(found: EncCautionArea): Ranked | null {
    const charted = CHART_CLASS[found.cls];
    if (!charted) return null;
    const codes = [...new Set(restrnCodes(found.restrn).filter((code) => code in RESTRN_KIND))];
    if (found.cls === 'RESARE' && codes.length === 0) return null;
    const byCode = codes.map((code) => RESTRN_KIND[code]).sort((a, b) => RANK[a] - RANK[b]);
    // A restricted area is what its codes make it; a cable, pipeline or lane
    // stays one, ranked up when its codes are worse (anchoring prohibited).
    const kind = found.cls === 'RESARE' ? byCode[0] : charted.kind;
    const rank = Math.min(RANK[kind], ...byCode.map((k) => RANK[k]));
    const name = found.name?.trim() || undefined;
    const meanings = codes.map(restrnMeaning).join(', ');
    const area = `${name ? `${name}, ` : ''}${charted.what}${meanings ? `: ${meanings}` : ''}`;
    // The sheet's line: the kind and only the most serious code.
    const worst = [...codes].sort((a, b) => RANK[RESTRN_KIND[a]] - RANK[RESTRN_KIND[b]])[0];
    const brief = `${charted.what}${worst ? `: ${restrnMeaning(worst)}` : ''} (official chart)`;
    return {
        warning: warning(kind, 'ENC', area, 'official chart', charted.advice, { ...(name ? { name } : {}), brief }),
        rank,
    };
}

/**
 * The chart query still running, if any: an ask that outlived its deadline is
 * still building and caching the cells' indexes, and the next one waits for it
 * (within its own deadline) rather than build them again beside it.
 */
let chartQuery: Promise<void> | null = null;

async function fromCharts(lat: number, lon: number): Promise<Ranked[]> {
    if (chartQuery) await chartQuery;
    const query = querySegmentCautions([{ lat1: lat, lon1: lon, lat2: lat, lon2: lon }]);
    const running: Promise<void> = query.then(
        () => undefined,
        () => undefined,
    );
    chartQuery = running;
    void running.then(() => {
        if (chartQuery === running) chartQuery = null;
    });
    const [areas] = await query;
    return (areas ?? []).map(chartWarning).filter((r): r is Ranked => r !== null);
}

/** Inside, with the longitude tried a turn either way too, for a polygon written past 180°. */
function inside(lon: number, lat: number, geometry: GeoJSON.Geometry | null | undefined): boolean {
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return false;
    return [lon, lon + 360, lon - 360].some((x) => pointInGeometry(x, lat, geometry));
}

async function fromAtlas(lat: number, lon: number): Promise<Ranked[]> {
    const atlas = await AnchorageService.loadNear(lat, lon, ATLAS_RADIUS_NM);
    const found: Ranked[] = [];
    for (const feature of atlas.noAnchor.features) {
        if (!inside(lon, lat, feature.geometry)) continue;
        const props = (feature.properties ?? {}) as { name?: unknown; legal?: unknown };
        const name = typeof props.name === 'string' && props.name.trim() ? props.name.trim() : undefined;
        const legal = typeof props.legal === 'string' && props.legal.trim() ? props.legal.trim() : undefined;
        const area = name ? `${name} no-anchoring area` : 'a no-anchoring area';
        const credit = ['GBRMPA', legal, 'CC BY'].filter(Boolean).join(', ');
        found.push({
            warning: warning('anchoring', 'GBRMPA', area, credit, undefined, {
                ...(name ? { name } : {}),
                ...(legal ? { legal } : {}),
                brief: 'a no-anchoring area (GBRMPA, CC BY)',
            }),
            rank: RANK.anchoring,
        });
    }
    return found;
}

/** One source, bounded; a failure or a timeout is a log line and no answer. */
async function bounded(source: string, ask: () => Promise<Ranked[]>, waitMs: number): Promise<Ranked[] | null> {
    try {
        return await withDeadline(ask(), waitMs, source);
    } catch (error) {
        const why =
            error instanceof DeadlineExceeded
                ? `no answer in ${waitMs / 1000} s`
                : error instanceof Error
                  ? error.message
                  : 'it failed';
        log.warn(`Anchor area check: the ${source} gave nothing (${why}).`);
        return null;
    }
}

/**
 * The areas at the anchor (or the point a move would put it at), the most
 * serious first, at most one per area, and what the chart could say there.
 * Each source gets `waitMs`. Never throws.
 */
export async function checkAnchorAreas(
    lat: number,
    lon: number,
    waitMs = ANCHOR_AREA_CHECK_MS,
): Promise<AnchorAreaCheck> {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { warnings: [], charts: 'none' };
    // Which chart cells cover the point is known at once, from their records
    // (nothing is read), so a slow chart is never mistaken for no chart.
    let covering: string[] = [];
    try {
        covering = cellsForBBox([lon, lat, lon, lat]).map((cell) => cell.id);
    } catch (error) {
        log.warn(
            `Anchor area check: the chart records could not be read (${error instanceof Error ? error.message : 'unknown'}).`,
        );
    }
    const [charts, atlas] = await Promise.all([
        covering.length ? bounded('chart cells', () => fromCharts(lat, lon), waitMs) : [],
        bounded('anchorage atlas', () => fromAtlas(lat, lon), waitMs),
    ]);
    // A cell that could not be read was left out of the answer: it is incomplete.
    const unread = new Set(failedCellIds());
    const chartsSaid: ChartAnswer = !covering.length
        ? 'none'
        : charts && !covering.some((id) => unread.has(id))
          ? 'checked'
          : 'unchecked';
    // Stable: the chart's line before the atlas's at the same rank.
    const ranked = [...(charts ?? []), ...(atlas ?? [])].sort((a, b) => a.rank - b.rank);
    const said = new Set<string>();
    const warnings: AnchorAreaWarning[] = [];
    for (const { warning: w } of ranked) {
        // One line per area of a kind: the chart's and the atlas's same reef
        // are one, but a cable and a lane that share a name are two.
        const key = `${w.kind}|${(w.name ?? w.area).toLowerCase()}`;
        if (said.has(key)) continue;
        said.add(key);
        warnings.push(w);
    }
    return { warnings, charts: chartsSaid };
}
