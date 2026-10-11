/**
 * The notice band shown with a freshly drawn inshore route (PassageBanner via
 * usePassagePlanner), and the CAVEATS the route carries whatever notice is
 * showing. Pure, so the choice between them is testable.
 */
import type { PassageNotice } from './usePassagePlanner';
import {
    nearSpanBlocks,
    type ChartedShallowSpan,
    type DepthBend,
    type DryRun,
    type PinOffWater,
    type PinTail,
    type SurveyRunInfo,
} from '../../services/engine/types';
import { dryRunCaveat, dryRunNoticeTitle, pinDryRunCaveat, savedDryRuns } from '../../services/routing/dryRunWords';
import { waterPackCaveats, type WaterPackEnd, type WaterPackUse } from '../../services/waterPack/waterPackWords';
import { formatLatDegMin, formatLonDegMin } from '../../utils/formatDegMin';

export interface InshoreRouteNoticeInput {
    /** The router's per-segment safety classifications arrived intact. */
    stateMaskOk: boolean;
    destinationInlandTrimM?: number;
    structuresUnknownCells?: readonly string[];
    /** A pin on charted land, a drying bank or in water no tide clears
     *  (InshoreRouteResult.pinOffWater). */
    pinOffWater?: { origin?: PinOffWater; destination?: PinOffWater };
    /** A pin in charted-shallow water and its tail (InshoreRouteResult.pinTail,
     *  Shane 2026-10-03): said when its tail cannot run direct. */
    pinTail?: { origin?: PinTail; destination?: PinTail };
    /** The route crosses water a tide must clear where no tide curve was
     *  loaded before routing (InshoreRouteResult.tideCheck, owner decision
     *  11): water no tide clears could not be ruled out there. */
    tideCheck?: 'not-loaded';
    /** The route's survey stretches (InshoreRouteResult.surveyRuns, owner
     *  decision 9) and the cells whose survey quality was not checked. */
    surveyRuns?: readonly SurveyRunInfo[];
    surveyUncheckedCells?: readonly string[];
    /** How much of the survey stretches THIS view draws as amber dots
     *  (inshoreRouteState surveyAmberMetres). Absent: the view draws no
     *  survey amber at all (a saved plan, the tracer), so the caveat names no
     *  colour. */
    surveyAmber?: { marginM: number; poorM: number };
    /** Where the route's canal and marina water came from when it was not a
     *  live download (InshoreRouteResult.waterPack, Phase 2b, 2026-10-01):
     *  the phone's offline pack or the Pi's stale copy, with its date — or an
     *  end whose water is not saved, routed on the charts alone. */
    waterPack?: WaterPackUse;
    /** The stretches that pass inside a shallow band's clearance
     *  (nearShallowSummary of InshoreRouteResult.chartedShallowSpans). */
    nearShallow?: NearShallowSummary;
    /** The route's turn off the straight line for deeper water
     *  (InshoreRouteResult.depthBend; Port of Airlie, 2026-10-04). */
    depthBend?: DepthBend;
    /** The dry stretches the route crosses, red — water no tide clears, or
     *  drying ground with no tide data to clear it — because there is no
     *  deeper way round (InshoreRouteResult.dryRuns; package 125-05, Shane
     *  2026-10-08: "better we just have red at the "dry" zones"). A pin's
     *  own dry tail is among them (DryRun.pin, package 125-05b). */
    dryRuns?: readonly DryRun[];
    /** The clock a pin tail's "today's tide" is read by; now when absent. */
    nowMs?: number;
    ntmLockBanner: PassageNotice | null;
}

/**
 * The stretches of a route that pass inside the clearance the router keeps
 * from a shallow band (ChartedShallowSpan.near — the real-chart check,
 * 2026-10-03): how many, and the one that falls furthest short. The map draws
 * them and Auto will not save a red one; a plan from the voyage form kept none
 * of it (fix-up review, 2026-10-03), so the route says it and the saved route
 * carries it (inshoreRouteToGeoJSON). Undefined when there are none.
 *
 * Round-3 fix-up (2026-10-03): `red` counts the near stretches no tide lifts
 * or no tide was loaded for (nearSpanBlocks — what Save refuses; Plan My Day
 * refuses every near stretch but a channel edge), and `channel` the channel
 * edges (ChartedShallowSpan.channelEdge), said apart. With channel edges
 * only, `stretches` is 0 and the worst fields repeat the channel's.
 */
export interface NearShallowWorst {
    clearanceM: number;
    depthM: number | null;
    requiredM: number;
}
export interface NearShallowSummary extends NearShallowWorst {
    stretches: number;
    red?: number;
    channel?: NearShallowWorst & { stretches: number };
}

export function nearShallowSummary(spans: readonly ChartedShallowSpan[] | undefined): NearShallowSummary | undefined {
    let open: (NearShallowWorst & { stretches: number; red: number }) | undefined;
    let channel: (NearShallowWorst & { stretches: number }) | undefined;
    const worse = (n: NearShallowWorst, w: NearShallowWorst | undefined): boolean =>
        !w || n.requiredM - n.clearanceM > w.requiredM - w.clearanceM;
    // A piece that starts where the last piece of its kind ended (route
    // parameter: segment + fraction) is the same stretch (fix-up review,
    // 2026-10-03): the engine cuts a stretch where the band beside it changes
    // and at every vertex, and Rivergate's 7 channel-edge pieces, said as "on
    // 6 more stretches", were 2 places.
    let openEnd = NaN;
    let channelEnd = NaN;
    let openRed = false;
    const joins = (s: ChartedShallowSpan, end: number): boolean => Math.abs(s.startSeg + s.startT - end) < 1e-6;
    for (const s of Array.isArray(spans) ? spans : []) {
        const n = s?.near;
        if (!n || !Number.isFinite(n.clearanceM) || !Number.isFinite(n.requiredM)) continue;
        const depthM = typeof n.depthM === 'number' && Number.isFinite(n.depthM) ? n.depthM : null;
        const w = { clearanceM: n.clearanceM, depthM, requiredM: n.requiredM };
        if (s.channelEdge === true) {
            if (worse(w, channel)) channel = { ...w, stretches: channel?.stretches ?? 0 };
            if (!joins(s, channelEnd)) channel!.stretches++;
            channelEnd = s.endSeg + s.endT;
            continue;
        }
        if (worse(w, open)) open = { ...w, stretches: open?.stretches ?? 0, red: open?.red ?? 0 };
        if (!joins(s, openEnd)) {
            open!.stretches++;
            openRed = false;
        }
        if (nearSpanBlocks(s) && !openRed) {
            open!.red++;
            openRed = true;
        }
        openEnd = s.endSeg + s.endT;
    }
    if (!open && !channel) return undefined;
    const base = open ?? { ...channel!, stretches: 0, red: 0 };
    return {
        stretches: base.stretches,
        clearanceM: base.clearanceM,
        depthM: base.depthM,
        requiredM: base.requiredM,
        ...(base.red > 0 ? { red: base.red } : {}),
        ...(channel ? { channel } : {}),
    };
}

/** "water charted to dry 1.5 m" / "water charted 2.0 m". */
function nearWater(d: number | null): string {
    return typeof d === 'number' && Number.isFinite(d)
        ? d < 0
            ? `water charted to dry ${(-d).toFixed(1)} m`
            : `water charted ${d.toFixed(1)} m`
        : 'charted water with no depth given';
}

/** " (and on 2 more stretches)". */
const moreStretches = (n: number): string => (n > 0 ? ` (and on ${n} more stretch${n > 1 ? 'es' : ''})` : '');

/** The caveat for nearShallowSummary, in the route notes' words. */
function nearShallowCaveat(near: NearShallowSummary | undefined): string | null {
    if (!near || !(near.stretches > 0) || !Number.isFinite(near.clearanceM) || !Number.isFinite(near.requiredM))
        return null;
    const water = nearWater(near.depthM);
    const where =
        near.clearanceM < 1 ? `runs on the edge of ${water}` : `passes ${Math.round(near.clearanceM)} m from ${water}`;
    return `This route ${where} — closer than the ${Math.round(near.requiredM)} m the router keeps off it${moreStretches(near.stretches - 1)}. Check the chart there before you go.`;
}

/** The caveat for a summary's channel edges (round-3 fix-up, 2026-10-03):
 *  amber, never a refusal — the marks own the line there. */
function channelEdgeCaveat(near: NearShallowSummary | undefined): string | null {
    const c = near?.channel;
    if (!c || !(c.stretches > 0) || !Number.isFinite(c.clearanceM) || !Number.isFinite(c.requiredM)) return null;
    const water = nearWater(c.depthM);
    const where =
        c.clearanceM < 1
            ? `on the edge of ${water}`
            : `${Math.round(c.clearanceM)} m from ${water}, inside the ${Math.round(c.requiredM)} m the router keeps off it elsewhere`;
    return `In the marked channel this route runs close to the edge of the channel's charted shallows: ${where}${moreStretches(c.stretches - 1)}. Keep to the middle of the channel.`;
}

/**
 * How far short of its clearance a channel edge must fall to title the route
 * notes (fix-up review, 2026-10-03): Tangalooma's notice was titled 'Close to
 * the channel edge' for 28.2 m against the 30 m kept, 1.6 m short in its own
 * dredged channel, over its survey notes. A marginal edge is still named in
 * the notes; it titles them only when nothing else is said.
 */
export const CHANNEL_EDGE_HEADLINE_SHORT_M = 5;

function channelEdgeHeadlines(near: NearShallowSummary | undefined): boolean {
    const c = near?.channel;
    return !!c && c.requiredM - c.clearanceM >= CHANNEL_EDGE_HEADLINE_SHORT_M;
}

/** The eight ways a route can bend, in words. */
const BEND_WAYS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** Metres in a skipper's words: "1.3 km", "450 m". */
const distanceWords = (m: number): string =>
    m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`;

/**
 * What the route says about its survey quality (owner decision 9,
 * 2026-09-30: "Yes, amber on the route"): how much of it the survey may be out
 * by more than the keel margin, how much is old or ungraded, and — decision
 * 8's way — the charts whose survey quality was not checked at all.
 *
 * The colour words follow what the view actually draws (round-3 review,
 * 2026-09-30): "(amber dashes)" only when all of it is dashed, "(amber dashes
 * where the line is not already red or amber)" when some is, "(inside the red
 * or amber stretches)" when none is — and no colour at all where the view
 * draws no survey dashes (a saved plan, the tracer, the planner summary).
 * Owner decision 10 (2026-09-30) made the survey stretches DASHES — solid
 * amber is water that needs tide — and a stretch under a shallow one may be
 * amber rather than red once the tide is in; the words were "(marked amber)",
 * "(marked amber where it is not already red)" and "(under the red)". DOTS
 * since the round-4 review (2026-09-30): the dashes were the lead overlay's
 * own needs-tide pattern.
 */
const amberWords = (totalM: number, amberM: number | undefined): string => {
    if (amberM === undefined) return '';
    if (amberM <= 1) return ' (inside the red or amber stretches)';
    return amberM >= totalM - Math.max(25, totalM * 0.02)
        ? ' (amber dots)'
        : ' (amber dots where the line is not already red or amber)';
};

export function surveyCaveats(
    input: Pick<InshoreRouteNoticeInput, 'surveyRuns' | 'surveyUncheckedCells' | 'surveyAmber'>,
): string[] {
    const out: string[] = [];
    const runs = Array.isArray(input.surveyRuns) ? input.surveyRuns : [];
    let marginM = 0;
    let worstErrorM = 0;
    let poorM = 0;
    for (const r of runs) {
        if (!r || typeof r.lengthM !== 'number') continue;
        if (r.reason === 'survey-margin') {
            marginM += r.lengthM;
            if (typeof r.errorM === 'number' && r.errorM > worstErrorM) worstErrorM = r.errorM;
        } else if (r.reason === 'survey-poor' || r.reason === 'survey-ungraded') poorM += r.lengthM;
    }
    if (marginM > 0) {
        out.push(
            `Survey may be out by up to ${worstErrorM.toFixed(1)} m on ${distanceWords(marginM)} of this route — more than your keel margin there${amberWords(marginM, input.surveyAmber?.marginM)}. Tide windows there are worked from the charted depth.`,
        );
    }
    if (poorM > 0) {
        out.push(
            `Old or ungraded survey on ${distanceWords(poorM)} of this route — the charted depth there has no stated accuracy${amberWords(poorM, input.surveyAmber?.poorM)}.`,
        );
    }
    const unchecked = input.surveyUncheckedCells?.length ?? 0;
    if (unchecked > 0) {
        out.push(
            `Survey quality not checked on ${unchecked === 1 ? 'this chart' : `${unchecked} of the charts on this route`} — its accuracy is not in the chart data.`,
        );
    }
    return out;
}

/**
 * What the route itself must say, whatever notice is showing (fix-up,
 * 2026-09-30). Owner decision 8: while a chart carries no bridge / overhead
 * line layers (every installed cell is schema 1 today) the route is routed as
 * normal — only Thalassa's own bridge list (public/notices/bridges-au.json)
 * gates it — and carries a plain warning. That warning was one slot in a
 * transient band: the inland-trim notice and the NtM lock outranked it, and
 * the later "Notice to Mariners on this route" advisory overwrote it. The
 * planner now keeps these on a line of their own (usePassagePlanner
 * routeCaveats → PassageBanner) that no other notice replaces, and appends
 * them to whichever notice wins. And a pin off the water (decision 7) is said
 * here too — nothing showed it — and, since round 3 (2026-09-30), the
 * route's survey quality (decision 9, surveyCaveats).
 */
export function inshoreRouteCaveats(input: Omit<InshoreRouteNoticeInput, 'ntmLockBanner' | 'stateMaskOk'>): string[] {
    // Owner decision 2 (Phase 2b, 2026-10-01): canal water from the phone's
    // offline pack or the Pi's stale copy is said first, with its date and
    // the OSM credit — it is the water the whole route stands on.
    const out: string[] = [...waterPackCaveats(input.waterPack)];
    // Package 125-05 (Shane, 2026-10-08): the route goes through water no
    // tide clears where there is no deeper way round, red — said next, each
    // stretch with its charted depth against draft + UKC, instead of the
    // refusal that used to stand in for the whole route.
    const dry = dryRunCaveat(input.dryRuns);
    if (dry) out.push(dry);
    // Package 125-05b (Shane, 2026-10-08: "tried to do a route from the
    // newport canals to tangalooma, i got some message about it being dry at
    // both ends????"): a pin on dry ground gets its route, the tail to it red
    // — one sentence for each such end, in place of "the route stops at its
    // edge": the stretch, its depth against the need, and when the boat
    // floats over it on today's tide.
    const tailed = new Set<'origin' | 'destination'>();
    for (const end of ['origin', 'destination'] as const) {
        const run = (input.dryRuns ?? []).find((r) => r?.pin?.end === end);
        const words = pinDryRunCaveat(run, input.pinOffWater?.[end], input.nowMs);
        if (!words) continue;
        out.push(words);
        tailed.add(end);
    }
    const gaps = input.structuresUnknownCells?.length ?? 0;
    if (gaps > 0) {
        out.push(
            `Bridges and power lines not checked on ${gaps === 1 ? 'this chart' : `${gaps} of the charts on this route`} — known bridges are. Check the chart for anything overhead against your air draft before you pass under it.`,
        );
    }
    // Decision 7's limit is never drying (round 3, 2026-09-30): the route
    // stops at the edge of the bank or the land and says so — a pin on land
    // always, and since 125-05b a pin on dry ground only where no tail reaches
    // it without crossing land (its tail's sentence is said above).
    const pin = (which: 'departure' | 'destination', off: PinOffWater | undefined): void => {
        if (tailed.has(which === 'departure' ? 'origin' : 'destination')) return;
        const verb = which === 'departure' ? 'starts' : 'stops';
        if (off === 'drying') {
            out.push(`Your ${which} pin is on a drying bank — the route ${verb} at its edge. It dries at low water.`);
        } else if (off === 'land') {
            out.push(`Your ${which} pin is on charted land — the route ${verb} at the water's edge.`);
        } else if (off === 'no-tide') {
            // Owner decision 11 (2026-10-01): water that never dries but no
            // tide the app knows clears for this boat.
            out.push(
                `Your ${which} pin is in water no tide clears for your boat — the route ${verb} at the edge of water a tide does.`,
            );
        }
    };
    pin('departure', input.pinOffWater?.origin);
    // The inland-trim notice already says the destination pin is on land.
    pin('destination', input.destinationInlandTrimM ? undefined : input.pinOffWater?.destination);
    // A pin in shallow charted water goes direct, amber (Shane, 2026-10-03).
    // Where no straight line passes, its tail keeps the charted way, and the
    // route says why — the leg review names the pin's depth either way.
    const shallowPin = (which: 'departure' | 'destination', tail: PinTail | undefined): void => {
        if (!tail || tail.direct || !Number.isFinite(tail.depthM) || !Number.isFinite(tail.needsM)) return;
        const [verb, way, outIn] = which === 'departure' ? ['starts', 'leaves', 'out'] : ['ends', 'arrives', 'in'];
        // The tide is the tail's own: its shallowest water may lie off the pin.
        const least =
            typeof tail.leastM === 'number' && Number.isFinite(tail.leastM) && tail.leastM < tail.depthM
                ? ` (its way ${outIn} crosses ${tail.leastM.toFixed(1)} m)`
                : '';
        out.push(
            `Your ${which} pin is in ${tail.depthM.toFixed(1)} m charted water — the route ${verb} there and needs +${tail.needsM.toFixed(1)} m of tide${least}. It ${way} through its charted water, not in a straight line: a straight line would cross ${tail.why ?? 'water the router keeps closed'}.`,
        );
    };
    shallowPin('departure', input.pinTail?.origin);
    shallowPin('destination', input.pinTail?.destination);
    // Too close to a shallow band (the real-chart check, 2026-10-03), and
    // close to a channel's edge (round-3 fix-up, 2026-10-03).
    const near = nearShallowCaveat(input.nearShallow);
    if (near) out.push(near);
    const edge = channelEdgeCaveat(input.nearShallow);
    if (edge) out.push(edge);
    // Why the route leaves the straight line (Shane, 2026-10-04: "unsure why
    // waypoints 5,6,7 would go that way and not straight ahead"), in one plain
    // line: where — the turn's position as Review lists a waypoint's (the
    // waypoints shown are a sparse, editable index over the route's points,
    // so a number could name the wrong one) — which way, for what water, what
    // it costs and what it saves.
    const bend = input.depthBend;
    if (bend && [bend.routeM, bend.straightM, bend.extraM, bend.needM].every(Number.isFinite)) {
        const [lon, lat] = bend.at;
        const deg =
            (Math.atan2((bend.via[0] - lon) * Math.cos((lat * Math.PI) / 180), bend.via[1] - lat) * 180) / Math.PI;
        const turn = `At ${formatLatDegMin(lat)} ${formatLonDegMin(lon)} the route bends ${BEND_WAYS[Math.round((deg + 360) / 45) % 8]}`;
        const [route, straight] = [distanceWords(bend.routeM), distanceWords(bend.straightM)];
        const further = `${distanceWords(bend.extraM)} further, but ${route}`;
        out.push(
            bend.deepM !== undefined && bend.overM !== undefined
                ? `${turn} to reach charted ${bend.deepM.toFixed(1)} m water${bend.sooner ? ' sooner' : ''}: ${further} over ${bend.overM.toFixed(1)} m water instead of ${straight} straight on.`
                : `${turn} off the straight line to cross less water charted under the ${bend.needM.toFixed(1)} m you need: ${further} of it instead of ${straight} straight on.`,
        );
    }
    // Owner decision 11 (2026-10-01): where the route crosses water a tide
    // must clear and no tide was loaded for that place (offline, or a partial
    // load — fix-up, 2026-10-01), the router could not rule out water no tide
    // clears — one plain line, never a refusal.
    if (input.tideCheck === 'not-loaded') {
        out.push('Tide times not loaded — this route may cross water no tide clears. Check before you go.');
    }
    out.push(...surveyCaveats(input));
    return out;
}

export function inshoreRouteNotice(input: InshoreRouteNoticeInput): PassageNotice | null {
    const caveats = inshoreRouteCaveats(input);
    const withCaveats = (n: PassageNotice): PassageNotice =>
        caveats.length === 0 ? n : { ...n, message: `${n.message} ${caveats.join(' ')}` };
    if (!input.stateMaskOk) {
        return withCaveats({
            severity: 'warn',
            title: 'Route shown — verification incomplete',
            message:
                'The inshore router returned missing or mismatched safety classifications. The dashed red line cannot be saved, exported or shared; retry after charts are synced.',
        });
    }
    if (input.destinationInlandTrimM) {
        return withCaveats({
            severity: 'warn',
            title: 'Destination is inland',
            message: `The pin sits ~${Math.round(input.destinationInlandTrimM)} m onto charted land — the route ends at the nearest navigable water. Drop the pin on the waterway for a berth-accurate route.`,
        });
    }
    if (input.ntmLockBanner) return withCaveats(input.ntmLockBanner);
    if (caveats.length === 0) return null;
    // Charts converted before schema 2 carry no bridge / overhead-line layers
    // (InshoreRouteResult.structuresUnknownCells): the route was not checked
    // against their charted clearances — only against the bridges Thalassa
    // lists itself, which still block. Owner decision 8 (2026-09-30): route as
    // normal and say so plainly — never refuse for it — in a skipper's words.
    const gaps = input.structuresUnknownCells?.length ?? 0;
    const offWater = !!(input.pinOffWater?.origin || input.pinOffWater?.destination);
    const pack = waterPackCaveats(input.waterPack).length > 0;
    // A shallow pin's tail that cannot run direct is a note of its own
    // (fix-up review, 2026-10-03: alone it was titled 'Survey quality').
    const shallowPinNote = [input.pinTail?.origin, input.pinTail?.destination].some(
        (t) => !!t && !t.direct && Number.isFinite(t.depthM) && Number.isFinite(t.needsM),
    );
    // Red where no tide clears it (125-05) — unless it is red for want of
    // tide data because the tide times did not load: that title says why.
    const dryTitle =
        input.tideCheck === 'not-loaded' && input.dryRuns?.some((r) => r.tide === null)
            ? null
            : dryRunNoticeTitle(input.dryRuns);
    return {
        severity: 'warn',
        title: dryTitle
            ? dryTitle
            : gaps > 0
              ? 'Bridges and power lines not checked'
              : offWater
                ? 'Pin off the water'
                : input.tideCheck === 'not-loaded'
                  ? 'Tide times not loaded'
                  : pack
                    ? input.waterPack?.source === 'none'
                        ? 'Harbour water not saved'
                        : 'Saved harbour water'
                    : shallowPinNote
                      ? 'Shallow pin'
                      : nearShallowCaveat(input.nearShallow)
                        ? 'Close to shallow water'
                        : channelEdgeCaveat(input.nearShallow) &&
                            (channelEdgeHeadlines(input.nearShallow) || surveyCaveats(input).length === 0)
                          ? 'Close to the channel edge'
                          : 'Survey quality',
        message: caveats.join(' '),
    };
}

/**
 * A refusal no other router may draw past (decision 11 fix-up, 2026-10-01):
 * a bridge or power line the mast cannot clear ('air-draft-blocked'). The
 * bathymetric, isochrone and corridor routers know nothing of it, so a plan
 * they drew in its place went under the very bridge the refusal named.
 *
 * Water no tide clears ('no-tide-clears') is no longer one (package 125-05;
 * Shane, 2026-10-08: "better we just have red at the "dry" zones, rather than
 * just shit caning the whole route"): the inshore router routes through it,
 * red and named (InshoreRouteResult.dryRuns), and never refuses for it.
 */
export function isFinalInshoreRefusal(code: unknown): boolean {
    return code === 'air-draft-blocked';
}

/** A saved route's water-pack facts (inshoreRouteToGeoJSON), checked;
 *  undefined when malformed — no words rather than wrong ones. */
function savedWaterPack(v: unknown): WaterPackUse | undefined {
    if (!v || typeof v !== 'object') return undefined;
    const w = v as { source?: unknown; dataAsOf?: unknown; missing?: unknown; offline?: unknown };
    if (w.source !== 'pack' && w.source !== 'pi-stale' && w.source !== 'none') return undefined;
    const ends: WaterPackEnd[] = ['departure', 'destination'];
    const missing = Array.isArray(w.missing) ? ends.filter((e) => (w.missing as unknown[]).includes(e)) : [];
    return {
        source: w.source,
        ...(typeof w.dataAsOf === 'number' && Number.isFinite(w.dataAsOf) ? { dataAsOf: w.dataAsOf } : {}),
        missing,
        ...(w.offline === true ? { offline: true as const } : {}),
    };
}

/** A saved route's shallow-pin facts (inshoreRouteToGeoJSON), checked;
 *  undefined when malformed — no words rather than wrong ones. */
function savedPinTail(v: unknown): PinTail | undefined {
    if (!v || typeof v !== 'object') return undefined;
    const t = v as { depthM?: unknown; needsM?: unknown; leastM?: unknown; direct?: unknown; why?: unknown };
    const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
    if (!finite(t.depthM) || !finite(t.needsM) || typeof t.direct !== 'boolean') return undefined;
    return {
        depthM: t.depthM,
        needsM: t.needsM,
        ...(finite(t.leastM) ? { leastM: t.leastM } : {}),
        direct: t.direct,
        ...(typeof t.why === 'string' && t.why.trim() !== '' ? { why: t.why } : {}),
    };
}

/** A saved route's near-shallow summary (inshoreRouteToGeoJSON), checked;
 *  undefined when malformed — no words rather than wrong ones. */
function savedNearShallow(v: unknown): NearShallowSummary | undefined {
    if (!v || typeof v !== 'object') return undefined;
    const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
    const worst = (x: unknown): NearShallowWorst | undefined => {
        const n = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        if (!finite(n.clearanceM) || !finite(n.requiredM)) return undefined;
        return { clearanceM: n.clearanceM, depthM: finite(n.depthM) ? n.depthM : null, requiredM: n.requiredM };
    };
    const n = v as { stretches?: unknown; red?: unknown; channel?: unknown };
    const top = worst(v);
    if (!finite(n.stretches) || !top) return undefined;
    const c = n.channel as { stretches?: unknown } | undefined;
    const channel = c && finite(c.stretches) ? worst(c) : undefined;
    return {
        stretches: n.stretches,
        ...top,
        ...(finite(n.red) && n.red > 0 ? { red: n.red } : {}),
        ...(channel ? { channel: { ...channel, stretches: (c as { stretches: number }).stretches } } : {}),
    };
}

/**
 * A saved route's near stretches themselves (inshoreRouteToGeoJSON
 * nearShallowSpans; round-3 fix-up, 2026-10-03), checked, as the summary the
 * live route said — undefined when absent or malformed (the saved summary
 * then speaks, as before).
 */
function savedNearShallowSpans(v: unknown): NearShallowSummary | undefined {
    if (!Array.isArray(v)) return undefined;
    const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
    const spans: ChartedShallowSpan[] = [];
    for (const x of v) {
        if (!x || typeof x !== 'object') return undefined;
        const s = x as Record<string, unknown>;
        const near = s.near as Record<string, unknown> | undefined;
        if (!finite(s.startSeg) || !finite(s.startT) || !finite(s.endSeg) || !finite(s.endT) || !finite(s.minDepthM))
            return undefined;
        if (!near || typeof near !== 'object' || !finite(near.clearanceM) || !finite(near.requiredM)) return undefined;
        spans.push({
            startSeg: s.startSeg,
            startT: s.startT,
            endSeg: s.endSeg,
            endT: s.endT,
            minDepthM: s.minDepthM,
            ...(s.tideLiftable === true ? { tideLiftable: true } : {}),
            ...(s.tideUnknown === true ? { tideUnknown: true } : {}),
            ...(s.channelEdge === true ? { channelEdge: true } : {}),
            near: {
                clearanceM: near.clearanceM,
                depthM: finite(near.depthM) ? near.depthM : null,
                requiredM: near.requiredM,
            },
        });
    }
    return nearShallowSummary(spans);
}

/**
 * The caveats a SAVED inshore route carries, for a plan shown again (round 3,
 * 2026-09-30): decision 8's bridges, a pin off the water and decision 9's
 * survey quality were kept with the plan (routeGeoJSON properties,
 * __inshoreRouting.caveats) but nothing showed them once the planner's banner
 * was gone. Rebuilt from the saved route's own facts when it has them — the
 * wording stays current — else the saved lines as written. Malformed saved
 * data gives none rather than breaking the page.
 */
export function savedInshoreRouteCaveats(
    plan:
        | {
              routeGeoJSON?: { properties?: unknown } | null;
              __inshoreRouting?: { status?: string; caveats?: unknown; error?: unknown; errorCode?: unknown } | null;
          }
        | null
        | undefined,
    /** The clock a pin tail's "today's tide" is read by; now when absent. */
    nowMs?: number,
): string[] {
    if (!plan) return [];
    const props = plan.routeGeoJSON?.properties;
    const saved = plan.__inshoreRouting;
    if (props && typeof props === 'object' && (props as { source?: unknown }).source === 'inshore-router') {
        const p = props as Record<string, unknown>;
        // A plan whose chart facts stayed aboard (services/chartFacts, 127-C-b)
        // says the number-free lines it was saved with.
        if (p.chartFacts === 'aboard-only' && saved?.status === 'success' && Array.isArray(saved.caveats))
            return saved.caveats.filter((c): c is string => typeof c === 'string');
        const strings = (v: unknown): string[] | undefined =>
            Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
        const off = p.pinOffWater as { origin?: unknown; destination?: unknown } | undefined;
        const side = (v: unknown): PinOffWater | undefined =>
            v === 'land' || v === 'drying' || v === 'no-tide' ? v : undefined;
        const tails = p.pinTail as { origin?: unknown; destination?: unknown } | undefined;
        return inshoreRouteCaveats({
            structuresUnknownCells: strings(p.structuresUnknownCells),
            pinOffWater:
                off && typeof off === 'object'
                    ? { origin: side(off.origin), destination: side(off.destination) }
                    : undefined,
            // A shallow pin whose tail is not direct (Shane, 2026-10-03).
            pinTail:
                tails && typeof tails === 'object'
                    ? { origin: savedPinTail(tails.origin), destination: savedPinTail(tails.destination) }
                    : undefined,
            ...(p.tideCheck === 'not-loaded' ? { tideCheck: 'not-loaded' as const } : {}),
            surveyRuns: Array.isArray(p.surveyRuns) ? (p.surveyRuns as SurveyRunInfo[]) : undefined,
            surveyUncheckedCells: strings(p.surveyUncheckedCells),
            waterPack: savedWaterPack(p.waterPack),
            // Too close to a shallow band (fix-up review, 2026-10-03): from
            // the stretches themselves since the round-3 fix-up, else the
            // summary an older save kept.
            nearShallow: savedNearShallowSpans(p.nearShallowSpans) ?? savedNearShallow(p.nearShallow),
            // The dry stretches, red (package 125-05), a pin's tail among
            // them, its window kept (125-05b).
            dryRuns: savedDryRuns(p.dryRuns),
            ...(nowMs !== undefined ? { nowMs } : {}),
        });
    }
    // A final refusal is what the plan must say instead of a route (fix-up,
    // 2026-10-01): whole — the spot, its depth, the tide and the need. So is
    // a refusal for water no tide clears saved by build 124 or earlier
    // (review fix-up, 2026-10-09): that plan drew no route, and its refusal
    // is its only explanation until it is routed again.
    if (
        saved?.status === 'failed' &&
        (isFinalInshoreRefusal(saved.errorCode) || saved.errorCode === 'no-tide-clears') &&
        typeof saved.error === 'string' &&
        saved.error.trim() !== ''
    ) {
        return [saved.error];
    }
    if (saved?.status === 'success' && Array.isArray(saved.caveats)) {
        return saved.caveats.filter((c): c is string => typeof c === 'string' && c.trim() !== '');
    }
    return [];
}
