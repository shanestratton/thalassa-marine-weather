/**
 * ntmRouting — Notice-to-Mariners ROUTING PACKS: surveyed depths and virtual
 * marks hand-curated from a specific MSQ notice, injected into the inshore
 * router ONLY while (a) that exact notice is still the current one on the QLD
 * CKAN feed and (b) the skipper has explicitly acknowledged it for this
 * passage.
 *
 * This module deliberately breaks the localNotices doctrine ("notices never
 * touch routing") for ONE narrow, guarded class: bar-survey notices whose
 * coordinates and least depths MSQ publishes precisely so vessels can plan
 * with them (the Mooloolah REF marks are AIS virtual aids "promulgated to
 * facilitate a possible alternative route"). The guards, in order:
 *
 *   1. CURATED, never parsed live — zones/marks are hand-transcribed from the
 *      notice PDF + chartlet, keyed to the exact notice number.
 *   2. CURRENCY, fail-closed — a pack is only injectable while its noticeKey
 *      matches the freshest gazetteer-matched notice for its anchor on the
 *      CKAN feed, verified within MAX_VERIFY_AGE_MS. Superseded, unverifiable
 *      or offline-stale packs are NEVER injected (a week-old bar corridor is
 *      worse than none — bars move).
 *   3. OWNER OVERRIDE, account-scoped — current packs apply by default. A
 *      skipper can remove a pack from routing without silently changing the
 *      next signed-in account's safety policy.
 *   4. HONEST DEPTH, never preference — zones override chart depth with the
 *      notice's surveyed least depth (services/engine/navGrid.ts NTM pass).
 *      Sub-floor zones stay CAUTION (red, tide-window-chipped); they are
 *      priced by requiredRise (aStar cellCostMultiplier) so the router
 *      prefers the deepest surveyed water, but no zone is ever "preferred"
 *      and no depth is ever fabricated above the survey.
 */
import type { Feature, FeatureCollection, Position } from 'geojson';
import { loadQldNotices, qldNoticesFetchedAt, type QldNotice } from './qldNotices';
import { withDeadline } from '../utils/deadline';
import { createLogger } from '../utils/createLogger';
import { authScopedStorageKey, subscribeAuthIdentityScope } from './authIdentityScope';

const log = createLogger('ntmRouting');

export interface NtmZone {
    /** Human label for logs/chips, e.g. "white sector shoal". */
    label: string;
    /** Surveyed least depth in metres at LAT (from the notice text/chartlet). */
    depthM: number;
    /** Outer ring, [lon, lat]. Later zones stamp over earlier ones on overlap. */
    polygon: Position[];
}

export interface NtmMark {
    /** e.g. "BNE MRB REF 1" */
    name: string;
    lat: number;
    lon: number;
}

export interface NtmRoutingPack {
    /** Stable pack id (ack store key). */
    id: string;
    /** EXACT CKAN resource name of the source notice, e.g. "364 T of 2026". */
    noticeKey: string;
    /** Bump when zones/marks change without a new notice — joins the grid
     *  cache fingerprint so a re-transcription invalidates cached grids. */
    rev?: number;
    /** Gazetteer anchor label this notice files under (qldNotices GAZETTEER). */
    anchorLabel: string;
    /** Lowercase substring the live notice subject must contain to be "this" notice line. */
    subjectMatch: string;
    /**
     * BROADER lowercase substring for the supersession scan (defaults to
     * subjectMatch): ANY newer notice at the anchor whose subject contains
     * this kills the pack — so a reworded superseding notice ("Mooloolah
     * River entrance — depths") still revokes a pack keyed to "mooloolah
     * river bar". Adversarial-review fix: exact-line matching failed OPEN
     * on rewordings.
     */
    waterwayMatch?: string;
    title: string;
    /** Survey date shown to the skipper. */
    surveyed: string;
    /**
     * Zones in stamp order — SHALLOWEST first, most-specific (deepest
     * corridor) LAST so overlaps resolve to the corridor's surveyed depth.
     */
    zones: NtmZone[];
    /** Virtual AIS marks from the notice — DISPLAY always, routing never. */
    marks: NtmMark[];
    /**
     * The notice's alternative-route TRACK through its marks ([lon, lat]
     * chain). When the pack is current (and not user-removed) this is injected as a chart
     * transit (NAVLINE, acronym 'NAVLNE') so the route rides DEAD-ON through
     * the promulgated marks — same trust class as an ENC leading line: MSQ
     * drew it, we follow it. Depth honesty is preserved because the NTM
     * survey zones stamp AFTER the transit rescue and override its corridor
     * with the surveyed values.
     */
    trackline?: Position[];
    /** [minLon, minLat, maxLon, maxLat] of every zone/mark, for corridor tests. */
    bbox: [number, number, number, number];
}

/**
 * Mooloolah River bar — NtM 364 (T) of 2026, surveyed 1 July 2026.
 * Sector least depths from the notice text (1.4 white / 1.5 red / 2.0 green);
 * sector bands + alternative-route corridor transcribed against the ENC
 * entrance beacons (No 1 stbd −26.680206,153.132342 / No 2 port −26.679154,
 * 153.132654) and the notice's REF mark positions; corridor depth 2.5 m is
 * the FLOOR of chartlet Map S11-798's "over 2.5 m" shading bucket along the
 * REF2→REF1 line — conservative by construction.
 */
const MOOLOOLAH_BAR_2026_364: NtmRoutingPack = {
    id: 'mooloolah-bar',
    noticeKey: '364 T of 2026',
    rev: 1,
    anchorLabel: 'Mooloolaba',
    subjectMatch: 'mooloolah river bar',
    waterwayMatch: 'mooloolah',
    title: 'Mooloolah River bar — shoaling and dredging',
    surveyed: '1 July 2026',
    zones: [
        {
            label: 'white sector shoal',
            depthM: 1.4,
            polygon: [
                [153.132297, -26.680006],
                [153.13016, -26.679493],
                [153.130342, -26.678881],
                [153.132479, -26.679394],
                [153.132297, -26.680006],
            ],
        },
        {
            label: 'red sector shoal (east)',
            depthM: 1.5,
            polygon: [
                [153.132479, -26.679394],
                [153.130342, -26.678881],
                [153.13051, -26.678313],
                [153.132647, -26.678826],
                [153.132479, -26.679394],
            ],
        },
        {
            label: 'green sector edge (west)',
            depthM: 2.0,
            polygon: [
                [153.132129, -26.680574],
                [153.129992, -26.680061],
                [153.13016, -26.679493],
                [153.132297, -26.680006],
                [153.132129, -26.680574],
            ],
        },
        {
            label: 'alternative route (mouth→REF 2)',
            depthM: 2.5,
            polygon: [
                [153.132664, -26.680059],
                [153.131919, -26.680323],
                [153.131587, -26.679566],
                [153.132332, -26.679301],
                [153.132664, -26.680059],
            ],
        },
        {
            label: 'alternative route (REF 2→REF 1)',
            depthM: 2.5,
            polygon: [
                [153.132394, -26.680056],
                [153.129622, -26.682342],
                [153.129011, -26.681742],
                [153.131783, -26.679456],
                [153.132394, -26.680056],
            ],
        },
    ],
    marks: [
        { name: 'BNE MRB REF 1', lat: -(26 + 40.8675 / 60), lon: 153 + 7.8257 / 60 },
        { name: 'BNE MRB REF 2', lat: -(26 + 40.7927 / 60), lon: 153 + 7.9164 / 60 },
    ],
    // Entrance-mouth midpoint → REF 2 → REF 1 → 150 m seaward extension:
    // the promulgated alternative route, ridden dead-on while current.
    trackline: [
        [153.132498, -26.67968],
        [153 + 7.9164 / 60, -(26 + 40.7927 / 60)],
        [153 + 7.8257 / 60, -(26 + 40.8675 / 60)],
        [153.129317, -26.682042],
    ],
    bbox: [153.1288, -26.6825, 153.1329, -26.6781],
};

export const NTM_ROUTING_PACKS: readonly NtmRoutingPack[] = [MOOLOOLAH_BAR_2026_364];

// ── Currency (fail-closed) ───────────────────────────────────────────

/** Verified-freshness horizon: a CKAN check older than this cannot vouch a pack. */
export const MAX_VERIFY_AGE_MS = 48 * 60 * 60 * 1000;
/** Hard pack lifetime: past this age since the notice's own date the pack is
 *  dead regardless of what the feed says — active-bar surveys refresh on a
 *  weeks cadence, and a fully reworded superseding notice (one that no longer
 *  even names the waterway) would defeat the supersession scan below. The
 *  ceiling bounds that residual fail-open window. */
export const PACK_MAX_AGE_MS = 28 * 24 * 60 * 60 * 1000;

export type NtmPackStatus =
    | { status: 'current' }
    | { status: 'superseded'; liveNumber: string }
    | { status: 'unverified'; reason: string };

/** "DD/MM/YYYY" → epoch ms, NaN when unparsable. */
function parseDmy(dateStr: string): number {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateStr ?? '');
    if (!m) return Number.NaN;
    return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

/**
 * PURE currency check (exported for tests), fail-closed at every branch:
 *   1. the feed must have been fetched within MAX_VERIFY_AGE_MS;
 *   2. the pack's EXACT notice must still exist at its anchor;
 *   3. NO newer notice at the anchor may match waterwayMatch (broad scan —
 *      a reworded superseding notice still revokes);
 *   4. the pack's notice must be younger than PACK_MAX_AGE_MS (bounds the
 *      fully-reworded-supersession residual).
 */
export function resolvePackStatus(
    pack: NtmRoutingPack,
    notices: readonly QldNotice[],
    fetchedAtMs: number | null,
    nowMs: number,
): NtmPackStatus {
    if (fetchedAtMs === null || nowMs - fetchedAtMs > MAX_VERIFY_AGE_MS) {
        return { status: 'unverified', reason: 'notice feed not verified within 48 h' };
    }
    const atAnchor = notices.filter((n) => n.localityLabel === pack.anchorLabel);
    const own = atAnchor.find((n) => n.number.trim() === pack.noticeKey);
    if (!own) return { status: 'unverified', reason: 'pack notice not on the live feed' };
    const waterway = (pack.waterwayMatch ?? pack.subjectMatch).toLowerCase();
    const newer = atAnchor
        .filter((n) => n.createdMs > own.createdMs && n.subject.toLowerCase().includes(waterway))
        .sort((a, b) => b.createdMs - a.createdMs);
    if (newer.length > 0) return { status: 'superseded', liveNumber: newer[0].number };
    const ownDateMs = parseDmy(own.dateStr);
    if (Number.isNaN(ownDateMs)) return { status: 'unverified', reason: 'pack notice date unparsable' };
    if (nowMs - ownDateMs > PACK_MAX_AGE_MS) {
        return { status: 'unverified', reason: 'pack notice older than 28 days — re-curation required' };
    }
    return { status: 'current' };
}

/** Bound + cache: one verdict per pack per window, so neither the compute
 *  path nor the render path ever re-parses the feed blob or waits on a dead
 *  marine-LTE socket (adversarial-review criticals: the un-deadlined CKAN
 *  fetch could stall route paint and the popup for minutes). */
const NTM_FEED_DEADLINE_MS = 8_000;
const STATUS_CACHE_MS = 3 * 60 * 1000;
const statusCache = new Map<string, { status: NtmPackStatus; atMs: number }>();

/** Live currency check — loads the (12 h-cached) CKAN feed. Fail-closed. */
export async function ntmPackStatus(pack: NtmRoutingPack): Promise<NtmPackStatus> {
    const hit = statusCache.get(pack.id);
    if (hit && Date.now() - hit.atMs < STATUS_CACHE_MS) return hit.status;
    let status: NtmPackStatus;
    try {
        const notices = await withDeadline(loadQldNotices(), NTM_FEED_DEADLINE_MS, 'ntm notice feed');
        status = resolvePackStatus(pack, notices, qldNoticesFetchedAt(), Date.now());
    } catch (err) {
        status = { status: 'unverified', reason: err instanceof Error ? err.message : String(err) };
    }
    statusCache.set(pack.id, { status, atMs: Date.now() });
    return status;
}

// ── Opt-out (owner default: current notices APPLY automatically) ─────
//
// Shane 2026-07-02, on the water: "the two virtual markers at the mouth —
// the route should be following those." The per-passage acknowledgment
// ceremony was the wrong gate for the field: a CURRENT notice's surveyed
// depths and alternative-route transit now apply to routing by default
// (currency stays fail-closed: exact notice on the feed, 28-day ceiling,
// 48-h verify). The notice popup offers "Remove from routing" for a
// skipper who disagrees with the pack; the route-crossing banner still
// pushes reading the notice itself.

const OPTOUT_KEY = 'thalassa_ntm_optout_v1';
/** window event fired when applied-state changes — the planner recomputes on it. */
export const NTM_ACK_EVENT = 'thalassa:ntm-ack-changed';

function loadOptOuts(): Record<string, boolean> {
    try {
        const raw = localStorage.getItem(authScopedStorageKey(OPTOUT_KEY));
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        // A corrupted store must degrade to "nothing opted out", never throw
        // through the popup/render paths.
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, boolean>)
            : {};
    } catch {
        return {};
    }
}

export function isPackOptedOut(pack: NtmRoutingPack): boolean {
    return loadOptOuts()[pack.id] === true;
}

export function setPackOptedOut(pack: NtmRoutingPack, out: boolean): void {
    try {
        const opts = loadOptOuts();
        if (out) opts[pack.id] = true;
        else delete opts[pack.id];
        localStorage.setItem(authScopedStorageKey(OPTOUT_KEY), JSON.stringify(opts));
    } catch {
        /* quota — worst case the default (applied) persists */
    }
    log.warn(`[ntmRouting] ${pack.id} ${out ? 'REMOVED from routing by user' : 're-applied to routing'}`);
    try {
        window.dispatchEvent(new CustomEvent(NTM_ACK_EVENT));
    } catch {
        /* non-browser env */
    }
}

// A mounted planner must immediately recompute when auth changes because the
// incoming skipper has an independent fail-safe opt-out policy.
subscribeAuthIdentityScope(() => {
    try {
        window.dispatchEvent(new CustomEvent(NTM_ACK_EVENT));
    } catch {
        /* non-browser env */
    }
});

// ── Injection + render support ───────────────────────────────────────

const bboxIntersects = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** Packs whose bbox intersects the routing corridor, with live status + opt-out. */
export async function packsForCorridor(
    corridorBbox: [number, number, number, number],
): Promise<{ pack: NtmRoutingPack; status: NtmPackStatus; optedOut: boolean }[]> {
    const hits = NTM_ROUTING_PACKS.filter((p) => bboxIntersects(p.bbox, corridorBbox));
    return Promise.all(
        hits.map(async (pack) => ({ pack, status: await ntmPackStatus(pack), optedOut: isPackOptedOut(pack) })),
    );
}

/**
 * Zone features to inject as merged.NTMZONE for the engine — CURRENT packs
 * apply by default (owner call 2026-07-02); a user opt-out removes one.
 * Every skip is device-logged so a missing injection is diagnosable from
 * the passage log.
 */
export async function activeNtmZonesFor(
    corridorBbox: [number, number, number, number],
): Promise<{ features: Feature[]; tracklines: Feature[]; packIds: string[] }> {
    const features: Feature[] = [];
    const tracklines: Feature[] = [];
    const packIds: string[] = [];
    for (const { pack, status, optedOut } of await packsForCorridor(corridorBbox)) {
        if (status.status !== 'current') {
            log.warn(
                `[ntmRouting] ${pack.id} NOT injected — ${status.status}${
                    status.status === 'superseded' ? ` by "${status.liveNumber}"` : `: ${status.reason}`
                }`,
            );
            continue;
        }
        if (optedOut) {
            log.warn(`[ntmRouting] ${pack.id} current but REMOVED by user — advisory only`);
            continue;
        }
        for (const z of pack.zones) {
            if (!(z.depthM > 0)) continue; // never inject a drying survey as water
            features.push({
                type: 'Feature',
                properties: {
                    _class: 'ntm-survey',
                    depthM: z.depthM,
                    // rev joins the grid cache fingerprint (navGridCacheKey) so a
                    // re-transcription of the same notice invalidates cached grids.
                    _noticeKey: `${pack.noticeKey}#r${pack.rev ?? 1}`,
                    _label: z.label,
                },
                geometry: { type: 'Polygon', coordinates: [z.polygon] },
            });
        }
        if (pack.trackline && pack.trackline.length >= 2) {
            tracklines.push({
                type: 'Feature',
                properties: {
                    // acronym 'NAVLNE' puts it in the chart-transit trust class:
                    // Pass 5b rides it preferred and may resolve land-paint
                    // conflicts along it — MSQ promulgated this exact line.
                    acronym: 'NAVLNE',
                    _source: 'ntm-pack',
                    _noticeKey: `${pack.noticeKey}#r${pack.rev ?? 1}`,
                },
                geometry: { type: 'LineString', coordinates: pack.trackline },
            });
        }
        packIds.push(pack.id);
        log.warn(
            `[ntmRouting] INJECTING ${pack.zones.length} surveyed zone(s)${pack.trackline ? ' + alternative-route transit' : ''} from "${pack.noticeKey}" (${pack.id})`,
        );
    }
    return { features, tracklines, packIds };
}

/** Point-in-zone test for the render-side lock styling. */
export function pointInPack(lon: number, lat: number, pack: NtmRoutingPack): boolean {
    for (const z of pack.zones) {
        const ring = z.polygon;
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i];
            const [xj, yj] = ring[j];
            if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) return true;
    }
    return false;
}

export const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
