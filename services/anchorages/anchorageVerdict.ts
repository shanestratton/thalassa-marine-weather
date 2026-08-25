/**
 * anchorageVerdict — which anchorage tonight, and why.
 *
 * PURE scoring. Inputs are an anchorage's baked fetch tables (36-sector
 * distances to the first blocker, built by scripts/anchorages/build-qld.mjs)
 * and an hourly forecast for the stay window; output is a graded verdict
 * with plain-language reasons. Nothing here fetches, renders, or stores.
 *
 * THE MODEL (deliberately simple, deliberately conservative):
 *  - WIND → CHOP. Wind builds sea over open water, and a blocker upwind —
 *    land OR reef — stops everything built beyond it; only the water
 *    between blocker and boat grows new chop. The COMBINED reef table
 *    (min of land and reef distance per sector) is therefore the honest
 *    chop fetch. Wind STRENGTH is unblocked either way — a reef lee is
 *    flat water in 25 kn, not calm.
 *  - SWELL → ROLL. Ocean swell needs an open path; it also WRAPS ~40°
 *    around headlands (refraction), so the exposure test widens the swell
 *    direction by ±WRAP_DEG and takes the worst open sector. Reefs break
 *    swell: the combined reef table governs.
 *  - THE WINDOW, NOT THE INSTANT. Every hour of the stay is scored and the
 *    WORST hour dominates the verdict — the 02:00 wind shift that rolls
 *    half the bay out of their bunks is the exact failure this exists to
 *    call before dark.
 *  - HONESTY ABOUT SPREAD. When the caller supplies per-model winds and
 *    they disagree (direction spread or speed spread past thresholds), the
 *    verdict says "models split" rather than betting ground tackle on one
 *    number — same rule every Reef weather post follows.
 *
 * A verdict is an ADVISORY read of open data + forecast — never a
 * substitute for the chart, the pilot, or the skipper's own eyes. Wording
 * in reasons[] must stay descriptive ("open to the SE"), never imperative
 * beyond the ranking itself.
 */

export interface AnchorageForVerdict {
    id: string;
    name: string;
    kind: 'anchorage' | 'designated_anchorage' | 'marina';
    lat: number;
    lon: number;
    /** 36 sectors × 10°, NM to first COASTLINE crossing (wind protection). */
    fetchLandNM: readonly number[];
    /** 36 sectors, NM to first coastline OR reef crossing (sea/swell protection). */
    fetchReefNM: readonly number[];
    noAnchoring?: boolean;
    noAnchoringName?: string | null;
}

export interface VerdictHour {
    /** Epoch ms of the hour. */
    t: number;
    /** True direction the wind blows FROM, degrees. */
    windDirDeg: number;
    windKts: number;
    /** Swell omitted = unknown (offline / marine API down) — the verdict
     *  says so instead of silently scoring calm. */
    swellDirDeg?: number;
    swellM?: number;
    swellPeriodS?: number;
}

export type AnchorageGrade = 'bombproof' | 'good' | 'tenable' | 'poor' | 'no-anchoring';

export interface AnchorageVerdict {
    id: string;
    name: string;
    grade: AnchorageGrade;
    /** 0 (worst) … 100 (best). no-anchoring pins 0. */
    score: number;
    /** Plain-language grounds, in the order they matter. */
    reasons: string[];
    /** True when per-model winds disagreed enough that the verdict is soft. */
    modelsSplit: boolean;
    /** True when no swell data was supplied — roll is UNASSESSED, not absent. */
    swellUnknown: boolean;
    /** The worst hour's epoch ms — when it gets uncomfortable. */
    worstAtMs: number | null;
}

/** Fetch below this is a true lee — chop cannot build. */
const SHELTERED_NM = 1;
/** Fetch above this is effectively open water for both chop and swell. */
const OPEN_NM = 10;
/** Swell wraps this many degrees around a headland (refraction allowance). */
const WRAP_DEG = 40;
/** Direction spread (deg) across models that makes a verdict "split". */
const SPLIT_DIR_DEG = 60;
/** Speed spread (kts) across models that makes a verdict "split". */
const SPLIT_SPEED_KTS = 8;

const SECTOR_DEG = 10;

/** Interpolated fetch at an exact bearing, from a 36-sector table. */
export function fetchAt(table: readonly number[], bearingDeg: number): number {
    const b = ((bearingDeg % 360) + 360) % 360;
    const i = Math.floor(b / SECTOR_DEG) % 36;
    const j = (i + 1) % 36;
    const f = (b - i * SECTOR_DEG) / SECTOR_DEG;
    return table[i] * (1 - f) + table[j] * f;
}

/** Worst (largest) fetch across bearing ± spread — swell wrap, gust veer. */
export function worstFetchAround(table: readonly number[], bearingDeg: number, spreadDeg: number): number {
    let worst = 0;
    for (let d = -spreadDeg; d <= spreadDeg; d += SECTOR_DEG / 2) {
        worst = Math.max(worst, fetchAt(table, bearingDeg + d));
    }
    return worst;
}

const compass = (deg: number): string => {
    const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return pts[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
};

/** 0 (flat) … 1 (full exposure) discomfort from wind over fetch. */
function chopFactor(windKts: number, fetchNM: number): number {
    if (windKts < 8) return 0; // light air builds nothing that matters at anchor
    const fetchF = Math.min(Math.max((fetchNM - SHELTERED_NM) / (OPEN_NM - SHELTERED_NM), 0), 1);
    const windF = Math.min((windKts - 8) / 22, 1); // 30 kn = full weight
    return fetchF * windF;
}

/** 0 … 1 discomfort from swell reaching the anchorage. */
function rollFactor(swellM: number, periodS: number, exposureFetchNM: number): number {
    if (swellM < 0.3) return 0;
    const open = Math.min(Math.max((exposureFetchNM - SHELTERED_NM) / (OPEN_NM - SHELTERED_NM), 0), 1);
    const size = Math.min(swellM / 2.5, 1); // 2.5 m = full weight
    const period = Math.min(Math.max((periodS - 4) / 8, 0.3), 1); // long swell rolls harder
    return open * size * period;
}

export interface VerdictInput {
    anchorage: AnchorageForVerdict;
    /** The stay window, hourly. One entry per hour, blended/primary model. */
    hours: readonly VerdictHour[];
    /** Optional per-model winds for the same hours, for the split check:
     *  perModelWinds[m][h] pairs with hours[h]. */
    perModelWinds?: readonly (readonly { windDirDeg: number; windKts: number }[])[];
}

export function scoreAnchorage(input: VerdictInput): AnchorageVerdict {
    const { anchorage: a, hours } = input;

    if (a.noAnchoring) {
        return {
            id: a.id,
            name: a.name,
            grade: 'no-anchoring',
            score: 0,
            reasons: [`No-anchoring area${a.noAnchoringName ? ` — ${a.noAnchoringName}` : ''} (GBRMPA)`],
            modelsSplit: false,
            swellUnknown: false,
            worstAtMs: null,
        };
    }
    if (hours.length === 0) {
        return {
            id: a.id,
            name: a.name,
            grade: 'tenable',
            score: 50,
            reasons: ['No forecast supplied — shelter tables only, conditions unassessed'],
            modelsSplit: false,
            swellUnknown: true,
            worstAtMs: null,
        };
    }

    let worst = 0;
    let worstAtMs: number | null = null;
    let worstWind = hours[0];
    let sum = 0;
    let swellUnknown = false;
    let worstRoll = 0;
    let worstRollHour: VerdictHour | null = null;

    for (const h of hours) {
        // Chop: the sea the wind can build across the water that actually
        // reaches the boat — reefs stop what was built beyond them.
        const chop = chopFactor(h.windKts, worstFetchAround(a.fetchReefNM, h.windDirDeg, SECTOR_DEG));
        let roll = 0;
        if (h.swellDirDeg == null || h.swellM == null) {
            swellUnknown = true;
        } else {
            roll = rollFactor(h.swellM, h.swellPeriodS ?? 8, worstFetchAround(a.fetchReefNM, h.swellDirDeg, WRAP_DEG));
        }
        const discomfort = Math.max(chop, roll * 0.9); // a bad roll ≈ a bad chop
        sum += discomfort;
        if (discomfort > worst) {
            worst = discomfort;
            worstAtMs = h.t;
            worstWind = h;
        }
        if (roll > worstRoll) {
            worstRoll = roll;
            worstRollHour = h;
        }
    }
    const mean = sum / hours.length;
    // Worst hour dominates (70%): one ugly shift ruins the night even if the
    // evening was glass.
    const discomfort = worst * 0.7 + mean * 0.3;
    const score = Math.round((1 - discomfort) * 100);

    // ── model spread (honesty clause) ──
    let modelsSplit = false;
    if (input.perModelWinds && input.perModelWinds.length >= 2) {
        for (let h = 0; h < hours.length && !modelsSplit; h++) {
            const dirs = input.perModelWinds.map((m) => m[h]?.windDirDeg).filter((d): d is number => d != null);
            const spds = input.perModelWinds.map((m) => m[h]?.windKts).filter((d): d is number => d != null);
            if (dirs.length >= 2) {
                let maxDiff = 0;
                for (let i = 0; i < dirs.length; i++) {
                    for (let j = i + 1; j < dirs.length; j++) {
                        const diff = Math.abs(((dirs[i] - dirs[j] + 540) % 360) - 180);
                        maxDiff = Math.max(maxDiff, diff);
                    }
                }
                if (maxDiff > SPLIT_DIR_DEG) modelsSplit = true;
            }
            if (spds.length >= 2 && Math.max(...spds) - Math.min(...spds) > SPLIT_SPEED_KTS) modelsSplit = true;
        }
    }

    // ── reasons, in the order a skipper wants them ──
    const reasons: string[] = [];
    const windFetch = worstFetchAround(a.fetchReefNM, worstWind.windDirDeg, SECTOR_DEG);
    const windTxt = `${compass(worstWind.windDirDeg)} ${Math.round(worstWind.windKts)} kn`;
    if (worst < 0.15) {
        const openSectors = a.fetchLandNM.filter((d) => d >= OPEN_NM).length;
        reasons.push(
            openSectors === 0
                ? `Landlocked — nothing in the window touches it (${windTxt} at worst)`
                : `Full lee for ${windTxt} — under ${Math.max(SHELTERED_NM, Math.round(windFetch * 10) / 10)} NM fetch all window`,
        );
    } else if (chopFactor(worstWind.windKts, windFetch) >= worst - 0.01) {
        reasons.push(
            windFetch >= OPEN_NM
                ? `Open to the ${compass(worstWind.windDirDeg)} — ${windTxt} has ${Math.round(windFetch)}+ NM of fetch`
                : `${windTxt} works across ${windFetch.toFixed(1)} NM — expect chop`,
        );
    }
    if (worstRoll > 0.15 && worstRollHour?.swellDirDeg != null && worstRollHour.swellM != null) {
        reasons.push(
            `${worstRollHour.swellM.toFixed(1)} m ${compass(worstRollHour.swellDirDeg)} swell finds a way in — expect roll`,
        );
    } else if (!swellUnknown && worstRoll <= 0.15 && worst >= 0.15) {
        reasons.push('Swell is blocked — wind chop is the only tax');
    }
    if (swellUnknown) reasons.push('Swell unknown (no marine data) — roll unassessed');
    if (modelsSplit) reasons.push('Models split on the wind — treat this ranking as soft');
    if (worstAtMs != null && worst >= 0.35) {
        const when = new Date(worstAtMs);
        reasons.push(`Worst of it around ${String(when.getHours()).padStart(2, '0')}:00`);
    }

    const grade: AnchorageGrade = worst < 0.12 ? 'bombproof' : worst < 0.3 ? 'good' : worst < 0.55 ? 'tenable' : 'poor';
    return { id: a.id, name: a.name, grade, score, reasons, modelsSplit, swellUnknown, worstAtMs };
}

/** Rank a set of anchorages for the same window — the "where tonight" list.
 *  no-anchoring areas sink to the bottom, then score, then name. */
export function rankAnchorages(
    anchorages: readonly AnchorageForVerdict[],
    hours: readonly VerdictHour[],
    perModelWinds?: VerdictInput['perModelWinds'],
): AnchorageVerdict[] {
    return anchorages
        .map((anchorage) => scoreAnchorage({ anchorage, hours, perModelWinds }))
        .sort(
            (x, y) =>
                (x.grade === 'no-anchoring' ? 1 : y.grade === 'no-anchoring' ? -1 : 0) ||
                y.score - x.score ||
                x.name.localeCompare(y.name),
        );
}
