/**
 * pick — which places Plan Your Day's card shows, and the fact that put each
 * there (build 127, 127-PYD-4).
 *
 * Shane, 2026-10-10: "plan your day?? why does it only ever show the same 3
 * destinations. ??? it needs another good clean up claude." Shelter reads
 * "very sheltered" in almost any wind under 18 kn, so ranking on it alone
 * chose the three nearest reviewed stops every time (Cid Harbour on 109 of
 * 120 cards). Now every place in reach is planned on the area wind and
 * scored on four named terms; the card shows the best fit, the best the other
 * way and one somewhere different, each with one tag that is true for it.
 *
 * PURE and deterministic: no clock, no I/O, no shuffling by date. The same
 * inputs give the same card; it changes with the wind, the day, the stay or
 * her own history.
 */
import { calculateBearing, calculateDistance } from '../../utils/navigationCalculations';
import {
    departureScore,
    departureScoreTerms,
    type DepartureScoreTerms,
    type ScoredDeparture,
} from '../passageDepartureSuggestion';
import type { EncHazardResult } from '../enc/types';
import type { LatLon } from './places';
import type { DayPlanLimits, StopLevel } from './today';

const HOUR = 3_600_000;

// ── The rank's composite: four named terms, no time term ───────

/** Local notes are a bonus, not a trump (the trump made "the same three"). */
export const REVIEWED_BONUS = 10;

/**
 * A real day out beats a hop when both fit: min(NM, 12) x 1.5, less 20 under
 * 4 NM (the investigators' prototype), on this composite's scale (the
 * prototype weighed the stay 0.3 a point; here it is 1). A passage-time
 * penalty in its place made the nearest bombproof bays a new "same three".
 */
export function dayOutCredit(estNm: number): number {
    return ((Math.min(estNm, 12) * 1.5 - (estNm < 4 ? 20 : 0)) * 10) / 3;
}

/**
 * The best area-wind departure's calm, 0-100 against HER limits: 0 at them
 * (her poor wind, gusts and sea, the poor wind as headwind), 100 in a flat
 * calm. departureScore and nothing else: it has no distance or time term.
 */
export function comfortScore(best: ScoredDeparture | null, terms: DepartureScoreTerms, limits: DayPlanLimits): number {
    if (!best) return 0;
    const poor = limits.wind.poor;
    const atLimits = departureScore(
        {
            departureMs: 0,
            maxWindKts: poor,
            maxHeadwindKts: poor,
            maxGustKts: limits.gust.poor,
            maxWaveM: limits.wave.poor,
            gustComplete: true,
            waveComplete: true,
        },
        terms,
    );
    return 100 * Math.min(1, Math.max(0, 1 - departureScore(best, terms) / atLimits));
}

export interface ScoreInput {
    level: StopLevel;
    /** The stay's shelter score, 0-100; null when not known. */
    stayScore: number | null;
    best: ScoredDeparture | null;
    /** One way, the distance estimate. */
    estNm: number;
    reviewed: boolean;
}

/** Each place's terms, reported apart (the day-out credit is the only distance term). */
export interface PlaceScore {
    level: StopLevel;
    stay: number;
    comfort: number;
    dayOut: number;
    reviewed: number;
    total: number;
}

/** Gust and wave count only if EVERY ranked place has them, so places are compared on the same terms. */
export function scorePlaces(items: readonly ScoreInput[], limits: DayPlanLimits): PlaceScore[] {
    const terms = departureScoreTerms(items.flatMap((i) => (i.best ? [i.best] : [])));
    return items.map((i) => {
        const stay = Math.min(100, Math.max(0, i.stayScore ?? 0));
        const comfort = comfortScore(i.best, terms, limits);
        const dayOut = dayOutCredit(i.estNm);
        const reviewed = i.reviewed ? REVIEWED_BONUS : 0;
        return { level: i.level, stay, comfort, dayOut, reviewed, total: stay + comfort + dayOut + reviewed };
    });
}

// ── Tags ───────────────────────────────────────────────────────

export type PickTag = 'new' | 'short' | 'closer' | 'shelter' | 'other';
export const TAG_WORDS: Record<PickTag, string> = {
    new: 'New to you',
    short: 'Short hop',
    closer: 'Closer',
    shelter: 'More shelter',
    other: 'Other way',
};
const TAG_ORDER: PickTag[] = ['new', 'short', 'closer', 'shelter', 'other'];
/** "Somewhere different": a tag the second does not have, preferring these, in turn. */
const DIFFERENT: PickTag[][] = [['new'], ['short', 'closer'], ['shelter']];

/** CLOSER: no more than this share of the best fit's distance. */
export const CLOSER_SHARE = 0.6;
/** OTHER WAY: at least this much bearing from the best fit, from the start. */
export const OTHER_WAY_DEG = 45;
/** Two stops on the card are at least this far apart. */
export const APART_NM = 3;
/** NEW TO YOU: no voyage of hers ended within this. */
export const VISITED_NM = 0.5;

/** A ranked place as the pick sees it. */
export interface PickPlace extends LatLon {
    id: string;
    estNm: number;
    /** From the start. */
    bearingDeg: number;
    stayScore: number | null;
    /** The longer leg (a day trip) or the way there (overnight), ms; null when not known. */
    hopMs: number | null;
    /** true: a voyage of hers ended within 0.5 NM; false: none did; null: her history is not known here. */
    visited: boolean | null;
}

export const bearingFrom = (start: LatLon, p: LatLon) => calculateBearing(start.lat, start.lon, p.lat, p.lon);
const angle = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);
const apart = (a: LatLon, b: LatLon) => calculateDistance(a.lat, a.lon, b.lat, b.lon);
/** At least APART_NM from every one of `from`. */
const far = (p: LatLon, from: readonly LatLon[]) => from.every((q) => apart(p, q) >= APART_NM);

/** Every tag that is true for `p` against the best fit, in TAG_ORDER. */
export function earnedTags(p: PickPlace, best: PickPlace): PickTag[] {
    const has: Record<PickTag, boolean> = {
        new: p.visited === false,
        short: p.hopMs !== null && p.hopMs <= HOUR,
        closer: p.estNm <= CLOSER_SHARE * best.estNm,
        shelter: p.stayScore !== null && best.stayScore !== null && p.stayScore > best.stayScore,
        other: angle(p.bearingDeg, best.bearingDeg) >= OTHER_WAY_DEG,
    };
    return TAG_ORDER.filter((t) => has[t]);
}

/** Has she been there: null when her history is not known (never "new" everywhere). */
export function visitedNear(p: LatLon, ends: readonly LatLon[] | null | undefined): boolean | null {
    return ends ? ends.some((e) => apart(e, p) <= VISITED_NM) : null;
}

// ── The pick ───────────────────────────────────────────────────

/** Best fit, the best other way, then somewhere different; `list` is in rank order. */
function chooseThree(list: readonly PickPlace[]): PickPlace[] {
    const [best, ...rest] = list;
    if (!best) return [];
    const second =
        rest.find((p) => angle(p.bearingDeg, best.bearingDeg) >= OTHER_WAY_DEG && far(p, [best])) ??
        rest.find((p) => far(p, [best])) ??
        rest[0];
    if (!second) return [best];
    const pool = rest.filter((p) => p !== second);
    const had = earnedTags(second, best);
    let third: PickPlace | undefined;
    for (const tier of DIFFERENT) {
        third = pool.find(
            (p) => far(p, [best, second]) && earnedTags(p, best).some((t) => tier.includes(t) && !had.includes(t)),
        );
        if (third) break;
    }
    // Else any place that earns a tag of its own; only then the next by rank.
    third ??=
        pool.find((p) => far(p, [best, second]) && earnedTags(p, best).length) ??
        pool.find((p) => far(p, [best, second])) ??
        pool[0];
    return third ? [best, second, third] : [best, second];
}

/**
 * The card's three and the next `backups` the same rules would choose: the
 * stops to route-check. Backups 3 NM from every pick come first, so one that
 * takes a slot is not the next bay along from a stop that stays.
 */
export function pickStops(list: readonly PickPlace[], backups: number): { picks: PickPlace[]; backups: PickPlace[] } {
    const picks = chooseThree(list);
    const rest = list.filter((p) => !picks.includes(p));
    const away = rest.filter((p) => far(p, picks));
    return { picks, backups: chooseThree([...away, ...rest.filter((p) => !away.includes(p))]).slice(0, backups) };
}

/**
 * A pick whose weather along the way came back over her limits (or failed)
 * gives its slot to a checked backup that fits: the first 3 NM from every
 * stop staying on the card that earns a tag against the best fit, else the
 * first 3 NM off, else the first that fits (never a ✕ when one does). A stop
 * whose page is open keeps its slot: nothing is swapped from under her.
 */
export function backfill(
    picks: readonly PickPlace[],
    backups: readonly PickPlace[],
    status: (id: string) => 'fits' | 'out' | null,
    pinned?: string | null,
): PickPlace[] {
    const spare = backups.filter((b) => status(b.id) === 'fits');
    const card = [...picks];
    const stays = (q: PickPlace) => q.id === pinned || status(q.id) !== 'out';
    card.forEach((p, i) => {
        if (stays(p)) return;
        const others = card.filter((q, j) => j !== i && stays(q));
        const b =
            spare.find((s) => far(s, others) && (!i || earnedTags(s, card[0]).length > 0)) ??
            spare.find((s) => far(s, others)) ??
            spare[0];
        if (b) card[i] = spare.splice(spare.indexOf(b), 1)[0];
    });
    return card;
}

/**
 * The card's tags against its first row, from the values the rows show: none
 * on the best fit; the second's "other way" when it has it; the third's a tag
 * the second does not have. Only ever a tag that is true; null when none is.
 */
export function cardTags(card: readonly PickPlace[]): (PickTag | null)[] {
    const [best, second] = card;
    const had = second ? earnedTags(second, best) : [];
    const shown = had.includes('other') ? 'other' : (had[0] ?? null);
    return card.map((p, i) => {
        if (i < 2) return i ? shown : null;
        const tags = earnedTags(p, best);
        // Not the second's tag again when it has another that is true.
        return tags.find((t) => t !== 'other' && !had.includes(t)) ?? tags.find((t) => t !== shown) ?? tags[0] ?? null;
    });
}

// ── Her history and her charts (read on the phone, kept in memory) ──

/**
 * Where her real voyages ended (planned routes are not voyages; imported ones
 * are). Null in, null out: a cache that is stale or unread is history NOT
 * known, never "new to you" on every place.
 */
export function voyageEnds(
    list: readonly { isPlannedRoute: boolean; lastLat: number | null; lastLon: number | null }[] | null,
): LatLon[] | null {
    if (!list) return null;
    return list.flatMap((v) =>
        !v.isPlannedRoute &&
        Number.isFinite(v.lastLat) &&
        Number.isFinite(v.lastLon) &&
        !(v.lastLat === 0 && v.lastLon === 0)
            ? [{ lat: v.lastLat!, lon: v.lastLon! }]
            : [],
    );
}

export type PinResult = Pick<EncHazardResult, 'covered' | 'hazard' | 'minDepthM' | 'hazardType' | 'soundingOnly'>;

const metres = (v: number) => `${Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v)} m`;

/**
 * What her charts say at a stop's pin, as a verdict only (never stored). A
 * depth area's minDepthM is its DRVAL1, the SHALLOW END of the area's range,
 * not a sounding at the pin: so "charted from N m", and under her draft plus
 * half a metre "may need tide", never "needs tide". `cap` holds the stop at
 * Near. Her draft null (the default boat) or no chart there: not checked.
 */
export function pinDepth(r: PinResult | null | undefined, draftM: number | null): { words: string; cap: boolean } {
    const none = { words: 'depth not checked', cap: false };
    if (!r?.covered || draftM === null) return none;
    if (r.soundingOnly)
        return r.minDepthM === null
            ? none
            : { words: `${none.words} · a charted sounding of ${metres(r.minDepthM)} near the pin`, cap: false };
    if (!r.hazard) return { words: '15 m or more charted at the pin', cap: false };
    const kind = r.hazardType;
    if (kind === 'land' || kind === 'coast')
        return { words: 'pin is on charted land: the stop is the water off it', cap: false };
    if (kind === 'rock' || kind === 'wreck' || kind === 'obstruction')
        return { words: `charted ${kind} near the pin`, cap: true };
    const d = r.minDepthM;
    if (d === null) return { words: 'depth not charted at the pin', cap: false };
    if (d < 0) return { words: 'dries at the pin (charted)', cap: true };
    return d < draftM + 0.5
        ? { words: `may need tide at the anchorage (charted from ${metres(d)})`, cap: true }
        : { words: `charted from ${metres(d)} at the pin`, cap: false };
}
