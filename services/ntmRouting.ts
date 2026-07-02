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
 *   3. ACKNOWLEDGMENT, per-passage — an explicit "apply to routing" tap in
 *      the notice popup, stored per noticeKey with a 24 h TTL. Reading the
 *      PDF alone changes nothing; a superseding notice self-revokes the ack.
 *   4. HONEST DEPTH, never preference — zones override chart depth with the
 *      notice's surveyed least depth (services/engine/navGrid.ts NTM pass).
 *      Sub-floor zones stay CAUTION (red, tide-window-chipped); they are
 *      priced by requiredRise (aStar cellCostMultiplier) so the router
 *      prefers the deepest surveyed water, but no zone is ever "preferred"
 *      and no depth is ever fabricated above the survey.
 */
import type { Feature, FeatureCollection, Position } from 'geojson';
import { loadQldNotices, qldNoticesFetchedAt, type QldNotice } from './qldNotices';
import { createLogger } from '../utils/createLogger';

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
    /** Gazetteer anchor label this notice files under (qldNotices GAZETTEER). */
    anchorLabel: string;
    /** Lowercase substring the live notice subject must contain to be "this" notice line. */
    subjectMatch: string;
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
    anchorLabel: 'Mooloolaba',
    subjectMatch: 'mooloolah river bar',
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
    bbox: [153.1288, -26.6825, 153.1329, -26.6781],
};

export const NTM_ROUTING_PACKS: readonly NtmRoutingPack[] = [MOOLOOLAH_BAR_2026_364];

// ── Currency (fail-closed) ───────────────────────────────────────────

/** Verified-freshness horizon: a CKAN check older than this cannot vouch a pack. */
export const MAX_VERIFY_AGE_MS = 48 * 60 * 60 * 1000;

export type NtmPackStatus =
    | { status: 'current' }
    | { status: 'superseded'; liveNumber: string }
    | { status: 'unverified'; reason: string };

/**
 * PURE currency check (exported for tests): the pack is current iff the
 * freshest live notice for its anchor whose subject matches subjectMatch has
 * EXACTLY the pack's notice number, and the feed was fetched recently enough
 * to trust. Anything else fails closed.
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
    const line = notices
        .filter((n) => n.localityLabel === pack.anchorLabel && n.subject.toLowerCase().includes(pack.subjectMatch))
        .sort((a, b) => b.createdMs - a.createdMs);
    if (line.length === 0) return { status: 'unverified', reason: 'no matching live notice on the feed' };
    if (line[0].number.trim() === pack.noticeKey) return { status: 'current' };
    return { status: 'superseded', liveNumber: line[0].number };
}

/** Live currency check — loads the (12 h-cached) CKAN feed. Fail-closed. */
export async function ntmPackStatus(pack: NtmRoutingPack): Promise<NtmPackStatus> {
    try {
        const notices = await loadQldNotices();
        return resolvePackStatus(pack, notices, qldNoticesFetchedAt(), Date.now());
    } catch (err) {
        return { status: 'unverified', reason: err instanceof Error ? err.message : String(err) };
    }
}

// ── Acknowledgment (per-passage, per-notice) ─────────────────────────

const ACK_KEY = 'thalassa_ntm_ack_v1';
/** Per-passage horizon: an ack older than this no longer injects. */
export const ACK_TTL_MS = 24 * 60 * 60 * 1000;
/** window event fired when an ack changes — the planner recomputes on it. */
export const NTM_ACK_EVENT = 'thalassa:ntm-ack-changed';

interface AckEntry {
    noticeKey: string;
    ackMs: number;
}

function loadAcks(): Record<string, AckEntry> {
    try {
        const raw = localStorage.getItem(ACK_KEY);
        return raw ? (JSON.parse(raw) as Record<string, AckEntry>) : {};
    } catch {
        return {};
    }
}

/** PURE ack validity (exported for tests): exact notice, within TTL. */
export function isAckValid(entry: AckEntry | undefined, noticeKey: string, nowMs: number): boolean {
    return !!entry && entry.noticeKey === noticeKey && nowMs - entry.ackMs < ACK_TTL_MS;
}

export function isPackAcked(pack: NtmRoutingPack): boolean {
    return isAckValid(loadAcks()[pack.id], pack.noticeKey, Date.now());
}

export function ackPack(pack: NtmRoutingPack): void {
    try {
        const acks = loadAcks();
        acks[pack.id] = { noticeKey: pack.noticeKey, ackMs: Date.now() };
        localStorage.setItem(ACK_KEY, JSON.stringify(acks));
    } catch {
        /* quota — the feature just stays advisory */
    }
    log.warn(`[ntmRouting] ACK ${pack.id} (${pack.noticeKey}) — surveyed zones apply for 24 h`);
    try {
        window.dispatchEvent(new CustomEvent(NTM_ACK_EVENT));
    } catch {
        /* non-browser env */
    }
}

export function revokePackAck(pack: NtmRoutingPack): void {
    try {
        const acks = loadAcks();
        delete acks[pack.id];
        localStorage.setItem(ACK_KEY, JSON.stringify(acks));
    } catch {
        /* ignore */
    }
    log.warn(`[ntmRouting] ack revoked ${pack.id}`);
    try {
        window.dispatchEvent(new CustomEvent(NTM_ACK_EVENT));
    } catch {
        /* non-browser env */
    }
}

// ── Injection + render support ───────────────────────────────────────

const bboxIntersects = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** Packs whose bbox intersects the routing corridor, with live status + ack. */
export async function packsForCorridor(
    corridorBbox: [number, number, number, number],
): Promise<{ pack: NtmRoutingPack; status: NtmPackStatus; acked: boolean }[]> {
    const hits = NTM_ROUTING_PACKS.filter((p) => bboxIntersects(p.bbox, corridorBbox));
    return Promise.all(
        hits.map(async (pack) => ({ pack, status: await ntmPackStatus(pack), acked: isPackAcked(pack) })),
    );
}

/**
 * Zone features to inject as merged.NTMZONE for the engine — ONLY packs that
 * are acked AND current. Every skip is device-logged so a missing injection
 * is diagnosable from the passage log.
 */
export async function activeNtmZonesFor(
    corridorBbox: [number, number, number, number],
): Promise<{ features: Feature[]; packIds: string[] }> {
    const features: Feature[] = [];
    const packIds: string[] = [];
    for (const { pack, status, acked } of await packsForCorridor(corridorBbox)) {
        if (status.status !== 'current') {
            log.warn(
                `[ntmRouting] ${pack.id} NOT injected — ${status.status}${
                    status.status === 'superseded' ? ` by "${status.liveNumber}"` : `: ${status.reason}`
                }`,
            );
            continue;
        }
        if (!acked) {
            log.warn(`[ntmRouting] ${pack.id} current but NOT acknowledged — advisory only`);
            continue;
        }
        for (const z of pack.zones) {
            if (!(z.depthM > 0)) continue; // never inject a drying survey as water
            features.push({
                type: 'Feature',
                properties: { _class: 'ntm-survey', depthM: z.depthM, _noticeKey: pack.noticeKey, _label: z.label },
                geometry: { type: 'Polygon', coordinates: [z.polygon] },
            });
        }
        packIds.push(pack.id);
        log.warn(`[ntmRouting] INJECTING ${pack.zones.length} surveyed zone(s) from "${pack.noticeKey}" (${pack.id})`);
    }
    return { features, packIds };
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
