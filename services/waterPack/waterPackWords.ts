/**
 * What a route says about its canal and marina water (Phase 2b, 2026-10-01).
 * Pure.
 *
 * Owner decision 2: offline, the Newport canal gets no route UNTIL the offline
 * water pack. With the pack's tiles for the canal on the phone it routes, and
 * says where the water came from and when; without them it is still no route,
 * and the refusal says so first — the engine's own words follow, whole. A
 * refusal with a name of its own (no tide clears, a bridge the mast cannot
 * pass) keeps its words first and the pack sentence is appended.
 *
 * Every date here is absolute ("28 Sep"): these words are kept with a saved
 * plan, where "3 days ago" would go false.
 *
 * Fix-up (2026-10-02): the advice follows the reason. Offline it is "route
 * once you're online to save it"; online (the cloud at its quota or down, a
 * signed-out phone with no Pi) the water "couldn't be downloaded just now".
 * An end also counts as missing when water within ~2 km of its pin was left
 * out for a tile that isn't saved, and a land refusal on a partial pack says
 * some harbour water along the route isn't saved.
 */
import type { OsmOverlayProvenance } from '../OsmRouteOverlayService';
import { dateWords, endpointAreaKeys, type Bbox } from './waterPackTiles';

export type WaterPackEnd = 'departure' | 'destination';

/** How a route used the water pack. */
export interface WaterPackUse {
    /** online = a live answer (the Pi, the cloud, a pre-2b Pi); pi-stale = the
     *  boat's saved copy; pack = this phone's; none = no OSM water at all. */
    source: 'online' | 'pi-stale' | 'pack' | 'none';
    /** When the water came from OpenStreetMap (epoch ms), when known. */
    dataAsOf?: number;
    /** Route ends whose own water (±0.01°) was not saved on this phone. */
    missing: WaterPackEnd[];
    /** Some canal, marina or lead water along the route was left out
     *  because a tile it reaches isn't saved (pack only). */
    gaps?: true;
    /** The phone was offline when the water was looked for. Absent: online,
     *  so a failure was a download that didn't work just then. */
    offline?: true;
}

/** Over this the caveat adds that the marina may have changed. */
const OLD_AFTER_MS = 90 * 86_400_000;
const OSM_CREDIT = '© OpenStreetMap contributors';

/** Codes whose own words come first (the pack sentence is appended). */
const NAMED_REFUSALS = new Set(['no-tide-clears', 'air-draft-blocked', 'watchdog-timeout', 'coverage-gap']);
/** …of which these say nothing negative to follow with "either". */
const NO_EITHER = new Set(['watchdog-timeout']);

/** Dropped water this close to a pin (~2 km) is that end's own water. */
const END_REACH_M = 2_000;

function nearEnd(p: { lat: number; lon: number }, b: Bbox): boolean {
    const dLat = END_REACH_M / 111_320;
    const dLon = dLat / Math.max(0.2, Math.cos((p.lat * Math.PI) / 180));
    return p.lon - dLon <= b[2] && p.lon + dLon >= b[0] && p.lat - dLat <= b[3] && p.lat + dLat >= b[1];
}

/**
 * The route's use of the pack, from the overlay's provenance. Undefined when
 * there is none (a mocked overlay, an old caller): no words then, so every
 * route that never met the pack reads exactly as before.
 */
export function waterPackUseFor(
    provenance: OsmOverlayProvenance | undefined,
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
): WaterPackUse | undefined {
    if (!provenance) return undefined;
    const dataAsOf = typeof provenance.dataAsOf === 'number' ? { dataAsOf: provenance.dataAsOf } : {};
    switch (provenance.source) {
        case 'pi':
        case 'cloud':
        case 'pi-legacy':
            return { source: 'online', missing: [] };
        case 'pi-stale':
            // A whole snapshot of the route's bbox, from the boat.
            return { source: 'pi-stale', ...dataAsOf, missing: [] };
        case 'pack':
        case 'none': {
            const present = new Set(provenance.presentTiles ?? []);
            const dropped = provenance.unsavedWater ?? [];
            // An end's water is missing when its own tiles aren't saved, or
            // when water within ~2 km of its pin was left out for a tile that
            // isn't (2026-10-02: the pin's tile saved, the basin it sits in
            // reaching the next one).
            const ownWaterMissing = (p: { lat: number; lon: number }): boolean =>
                !endpointAreaKeys(p).every((k) => present.has(k)) || dropped.some((b) => nearEnd(p, b));
            const missing: WaterPackEnd[] = [];
            if (ownWaterMissing(origin)) missing.push('departure');
            if (ownWaterMissing(destination)) missing.push('destination');
            return {
                source: provenance.source,
                ...dataAsOf,
                missing,
                ...(dropped.length > 0 ? { gaps: true as const } : {}),
                ...(provenance.offline ? { offline: true as const } : {}),
            };
        }
        default:
            return undefined;
    }
}

const endsWords = (missing: readonly WaterPackEnd[]): string =>
    missing.length > 1 ? 'the departure and the destination' : `the ${missing[0]}`;

/** What a ROUTED passage says about its water. */
export function waterPackCaveats(use: WaterPackUse | undefined, now: number = Date.now()): string[] {
    if (!use) return [];
    const out: string[] = [];
    const known = typeof use.dataAsOf === 'number' && Number.isFinite(use.dataAsOf);
    const old =
        known && now - use.dataAsOf! > OLD_AFTER_MS
            ? ' It is over 3 months old; the marina may have changed since.'
            : '';
    if (use.source === 'pack') {
        out.push(
            `Canal and marina water on this route came from the harbour water saved on this phone${known ? ` on ${dateWords(use.dataAsOf!, now)}` : ''} (${OSM_CREDIT}), not a live download. Check it against the chart.${old}`,
        );
    } else if (use.source === 'pi-stale') {
        out.push(
            `Canal and marina water came from the boat's Pi, saved ${known ? dateWords(use.dataAsOf!, now) : 'on an unknown date'} (${OSM_CREDIT}); it couldn't be refreshed. Check it against the chart.${old}`,
        );
    }
    if ((use.source === 'pack' || use.source === 'none') && use.missing.length > 0) {
        // Kept with a saved plan, so no "just now".
        const why = use.offline ? "isn't saved on this phone" : "couldn't be downloaded and isn't saved on this phone";
        out.push(
            `Harbour water for ${endsWords(use.missing)} ${why}, so ${use.missing.length > 1 ? 'both ends were' : 'that end was'} routed on the charts alone.`,
        );
    }
    return out;
}

/**
 * The router's result with its use of the pack attached. A refusal with an
 * end's water missing from the phone (pack or none) leads with that — "no
 * route, and why" — and keeps the engine's words; a named refusal keeps its
 * own words first; a land refusal on a partial pack says some water along
 * the route isn't saved (waterPackRefusal). The code never changes, so every
 * code-keyed rule holds.
 */
export function applyWaterPack(res: null, use: WaterPackUse | undefined): null;
export function applyWaterPack<T extends object>(
    res: T,
    use: WaterPackUse | undefined,
): T & { waterPack?: WaterPackUse };
export function applyWaterPack<T extends object>(
    res: T | null,
    use: WaterPackUse | undefined,
): (T & { waterPack?: WaterPackUse }) | null;
export function applyWaterPack<T extends object>(
    res: T | null,
    use: WaterPackUse | undefined,
): (T & { waterPack?: WaterPackUse }) | null {
    if (!res || !use) return res;
    const failure = res as { error?: unknown; code?: unknown };
    if (typeof failure.error !== 'string') return { ...res, waterPack: use };
    if (use.source !== 'pack' && use.source !== 'none') return { ...res, waterPack: use };
    const error = waterPackRefusal(failure.error, use, typeof failure.code === 'string' ? failure.code : undefined);
    return error === failure.error ? { ...res, waterPack: use } : { ...res, waterPack: use, error };
}

/** The words with a sentence's end, so another sentence can follow. */
const closed = (words: string): string => (words && !/[.!?…]$/.test(words) ? `${words}.` : words);

/**
 * A refusal's words when the water of these ends is not on the phone: "No
 * route: …" first, the refusal's own words after — or, for a refusal with a
 * name of its own (no tide clears, a bridge, the watchdog, a chart gap), its
 * words first and the pack sentence after. With both ends saved but some
 * water along the route left out (a partial pack), a land refusal says so
 * after its own words. Offline the advice is to route once online; online,
 * to try again shortly. Nothing missing: the words as they were.
 */
export function waterPackRefusal(
    words: string,
    use: Pick<WaterPackUse, 'missing' | 'gaps' | 'offline'> | undefined,
    code?: string,
): string {
    if (!use) return words;
    const engine = words.trim();
    const named = code !== undefined && NAMED_REFUSALS.has(code);
    if (use.missing.length > 0) {
        const ends = endsWords(use.missing);
        const either = code !== undefined && NO_EITHER.has(code) ? '' : ' either';
        if (named) {
            const tail = use.offline
                ? `The harbour water for ${ends} isn't on this phone yet${either}; route once you're online to save it.`
                : `The harbour water for ${ends} couldn't be downloaded just now${either}; try again shortly.`;
            return [closed(engine), tail].filter(Boolean).join(' ');
        }
        const lead = use.offline
            ? `No route: the harbour water for ${ends} isn't on this phone yet, and the charts alone may show that water as land. Route once you're online to save it.`
            : `No route: the harbour water for ${ends} couldn't be downloaded just now and isn't saved on this phone, and the charts alone may show that water as land. Try again shortly.`;
        return `${lead}${engine ? ` (${engine})` : ''}`;
    }
    if (use.gaps && !named) {
        const tail = use.offline
            ? "Some harbour water along this route isn't saved on this phone, so the charts alone were used there; route once you're online to save it."
            : "Some harbour water along this route couldn't be downloaded just now and isn't saved on this phone, so the charts alone were used there; try again shortly.";
        return [closed(engine), tail].filter(Boolean).join(' ');
    }
    return words;
}
