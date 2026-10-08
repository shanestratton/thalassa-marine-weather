/**
 * routingPolar — the ONE polar every router sails by, and why.
 *
 * Until build 123 every router took `SmartPolarStore.exportToPolarData() ??
 * DEFAULT_CRUISING_POLAR` (gap register must-do #2). The skipper's chosen
 * polar (settings.polarData) was read by no router at all, and the learned
 * grid — zeros in every cell never sailed — reached a router only after the
 * Polars page had been opened. This resolves it once, in order:
 *
 *   1. not a sailing vessel → the generic polar, exactly as before (motor and
 *      observer routing do not change);
 *   2. "Routing uses: Smart", with at least 8 of the 42 learned cells filled
 *      from buckets of 10+ samples (SmartPolarStore.ROUTING_MIN_BUCKET_SAMPLES)
 *      → the learned cells, each held to 0.5–1.5× the factory polar (3 or 4),
 *      and the factory polar in every empty cell and outside the learned
 *      6–25 kn range;
 *   3. settings.polarData, if it passes the checks below —
 *        imported or typed in: raw, the skipper's own numbers;
 *        yacht database: the SHAPE, scaled to her cruising speed with
 *        passagePlan.polarScale — the Passage HUD's rule, and its speed
 *        (vesselCruisingSpeedKts: a stored 0 means "auto", sqrt(LOA) × 1.2);
 *        the generated tables run ~45% slow, raw they would cripple every ETA;
 *   4. otherwise the generic cruising polar — its SHAPE scaled to her
 *      cruising speed exactly as a database shape is (build 125, 125-08: it
 *      was sailed raw, ~5.9 kn on a fair reach whatever the boat, while the
 *      HUD scaled it, so a 40-footer's two ETAs were 22% apart), and labelled
 *      as a refusal when she chose a polar it could not use, so the banner
 *      never hides that. Still source 'default', so the route-weather edge
 *      keeps its own cruise-scaled fallback.
 *
 * THE NO-GO ZONE LIVES HERE. createPolarSpeedLookup clamps any angle below a
 * table's first row to that row (tests/isochrone-polar pins it), so every
 * raw polar was credited its first row's speed dead into the wind: the
 * generic polar "sailed" 10° off an 18 kn breeze at 4.4 kn. Every sailing
 * polar handed to a router gets zero-speed rows at 0° and at five degrees
 * inside its first priced angle, so she tacks.
 *
 * `label` is what the PassageBanner prints; `reason` is why (logged);
 * `signature` keys the isochrone precompute cache, so a polar changed inside
 * its five minutes never serves the old route.
 *
 * NOT ONLY THE ROUTERS (build 125, 125-08). The Passage HUD and Plan Your Day
 * sail this same polar (hooks/useRoutingPolar → routingSpeedModel): every
 * figure is the routers' own. And a Smart polar says how far it has got —
 * "Learning (7 of 42 cells), sailing on …" — rather than wearing the factory
 * polar's name as if it were the one she chose; with the learner switched off
 * in Preferences (smartPolarsEnabled, a separate switch from "Routing uses:
 * Smart") it says "learning off", never "Learning".
 */
import type { PolarData } from '../types/navigation';
import type { PassageSpeedModel } from './passagePlan';
import type { UserSettings } from '../types/settings';
import type { VesselProfile } from '../types/vessel';
import { DEFAULT_CRUISING_POLAR } from './defaultPolar';
import { createPolarSpeedLookup } from './isochrone/polar';
import { polarScale } from './passagePlan';
import { ROUTING_MIN_BUCKET_SAMPLES, SmartPolarStore } from './SmartPolarStore';
import { vesselCruisingSpeedKts } from './units';
import { useSettingsStore } from '../stores/settingsStore';
import { resolveEffectiveVessel } from '../utils/defaultVessel';
import { createLogger } from '../utils/createLogger';

const log = createLogger('RoutingPolar');

export type RoutingPolarSource = 'learned' | 'imported' | 'manual' | 'database-scaled' | 'default';

export interface ResolvedRoutingPolar {
    polar: PolarData;
    source: RoutingPolarSource;
    /** Plain words for the banner: "Beneteau Oceanis 38.1 (shape scaled to 6.5 kn)". */
    label: string;
    reason: string;
    /** Short hash of source + figures; keys the precompute cache. */
    signature: string;
    /**
     * Learned cells (of LEARNED_CELLS) when routing is set to Smart on a
     * sailing boat — used or not yet; absent for a factory choice.
     */
    learnedCells?: number;
    /** With learnedCells: whether the learner is switched on (settings.smartPolarsEnabled). */
    learning?: boolean;
}

export type RoutingPolarSettings = Partial<
    Pick<
        UserSettings,
        'polarData' | 'polarBoatModel' | 'polarSource_type' | 'polarSource' | 'smartPolarsEnabled' | 'vessel'
    >
>;

/** What SmartPolarStore holds: its 42-cell export, and how many cells are learned. */
export interface LearnedPolarSnapshot {
    polar: PolarData | null;
    filledCells: number;
}

/** Below this many of the 42 learned cells, the learned polar is not used at all. */
export const LEARNED_MIN_FILLED_CELLS = 8;
/** The learned grid's cells: SmartPolarStore exports 7 wind speeds × 6 angles. */
export const LEARNED_CELLS = 42;
/** The no-go ramp: zero speed this many degrees inside the first priced angle. */
const NO_GO_RAMP_DEG = 5;
/** Columns under this are dropped: the edge refuses them, and the router motors there. */
const MIN_TWS_KTS = 0.1;
const MAX_POLAR_KTS = 40;
/** Inside this angle a sailing polar's figures are its no-go zone (zeroed, or refused if real). */
const MIN_PRICED_TWA = 20;
/** Inside MIN_PRICED_TWA, figures up to this share of the column's best are VPP ripple, not speed. */
const NO_GO_RIPPLE_SHARE = 0.25;
/** A learned cell is held to this band around the factory polar's figure. */
const LEARNED_BAND = [0.5, 1.5] as const;
/** At 50° and wider, a real polar has figures: at most this share may be zero. */
const MAX_ZERO_SHARE_OFF_WIND = 0.1;
/** The edge contract's TWS ceiling; the edge polar is padded out to it. */
const EDGE_MAX_TWS_KTS = 150;
/** The edge contract's limit on rows and on columns (route-weather-safety validatePolarData). */
const EDGE_MAX_AXIS = 30;
/** The edge prices nothing closer to the wind than this, whatever the polar says. */
const EDGE_NO_GO_DEG = 35;

/** The generic polar's name, as the banner prints it. */
export const GENERIC_POLAR_LABEL = 'Generic cruising polar';
const GENERIC = GENERIC_POLAR_LABEL;

// ── Checking and shaping a polar ─────────────────────────────────

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const increasing = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]);

/** Keep only the TWS columns `keep` marks. */
function keepColumns(p: PolarData, keep: boolean[]): PolarData {
    if (keep.every(Boolean)) return p;
    return {
        windSpeeds: p.windSpeeds.filter((_, i) => keep[i]),
        angles: p.angles,
        matrix: p.matrix.map((row) => row.filter((_, i) => keep[i])),
    };
}

/** Drop TWS columns under MIN_TWS_KTS. */
const dropCalmColumns = (p: PolarData): PolarData =>
    keepColumns(
        p,
        p.windSpeeds.map((w) => w >= MIN_TWS_KTS),
    );

/**
 * Drop trailing TWS columns that are zero in every row: an OpenCPN-style
 * file leaves its high-wind columns blank ("no figure"), not "no speed".
 * Above her last real column the lookup holds it, as for any polar.
 */
function dropBlankHighColumns(p: PolarData): PolarData {
    let last = p.windSpeeds.length - 1;
    while (last > 0 && p.matrix.every((row) => !(row[last] > 0))) last--;
    return keepColumns(
        p,
        p.windSpeeds.map((_, i) => i <= last),
    );
}

/**
 * Rows inside MIN_PRICED_TWA: a VPP-style file's few tenths of a knot there
 * are its no-go zone, so they are zeroed (normaliseRoutingPolar then ramps
 * from her first real angle). A real speed there — over a quarter of the
 * column's best — means the file is not a sailing polar: refused.
 */
function zeroNoGoRows(p: PolarData): PolarData | null {
    const best = p.windSpeeds.map((_, w) => Math.max(...p.matrix.map((row) => row[w])));
    let changed = false;
    const matrix = p.matrix.map((row, a) => {
        if (p.angles[a] >= MIN_PRICED_TWA || row.every((v) => v === 0)) return row;
        if (row.some((v, w) => v > best[w] * NO_GO_RIPPLE_SHARE)) return null;
        changed = true;
        return row.map(() => 0);
    });
    if (matrix.some((row) => row === null)) return null;
    return changed ? { ...p, matrix: matrix as number[][] } : p;
}

/** A copy of `value` if a router can sail by it; otherwise why not. */
function checkPolar(value: unknown): { polar: PolarData } | { why: string } {
    const p = value as Partial<PolarData> | null;
    const { windSpeeds, angles, matrix } = p ?? {};
    if (!Array.isArray(windSpeeds) || !Array.isArray(angles) || !Array.isArray(matrix)) {
        return { why: 'it is missing its wind speeds, angles or speeds' };
    }
    if (!windSpeeds.every((w) => finite(w) && w >= 0) || !angles.every((a) => finite(a) && a >= 0 && a <= 180)) {
        return { why: 'its wind speeds or angles are not numbers in range' };
    }
    if (!increasing(windSpeeds) || !increasing(angles)) return { why: 'its wind speeds or angles do not increase' };
    if (matrix.length !== angles.length || !matrix.every((r) => Array.isArray(r) && r.length === windSpeeds.length)) {
        return { why: 'its table does not match its wind speeds and angles' };
    }
    if (!matrix.every((r) => r.every((v) => finite(v) && v >= 0 && v <= MAX_POLAR_KTS))) {
        return { why: `it has speeds that are not numbers between 0 and ${MAX_POLAR_KTS} kn` };
    }
    const columns = dropBlankHighColumns(
        dropCalmColumns({
            windSpeeds: [...windSpeeds],
            angles: [...angles],
            matrix: matrix.map((r) => [...r]),
        }),
    );
    if (columns.windSpeeds.length < 2 || columns.angles.length < 2) return { why: 'it has too few rows or columns' };
    const polar = zeroNoGoRows(columns);
    if (!polar) return { why: `it gives her real speed within ${MIN_PRICED_TWA}° of the wind` };
    const offWind = polar.matrix.filter((_, i) => polar.angles[i] >= 50).flat();
    if (offWind.length === 0 || offWind.filter((v) => v <= 0).length > offWind.length * MAX_ZERO_SHARE_OFF_WIND) {
        return { why: 'too many of its figures off the wind are zero' };
    }
    return { polar };
}

/**
 * Give a sailing polar its no-go zone: zero-speed rows at 0° and at five
 * degrees inside its first priced angle (its own leading all-zero rows are
 * replaced), and no TWS column under 0.1 kn.
 */
export function normaliseRoutingPolar(polar: PolarData): PolarData {
    const p = dropCalmColumns(polar);
    const first = p.matrix.findIndex((row) => row.some((v) => v > 0));
    if (first < 0) return p;
    const firstAngle = p.angles[first];
    const zeros = () => p.windSpeeds.map(() => 0);
    const lead = [0, firstAngle - NO_GO_RAMP_DEG].filter(
        (a, i, all) => a >= 0 && a < firstAngle && all.indexOf(a) === i,
    );
    return {
        windSpeeds: [...p.windSpeeds],
        angles: [...lead, ...p.angles.slice(first)],
        matrix: [...lead.map(zeros), ...p.matrix.slice(first).map((r) => [...r])],
    };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The learned cells, each held to LEARNED_BAND × the factory figure (a cell
 * the factory polar calls no-go is held to 1.5× her best at that wind); the
 * factory polar in every cell not yet learned; and the factory polar's own
 * columns outside the learned TWS range, so light and heavy air are its
 * figures rather than the learned grid's 6 or 25 kn column held flat.
 */
function blendLearned(learned: PolarData, factory: PolarData): PolarData {
    const lo = learned.windSpeeds[0];
    const hi = learned.windSpeeds[learned.windSpeeds.length - 1];
    const windSpeeds = [
        ...factory.windSpeeds.filter((w) => w < lo),
        ...learned.windSpeeds,
        ...factory.windSpeeds.filter((w) => w > hi),
    ];
    return {
        windSpeeds,
        angles: [...learned.angles],
        matrix: learned.angles.map((angle, a) =>
            windSpeeds.map((tws) => {
                const at = createPolarSpeedLookup(factory, tws);
                const f = at(angle);
                const w = learned.windSpeeds.indexOf(tws);
                const v = w >= 0 ? (learned.matrix[a]?.[w] ?? 0) : 0;
                if (!(v > 0)) return round2(f);
                const [low, high] =
                    f > 0
                        ? [f * LEARNED_BAND[0], f * LEARNED_BAND[1]]
                        : [0, Math.max(...learned.angles.map(at)) * LEARNED_BAND[1]];
                return round2(Math.min(MAX_POLAR_KTS, Math.max(low, Math.min(high, v))));
            }),
        ),
    };
}

/** FNV-1a over the source and every figure, as 8 hex digits. */
function signatureOf(source: RoutingPolarSource, p: PolarData): string {
    const text = `${source}|${p.windSpeeds.join(',')}|${p.angles.join(',')}|${p.matrix.map((r) => r.join(',')).join(';')}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

const kn = (v: number) => (Math.round(v * 10) / 10).toString();

/** What the banner calls her chosen polar when it is refused. */
const REFUSED: Record<string, string> = {
    database: 'your yacht database polar',
    file_import: 'your imported polar',
    manual: 'your own polar figures',
};

function finish(
    polar: PolarData,
    source: RoutingPolarSource,
    label: string,
    reason: string,
    learned?: { cells: number; learning: boolean },
): ResolvedRoutingPolar {
    const resolved: ResolvedRoutingPolar = { polar, source, label, reason, signature: signatureOf(source, polar) };
    if (learned) {
        resolved.learnedCells = learned.cells;
        resolved.learning = learned.learning;
    }
    return resolved;
}

const scaleBy = (p: PolarData, scale: number): PolarData => ({
    ...p,
    matrix: p.matrix.map((r) => r.map((v) => v * scale)),
});

/**
 * The generic polar for her: its shape scaled so a fair reaching breeze gives
 * her cruising speed (vesselCruisingSpeedKts: a stored 0 is "auto"), as a
 * database shape is. Raw only when no cruising speed can be matched to it
 * (none and no length, or outside polarScale's band) — the HUD then plans her
 * at her cruising speed flat. Not yet normalised.
 */
export function genericPolarFor(vessel: VesselProfile): { polar: PolarData; cruiseKts: number | null } {
    const cruise = vesselCruisingSpeedKts(vessel, 0);
    const scale = polarScale(DEFAULT_CRUISING_POLAR, cruise);
    return scale === null
        ? { polar: DEFAULT_CRUISING_POLAR, cruiseKts: null }
        : { polar: scaleBy(DEFAULT_CRUISING_POLAR, scale), cruiseKts: cruise };
}

/** Steps 3–4: the skipper's chosen polar, else the generic one (not yet normalised). */
function factoryPolar(settings: RoutingPolarSettings, vessel: VesselProfile): Omit<ResolvedRoutingPolar, 'signature'> {
    const kind = settings.polarSource_type ?? 'manual';
    /** The generic polar, scaled to her; when she chose one it could not use, the label says so. */
    const generic = (reason: string, refused = true) => {
        const { polar, cruiseKts } = genericPolarFor(vessel);
        return {
            polar,
            source: 'default' as const,
            label: refused ? `${GENERIC} (${REFUSED[kind] ?? REFUSED.manual} could not be used)` : GENERIC,
            reason: `${reason}; ${
                cruiseKts === null
                    ? 'the generic polar, unscaled: no cruising speed to match it to'
                    : `the generic shape, scaled so a fair reaching breeze gives her ${kn(cruiseKts)} kn`
            }`,
        };
    };
    if (!settings.polarData) return generic('no polar chosen', false);
    const checked = checkPolar(settings.polarData);
    if ('why' in checked) return generic(`your polar is not usable: ${checked.why}`);
    const name = settings.polarBoatModel?.trim() || '';
    switch (kind) {
        case 'database': {
            // The Passage HUD's own speed: a stored 0 is "auto" (VesselTab's
            // "Reset to auto"), sqrt(LOA) × 1.2 for a sailing boat.
            const cruise = vesselCruisingSpeedKts(vessel, 0);
            const scale = polarScale(checked.polar, cruise);
            if (scale === null) {
                return generic(`the yacht database polar cannot be matched to a cruising speed of ${kn(cruise)} kn`);
            }
            return {
                polar: scaleBy(checked.polar, scale),
                source: 'database-scaled',
                label: `${name || 'Yacht database polar'} (shape scaled to ${kn(cruise)} kn)`,
                reason: `the yacht database shape, scaled so a fair reaching breeze gives her ${kn(cruise)} kn`,
            };
        }
        case 'file_import':
            return {
                polar: checked.polar,
                source: 'imported',
                label: name ? `${name} (imported)` : 'Your imported polar',
                reason: 'the polar you imported',
            };
        default:
            return {
                polar: checked.polar,
                source: 'manual',
                label: name ? `${name} (your own figures)` : 'Your own polar figures',
                reason: 'the polar figures you entered',
            };
    }
}

/**
 * Which polar a route sails by — pure: the settings, the vessel and a
 * snapshot of the learned grid in; the polar, its name and why out.
 */
export function resolveRoutingPolarFrom(input: {
    settings: RoutingPolarSettings | null | undefined;
    vessel: VesselProfile;
    learned: LearnedPolarSnapshot | null;
}): ResolvedRoutingPolar {
    const settings = input.settings ?? {};
    if (input.vessel.type !== 'sail') {
        return finish(DEFAULT_CRUISING_POLAR, 'default', GENERIC, 'not a sailing vessel: routing unchanged');
    }
    const factory = factoryPolar(settings, input.vessel);
    const factoryNormalised = normaliseRoutingPolar(factory.polar);
    if (settings.polarSource === 'smart') {
        const filled = input.learned?.polar ? input.learned.filledCells : 0;
        // The learner is its own switch (Settings → Preferences), apart from
        // "Routing uses: Smart": off — or never on — nothing is learning.
        const learning = settings.smartPolarsEnabled === true;
        const cells = `${filled} of ${LEARNED_CELLS} cells`;
        const counted = learning ? cells : `${cells}, learning off`;
        const learned = { cells: filled, learning };
        if (input.learned?.polar && filled >= LEARNED_MIN_FILLED_CELLS) {
            return finish(
                normaliseRoutingPolar(blendLearned(input.learned.polar, factoryNormalised)),
                'learned',
                filled >= LEARNED_CELLS
                    ? `Learned (${counted})`
                    : `Learned (${counted}), the rest from ${factory.label}`,
                `learned in ${counted}; the rest from ${factory.label}`,
                learned,
            );
        }
        // Still filling: say so, and what she sails on meanwhile (never just the
        // factory name, as if Smart had not been chosen).
        const why = `the learned polar has too few samples (${counted}; it needs ${LEARNED_MIN_FILLED_CELLS})`;
        return finish(
            factoryNormalised,
            factory.source,
            `${learning ? 'Learning' : 'Smart polar'} (${counted}), sailing on ${factory.label}`,
            `${why}, so ${factory.reason}`,
            learned,
        );
    }
    return finish(factoryNormalised, factory.source, factory.label, factory.reason);
}

/**
 * What SmartPolarStore holds now, as routing counts it (buckets of
 * ROUTING_MIN_BUCKET_SAMPLES+). Synchronous: the caller has loaded the store.
 */
export function learnedPolarSnapshot(): LearnedPolarSnapshot {
    const polar = SmartPolarStore.exportToPolarData(ROUTING_MIN_BUCKET_SAMPLES);
    return { polar, filledCells: polar ? polar.matrix.flat().filter((v) => v > 0).length : 0 };
}

/** Her own figures (imported, typed in, learned): sailed as given, by the routers and the HUD alike. */
export function sailsHerOwnFigures(source: RoutingPolarSource): boolean {
    return source === 'learned' || source === 'imported' || source === 'manual';
}

/**
 * The Passage HUD's and Plan Your Day's speed model on the routers' polar: her
 * own figures as given, ends held as the routers hold them ('figures'); a
 * database or generic SHAPE as a shape ('shape'). The resolver has already
 * scaled a shape to her cruising speed, so the HUD's own scaling is identity
 * and its figures are the routers'; what it keeps are a shape's guards at the
 * table's ends (passagePlan.passageSpeed).
 */
export function routingSpeedModel(
    routing: Pick<ResolvedRoutingPolar, 'polar' | 'source'>,
    base: Omit<PassageSpeedModel, 'polar' | 'polarKind'>,
): PassageSpeedModel {
    return { ...base, polar: routing.polar, polarKind: sailsHerOwnFigures(routing.source) ? 'figures' : 'shape' };
}

/**
 * The resolver every router calls. Reads the settings store unless given
 * settings; no vessel profile routes as the default sloop (like the voyage
 * form). The learned grid is read with ensureLoaded — never initialize(),
 * which would reload the disk copy over samples not yet saved — and only when
 * routing is set to use it. Never throws: the generic polar is the floor.
 */
export async function resolveRoutingPolar(
    input: { settings?: RoutingPolarSettings; vessel?: VesselProfile | null } = {},
): Promise<ResolvedRoutingPolar> {
    try {
        const settings = input.settings ?? useSettingsStore.getState().settings;
        const vessel = resolveEffectiveVessel(input.vessel !== undefined ? input.vessel : settings.vessel);
        let learned: LearnedPolarSnapshot | null = null;
        if (settings.polarSource === 'smart' && vessel.type === 'sail') {
            try {
                await SmartPolarStore.ensureLoaded();
                learned = learnedPolarSnapshot();
            } catch (e) {
                log.warn('learned polar unreadable; routing on the factory polar:', e);
            }
        }
        const resolved = resolveRoutingPolarFrom({ settings, vessel, learned });
        const line = `routing polar: ${resolved.label} — ${resolved.reason} [${resolved.signature}]`;
        // A refused choice is a warning: log.info is silent in production builds.
        if (resolved.source === 'default' && resolved.label.includes('could not be used')) log.warn(line);
        else log.info(line);
        return resolved;
    } catch (e) {
        log.warn('routing polar could not be resolved; using the generic polar:', e);
        return finish(normaliseRoutingPolar(DEFAULT_CRUISING_POLAR), 'default', GENERIC, 'the polar could not be read');
    }
}

/** At most `max` of `n` indices, evenly spread, always keeping the first and the last. */
function spread(n: number, max: number): number[] {
    if (n <= max) return Array.from({ length: n }, (_, i) => i);
    return Array.from({ length: max }, (_, i) => Math.round((i * (n - 1)) / (max - 1)));
}

/**
 * The polar for the route-weather edge function: null for the generic polar,
 * so the edge keeps its own cruise-scaled fallback.
 *
 * Shaped to the edge's contract (at most 30 rows and 30 columns) and to what
 * the edge actually prices, so every figure it looks up matches the app's
 * own router:
 *  - leading rows that cannot change an edge figure are left out — the edge
 *    prices nothing inside 35°, and returns zero below a custom polar's first
 *    angle exactly as a zero row would (the 0° row always goes; the no-go
 *    ramp stays when it shapes 35° up to her first priced angle);
 *  - a table still over the limit is thinned to evenly spread rows/columns
 *    (first and last kept) rather than sent as nothing;
 *  - the axes are padded with copies of their outer rows and columns (to
 *    0.1–150 kn and to 180°): the edge returns ZERO — impassable — anywhere
 *    off a custom polar's axes, so light air under the first column would
 *    close the route there.
 * The edge still applies its own light-air, wave and gale rules on top.
 */
export function toEdgePolar(resolved: ResolvedRoutingPolar): PolarData | null {
    if (resolved.source === 'default') return null;
    const p = resolved.polar;
    const zero = (row: number[]) => row.every((v) => !(v > 0));
    let first = 0;
    while (
        first < p.angles.length - 2 &&
        (p.angles[first + 1] <= EDGE_NO_GO_DEG || (zero(p.matrix[first]) && zero(p.matrix[first + 1])))
    ) {
        first++;
    }
    const lowPad = p.windSpeeds[0] > MIN_TWS_KTS;
    const highPad = p.windSpeeds[p.windSpeeds.length - 1] < EDGE_MAX_TWS_KTS;
    const deadPad = p.angles[p.angles.length - 1] < 180;
    const rowIdx = spread(p.angles.length - first, EDGE_MAX_AXIS - (deadPad ? 1 : 0)).map((i) => i + first);
    const colIdx = spread(p.windSpeeds.length, EDGE_MAX_AXIS - (lowPad ? 1 : 0) - (highPad ? 1 : 0));
    const padRow = (row: number[]) => {
        const cells = colIdx.map((w) => row[w]);
        return [...(lowPad ? [cells[0]] : []), ...cells, ...(highPad ? [cells[cells.length - 1]] : [])];
    };
    const rows = rowIdx.map((a) => padRow(p.matrix[a]));
    return {
        windSpeeds: [
            ...(lowPad ? [MIN_TWS_KTS] : []),
            ...colIdx.map((w) => p.windSpeeds[w]),
            ...(highPad ? [EDGE_MAX_TWS_KTS] : []),
        ],
        angles: [...rowIdx.map((a) => p.angles[a]), ...(deadPad ? [180] : [])],
        matrix: deadPad ? [...rows, [...rows[rows.length - 1]]] : rows,
    };
}
