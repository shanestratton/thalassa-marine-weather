import type { Notice } from './NoticeToMarinersService';
import type { LocalNotice } from './localNotices';
import type { QldNotice } from './qldNotices';

export const OBS_NOTICE_MIN_ZOOM = 9;
export const OBS_NOTICE_CAP = 40;
export interface ObsNotice {
    id: string;
    lon: number;
    lat: number;
    title: string;
    text: string;
    issuer: string;
    issued: string;
    receivedAt: number | null;
    url: string;
    approximate: boolean;
}
export type NoticeViewport = [west: number, south: number, east: number, north: number];
const clean = (s: unknown, cap: number) => (typeof s === 'string' ? s.slice(0, cap) : '');
export function noticeSource(area: string): 'nga' | 'amsa' | 'ukho' | 'linz' | null {
    return ['4', '12', 'A', 'C', 'P'].includes(area)
        ? 'nga'
        : area === 'X'
          ? 'amsa'
          : ['I', 'WZ'].includes(area)
            ? 'ukho'
            : ['XIV', 'NZC'].includes(area)
              ? 'linz'
              : null;
}
const SOURCE_URL = {
    nga: 'https://msi.nga.mil/NavWarnings',
    amsa: 'https://www.amsa.gov.au/safety-navigation/navigation-systems/maritime-safety-information',
    ukho: 'https://msi.admiralty.co.uk/',
    linz: 'https://www.maritimenz.govt.nz/professional/skippers-and-seafarers/navigation-and-weather/',
};
function camera(input: NoticeViewport | null) {
    if (!input || input.length !== 4 || input.some((n) => !Number.isFinite(n))) return null;
    const [w, s, rawEast, n] = input,
        e = rawEast < w ? rawEast + 360 : rawEast;
    return w >= -540 && e <= 540 && e > w && e - w <= 360 && s >= -90 && n <= 90 && s < n
        ? { w, e, s, n, center: (w + e) / 2 }
        : null;
}
/** Fixed public source data only. The viewport is a local filter, never a query. */
export function selectObsNotices(input: {
    bounds: NoticeViewport | null;
    zoom: number;
    broadcast: readonly Notice[];
    health: readonly { source: string; fetchedAt: number }[];
    local: readonly LocalNotice[];
    qld: readonly QldNotice[];
    qldFetchedAt: number | null;
    now: number;
}): { notices: ObsNotice[]; partial: boolean; unplaced: number } {
    const view = camera(input.bounds);
    if (!view || !Number.isFinite(input.zoom) || input.zoom < OBS_NOTICE_MIN_ZOOM)
        return { notices: [], partial: false, unplaced: 0 };
    const notices: ObsNotice[] = [],
        seen = new Set<string>();
    let unplaced = 0,
        partial = input.broadcast.length > 5000 || input.qld.length > 1000 || input.local.length > 500;
    const clock = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= input.now ? v : null);
    const point = (lat: unknown, lon: unknown) => {
        if (
            typeof lat !== 'number' ||
            typeof lon !== 'number' ||
            !Number.isFinite(lat) ||
            !Number.isFinite(lon) ||
            Math.abs(lat) > 90 ||
            Math.abs(lon) > 180
        )
            return null;
        const worldLon = lon + 360 * Math.round((view.center - lon) / 360);
        return lat >= view.s && lat <= view.n && worldLon >= view.w && worldLon <= view.e
            ? { lat, lon: worldLon }
            : null;
    };
    const add = (notice: ObsNotice) => {
        if (!seen.has(notice.id)) {
            seen.add(notice.id);
            notices.push(notice);
        }
    };
    for (const n of input.broadcast.slice(0, 5000)) {
        if (!n || typeof n.id !== 'string' || /^(C|CANCELLED|CANCELED)$/i.test(n.status)) continue;
        const coords = Array.isArray(n.coordinates) ? n.coordinates.slice(0, 64) : [];
        if (coords.length === 0) {
            unplaced++;
            continue;
        }
        const p = coords.map((c) => point(c?.lat, c?.lon)).find(Boolean);
        if (!p) continue;
        const source = noticeSource(n.navArea);
        add({
            id: `broadcast:${clean(n.id, 100)}`,
            ...p,
            title: clean(n.title, 160),
            text: clean(n.text, 16000),
            issuer: clean(n.authority || n.areaLabel, 100),
            issued: clean(n.issueDate, 80),
            receivedAt: clock(input.health.find((h) => h.source === source)?.fetchedAt),
            url: source ? SOURCE_URL[source] : '',
            approximate: false,
        });
    }
    for (const n of input.qld.slice(0, 1000)) {
        const p = point(n?.lat, n?.lon);
        if (n && p)
            add({
                id: `qld:${clean(n.number, 80)}:${clean(n.region, 80)}`,
                ...p,
                title: clean(n.subject, 160),
                text: clean(n.subject, 2000),
                issuer: `Maritime Safety Queensland · ${clean(n.region, 80)}`,
                issued: clean(n.dateStr, 80),
                receivedAt: clock(input.qldFetchedAt),
                url: clean(n.pdfUrl, 1000),
                approximate: true,
            });
    }
    for (const n of input.local.slice(0, 500)) {
        const p = point(n?.lat, n?.lon);
        if (n && p)
            add({
                id: `local:${clean(n.id, 100)}`,
                ...p,
                title: clean(n.title, 160),
                text: `${clean(n.summary, 2000)}\n${clean(n.detail, 6000)}`,
                issuer: clean(n.sourceName, 100) || 'Bundled advisory',
                issued: clean(n.issued, 80),
                receivedAt: null,
                url: clean(n.sourceUrl, 1000),
                approximate: true,
            });
    }
    // Nearby anchors first, stable across source refreshes. No severity is inferred.
    notices.sort((a, b) => Math.abs(a.lon - view.center) - Math.abs(b.lon - view.center) || a.id.localeCompare(b.id));
    partial ||= notices.length > OBS_NOTICE_CAP;
    return { notices: notices.slice(0, OBS_NOTICE_CAP), partial, unplaced };
}
