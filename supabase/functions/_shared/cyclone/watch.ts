/**
 * cyclone-watch's decisions (129-09), pure so every rule has a test
 * (tests/CycloneWatch.test.ts). The edge function only fetches, reads the
 * boats and writes what this returns.
 *
 * Levels, all great-circle NM from the boat:
 *   urgent  the advisory's centre, or where its track puts the storm now,
 *           within 300 NM, or the forecast track within 300 NM at any time
 *           up to +72 h, interpolated along the great circle between
 *           forecast points;
 *   notice  the same at 600 NM.
 * The push gives the distance and bearing to where the track puts the storm
 * now (an advisory can be hours old), and says so when the advisory's own
 * position was the nearer.
 * Collapse: one push per storm per level. Notice to urgent sends again; the
 * same level never repeats while the storm stays inside. Re-armed after more
 * than 100 NM outside the level's radius for 12 h, or when the same issuer's
 * new advisory brings it back inside after one of its advisories had it
 * outside (a source flap, official then the GFS fallback, is not a new
 * advisory). A storm whose data was said to be lost, back in the feed, is
 * pushed again: that message replaced the warning on the lock screen.
 * Quiet hours: a notice raised 22:00-07:00 boat time (the nautical zone of the
 * boat's position, round(lon / 15)) waits for 07:00; urgent goes at once.
 * Track: the official one where Thalassa has it (NHC, CPHC), else JTWC's
 * advisory, else the GFS model's, and the push says which, first where the
 * track is not the official warning.
 * Weak: below gale force now and to +72 h by the centre's own intensity
 * (never GFS's, which under-reads) is not pushed, and is still seen: a storm
 * that weakens in the feed is not "lost".
 * Boats (resolveBoat): the Pi's fix, or a fix the phone already sends, while
 * under 72 h old; else the home port, read as the app reads it; else the
 * place the weather is set to; else the older fix.
 * Privacy: the push names the storm, the issuer, the distance and the bearing
 * from the boat, never a coordinate, and the state kept per boat holds levels,
 * times and advisory ids only.
 * Never a false all-clear: a feed that is down, or a storm that drops out of
 * it while it was near a boat, is said once, and no state is cleared for it.
 */
import {
    CYCLONE_CENTRES,
    cycloneCentre,
    type CycloneCentreId,
    JTWC_NOT_OFFICIAL,
    type TrackIssuer,
    trackIssuerLabel,
    utcLabel,
} from './centres.ts';
import type { EsriForecastStorm } from './esri.ts';

export interface LatLon {
    lat: number;
    lon: number;
}
export interface TimedPoint extends LatLon {
    t: number;
}

export const EARTH_RADIUS_NM = 3440.065;
export const NOTICE_NM = 600;
export const URGENT_NM = 300;
export const TRACK_WINDOW_MS = 72 * 3_600_000;
export const REARM_MARGIN_NM = 100;
export const REARM_AFTER_MS = 12 * 3_600_000;
/** A storm unseen this long, while it was near a boat, is said to be unavailable. */
export const LOST_AFTER_MS = 60 * 60_000;
/** State for a storm unseen this long is let go. */
export const FORGET_AFTER_MS = 14 * 86_400_000;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function vec({ lat, lon }: LatLon): [number, number, number] {
    const φ = lat * RAD;
    const λ = lon * RAD;
    return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
}
const fromVec = ([x, y, z]: [number, number, number]): LatLon => ({
    lat: Math.atan2(z, Math.hypot(x, y)) * DEG,
    lon: Math.atan2(y, x) * DEG,
});
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]): [number, number, number] => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
/** Angle between unit vectors, stable for tiny and near-antipodal angles. */
const angle = (a: number[], b: number[]) => Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));

export function gcDistanceNm(a: LatLon, b: LatLon): number {
    return angle(vec(a), vec(b)) * EARTH_RADIUS_NM;
}

/** Initial true bearing from one point to another, 0-360. */
export function gcBearingDeg(from: LatLon, to: LatLon): number {
    const φ1 = from.lat * RAD;
    const φ2 = to.lat * RAD;
    const dλ = (to.lon - from.lon) * RAD;
    const y = Math.sin(dλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
    return (Math.atan2(y, x) * DEG + 360) % 360;
}

/** The point a fraction f of the way along the great circle from a to b. */
export function gcInterpolate(a: LatLon, b: LatLon, f: number): LatLon {
    const va = vec(a);
    const vb = vec(b);
    const d = angle(va, vb);
    if (d < 1e-12) return { ...a };
    const s = Math.sin(d);
    const ka = Math.sin((1 - f) * d) / s;
    const kb = Math.sin(f * d) / s;
    return fromVec([ka * va[0] + kb * vb[0], ka * va[1] + kb * vb[1], ka * va[2] + kb * vb[2]]);
}

/**
 * The nearest the track comes to p between fromMs and toMs: each segment is
 * clipped to the window (by time, along the great circle) and measured by
 * cross-track distance, so a pass between two forecast points counts.
 */
export function closestApproach(
    p: LatLon,
    track: TimedPoint[],
    fromMs: number,
    toMs: number,
): { nm: number; t: number } | null {
    const pts = [...track].filter((q) => Number.isFinite(q.t)).sort((a, b) => a.t - b.t);
    const vp = vec(p);
    let best: { nm: number; t: number } | null = null;
    const consider = (nm: number, t: number) => {
        if (!best || nm < best.nm) best = { nm, t };
    };
    const at = (a: TimedPoint, b: TimedPoint, t: number): TimedPoint => ({
        ...gcInterpolate(a, b, b.t === a.t ? 0 : (t - a.t) / (b.t - a.t)),
        t,
    });
    if (pts.length === 1 && pts[0].t >= fromMs && pts[0].t <= toMs) consider(gcDistanceNm(p, pts[0]), pts[0].t);
    for (let i = 1; i < pts.length; i++) {
        let a = pts[i - 1];
        let b = pts[i];
        if (b.t < fromMs || a.t > toMs) continue;
        if (a.t < fromMs) a = at(a, b, fromMs);
        if (b.t > toMs) b = at(pts[i - 1], b, toMs);
        const va = vec(a);
        const vb = vec(b);
        const len = angle(va, vb);
        consider(angle(vp, va) * EARTH_RADIUS_NM, a.t);
        consider(angle(vp, vb) * EARTH_RADIUS_NM, b.t);
        if (len < 1e-12) continue;
        const n = cross(va, vb);
        const nLen = Math.hypot(...n);
        // The foot of the perpendicular from p onto the great circle through a, b.
        const k = dot(vp, n) / (nLen * nLen);
        const foot = [vp[0] - k * n[0], vp[1] - k * n[1], vp[2] - k * n[2]];
        const fLen = Math.hypot(...foot);
        if (fLen < 1e-12) continue;
        const fu = foot.map((v) => v / fLen);
        const along = angle(va, fu);
        if (along < len && angle(fu, vb) < len) {
            consider(angle(vp, fu) * EARTH_RADIUS_NM, a.t + (b.t - a.t) * (along / len));
        }
    }
    return best;
}

export type Level = 0 | 1 | 2;
export type WatchIssuer = TrackIssuer | 'GFS';

export interface WatchStorm {
    /** Basin and number, "SH37". */
    key: string;
    name: string;
    issuer: WatchIssuer;
    /** The advisory number, or the issue time where the source has none. */
    advisory: string;
    issuedMs: number;
    /** The advisory's own current position (tau 0). */
    current: LatLon;
    track: TimedPoint[];
    /** Strongest wind now or forecast to +72 h; null when the source gives none. */
    maxWindKts: number | null;
}

export interface Assessment {
    level: Level;
    /** Where the track puts the storm now, from the boat. */
    nm: number;
    bearing: number;
    /** The advisory's own centre (tau 0), from the boat. */
    advisoryNm: number;
    /** The track's nearest pass within 72 h, if any. */
    track: { nm: number; t: number } | null;
    /** The nearer of the two: what re-arming measures. */
    nearest: number;
}

const RADIUS = [0, NOTICE_NM, URGENT_NM];

/**
 * Where the track puts the storm at nowMs: along the great circle between the
 * forecast points either side of it, else the advisory's own centre.
 */
export function positionAt(storm: WatchStorm, nowMs: number): LatLon {
    const pts = storm.track.filter((q) => Number.isFinite(q.t)).sort((a, b) => a.t - b.t);
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        if (nowMs < a.t || nowMs > b.t) continue;
        return b.t === a.t ? { lat: a.lat, lon: a.lon } : gcInterpolate(a, b, (nowMs - a.t) / (b.t - a.t));
    }
    return storm.current;
}

export function assess(boat: LatLon, storm: WatchStorm, nowMs: number): Assessment {
    const now = positionAt(storm, nowMs);
    const nm = gcDistanceNm(boat, now);
    const advisoryNm = gcDistanceNm(boat, storm.current);
    const track = closestApproach(boat, storm.track, nowMs, nowMs + TRACK_WINDOW_MS);
    const nearest = Math.min(nm, advisoryNm, track?.nm ?? Infinity);
    const level: Level = nearest <= URGENT_NM ? 2 : nearest <= NOTICE_NM ? 1 : 0;
    return { level, nm, bearing: gcBearingDeg(boat, now), advisoryNm, track, nearest };
}

export interface WatchState {
    /** The highest level pushed and not re-armed since. */
    sent: Level;
    sentAt: number | null;
    /** Per level (notice, urgent): since when the storm has been more than 100 NM outside. */
    far: [number | null, number | null];
    /** Per level: the advisory ("NHC|24A") at which it was last outside the radius, since the push. */
    out: [string | null, string | null];
    seenAt: number;
    /** When the boat was told the storm's data had gone. */
    lostToldAt?: number | null;
    /** The storm's name and responsible centre, for that message: no position is kept. */
    name?: string;
    centre?: CycloneCentreId;
}

export function boatLocalHour(nowMs: number, lon: number): number {
    return new Date(nowMs + Math.round(lon / 15) * 3_600_000).getUTCHours();
}

export function isQuietHour(nowMs: number, lon: number): boolean {
    const h = boatLocalHour(nowMs, lon);
    return h >= 22 || h < 7;
}

/** The issuer of an advisory id ("NHC|24A" → "NHC"; a bare id has none). */
const issuerOf = (advisory: string) => (advisory.includes('|') ? advisory.slice(0, advisory.indexOf('|')) : '');

/**
 * One storm and boat, one run. `advisory` is the issuer and its advisory id,
 * "NHC|24A" or "GFS|2026081312": only the same issuer's next advisory counts
 * as a new one.
 */
export function step(
    prev: WatchState | undefined,
    a: Assessment,
    advisory: string,
    nowMs: number,
    lon: number,
): { state: WatchState; push: Level } {
    const s: WatchState = prev
        ? { ...prev, far: [...prev.far], out: [...prev.out], lostToldAt: null }
        : { sent: 0, sentAt: null, far: [null, null], out: [null, null], seenAt: nowMs };
    // Back after "data unavailable", which replaced the warning on the lock
    // screen (one collapse id per storm): said again at the level it is now.
    if (prev?.lostToldAt) {
        s.sent = 0;
        s.far = [null, null];
        s.out = [null, null];
    }
    for (const level of [2, 1] as const) {
        if (s.sent < level) continue;
        const i = level - 1;
        const r = RADIUS[level];
        if (a.nearest > r + REARM_MARGIN_NM) {
            s.far[i] ??= nowMs;
        } else {
            s.far[i] = null;
        }
        let rearm = s.far[i] !== null && nowMs - s.far[i]! >= REARM_AFTER_MS;
        if (a.nearest > r) {
            s.out[i] = advisory;
        } else if (s.out[i] !== null) {
            rearm ||= issuerOf(s.out[i]!) === issuerOf(advisory) && s.out[i] !== advisory;
            s.out[i] = null;
        }
        if (rearm) {
            s.sent = (level - 1) as Level;
            s.far[i] = null;
            s.out[i] = null;
        }
    }
    s.seenAt = nowMs;
    let push: Level = 0;
    if (a.level > s.sent && (a.level === 2 || !isQuietHour(nowMs, lon))) {
        push = a.level;
        s.sent = a.level;
        s.sentAt = nowMs;
        s.far = [null, null];
        s.out = [null, null];
    }
    return { state: s, push };
}

/**
 * fix: the Pi's (vessel_telemetry) under 72 h old; phone: a fix the app
 * already sends (Guardian's last known) under 72 h old; home: the home port;
 * place: the place the weather is set to (onboarding writes the home port
 * there); old-fix: either fix, older.
 */
export type BoatBasis = 'fix' | 'phone' | 'home' | 'place' | 'old-fix';
export interface Boat {
    userId: string;
    position: LatLon;
    basis: BoatBasis;
}

export const FIX_FRESH_MS = 72 * 3_600_000;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const coord = (lat: unknown, lon: unknown): LatLon | null =>
    typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat + lon) && Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180
        ? { lat, lon }
        : null;

/** "Suva (-18.1416, 178.4419)": the position the app writes into a picked place's name. */
const EMBEDDED = /\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)\s*$/;

/**
 * The home port as the app reads it (components/dayPlanner/TodayPlacePicker.tsx
 * savedPlanPlaces, utils/savedLocations.ts): its saved coordinates by the full
 * name, then by the name without the embedded position, then that position.
 */
function homePortPosition(settings: Rec): LatLon | null {
    const home = typeof settings.homePort === 'string' ? settings.homePort.trim() : '';
    if (!home) return null;
    const saved = rec(settings.savedLocationCoords);
    for (const name of [home, home.replace(EMBEDDED, '').trim()]) {
        const at = rec(saved?.[name]);
        const c = at && coord(at.lat, at.lon);
        if (c) return c;
    }
    const m = EMBEDDED.exec(home);
    return m ? coord(parseFloat(m[1]), parseFloat(m[2])) : null;
}

export interface FixRow {
    lat: unknown;
    lon: unknown;
    /** When it was reported (ISO). */
    at: unknown;
}

/** The position a boat is watched from, or null: none, or "Cyclone warnings near the boat" off. */
export function resolveBoat(
    userId: string,
    src: { settings: Rec | null; telemetry?: FixRow | null; phone?: FixRow | null },
    nowMs: number,
): Boat | null {
    const settings = src.settings ?? {};
    if (settings.cycloneWarnings === false) return null;
    const read = (f: FixRow | null | undefined) => {
        const c = f ? coord(f.lat, f.lon) : null;
        const at = Date.parse(String(f?.at ?? ''));
        return c ? { c, fresh: Number.isFinite(at) && nowMs - at <= FIX_FRESH_MS } : null;
    };
    const pi = read(src.telemetry);
    const phone = read(src.phone);
    const home = homePortPosition(settings);
    const placeAt = rec(settings.defaultLocationCoords);
    const place = placeAt && coord(placeAt.lat, placeAt.lon);
    const [position, basis]: [LatLon | null | undefined, BoatBasis] = pi?.fresh
        ? [pi.c, 'fix']
        : phone?.fresh
        ? [phone.c, 'phone']
        : home
        ? [home, 'home']
        : place
        ? [place, 'place']
        : [(pi ?? phone)?.c, 'old-fix'];
    return position ? { userId, position, basis } : null;
}

export interface CyclonePush {
    userId: string;
    type: 'cyclone_notice' | 'cyclone_urgent';
    title: string;
    body: string;
    data: { storm_key: string; storm_name: string; level: 'notice' | 'urgent'; issuer: WatchIssuer };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const roundNm = (nm: number) => (nm < 100 ? Math.max(5, Math.round(nm / 5) * 5) : Math.round(nm / 10) * 10);
const FROM: Record<BoatBasis, string> = {
    fix: 'your boat',
    phone: 'your last reported position',
    home: 'your home port',
    place: 'your weather location',
    'old-fix': 'your last known position',
};

/**
 * Who wrote the track the push measured, said plainly: `lead` first where it
 * is not the official warning (lock screens cut the end of a body off), and
 * `tail` naming the official track or the official centre.
 */
function trackWords(storm: WatchStorm): { lead: string | null; tail: string } {
    const centre = cycloneCentre(storm.current.lat, storm.current.lon);
    const official = `Official warnings: ${centre.short}.`;
    if (storm.issuer === 'GFS') {
        return { lead: 'GFS model track only; no official track reached Thalassa.', tail: official };
    }
    const label = trackIssuerLabel(storm.issuer, centre);
    if (label.official) return { lead: null, tail: `Track: ${label.text}, advisory ${storm.advisory}.` };
    return { lead: `${storm.issuer === 'JTWC' ? JTWC_NOT_OFFICIAL : label.text}.`, tail: official };
}

function advisoryWords(storm: WatchStorm, nowMs: number): string {
    return `${nowMs - storm.issuedMs > 12 * 3_600_000 ? 'Last advisory' : 'Advisory'} ${utcLabel(storm.issuedMs)}.`;
}

export function pushMessage(level: 1 | 2, storm: WatchStorm, a: Assessment, boat: Boat, nowMs: number): CyclonePush {
    const bearing = Math.round(a.bearing) % 360;
    const words = trackWords(storm);
    const parts = words.lead ? [words.lead] : [];
    const compass = COMPASS[Math.round(bearing / 22.5) % 16];
    const from = `${roundNm(a.nm)} NM from ${FROM[boat.basis]}`;
    parts.push(`${storm.name} is about ${from}, bearing ${String(bearing).padStart(3, '0')}° (${compass}).`);
    if (a.advisoryNm < a.nm - 20 && a.advisoryNm <= (a.track?.nm ?? Infinity)) {
        const t0 = storm.track.length ? Math.min(...storm.track.map((p) => p.t)) : storm.issuedMs;
        parts.push(`At the ${utcLabel(t0)} advisory it was ${roundNm(a.advisoryNm)} NM away.`);
    }
    if (a.track && a.track.nm < a.nm - 20) {
        const hours = Math.max(1, Math.round((a.track.t - nowMs) / 3_600_000));
        parts.push(`Its forecast track passes within ${roundNm(a.track.nm)} NM in about ${hours} h.`);
    }
    parts.push(words.tail, advisoryWords(storm, nowMs));
    const urgent = level === 2;
    return {
        userId: boat.userId,
        type: urgent ? 'cyclone_urgent' : 'cyclone_notice',
        // Never "Cyclone warning": that is the official centres' own product.
        title: `${urgent ? 'Urgent cyclone notice' : 'Cyclone notice'}: ${storm.name}`.slice(0, 120),
        body: parts.join(' ').slice(0, 500),
        data: {
            storm_key: storm.key,
            storm_name: storm.name,
            level: urgent ? 'urgent' : 'notice',
            issuer: storm.issuer,
        },
    };
}

export function unavailableLine(sinceMs: number): string {
    return `Cyclone data unavailable since ${utcLabel(sinceMs)}`;
}

function lostMessage(userId: string, key: string, st: WatchState, feedDown: boolean): CyclonePush {
    const name = st.name ?? key;
    const centre = CYCLONE_CENTRES[st.centre ?? 'wmo'] ?? CYCLONE_CENTRES.wmo;
    return {
        userId,
        type: 'cyclone_notice',
        title: `Cyclone data unavailable: ${name}`.slice(0, 120),
        body: `${unavailableLine(st.seenAt)}. ${
            feedDown ? 'The cyclone feed is not answering' : `${name} is no longer in the cyclone feed`
        }, so Thalassa cannot say where it is now. Check the official warnings: ${centre.short}.`.slice(0, 500),
        data: { storm_key: key, storm_name: name, level: 'notice', issuer: 'GFS' },
    };
}

/** The Esri feed's storms as the watcher measures them: tau 0 is the current centre. */
export function watchStormsFromEsri(storms: EsriForecastStorm[]): WatchStorm[] {
    const out: WatchStorm[] = [];
    for (const s of storms) {
        const track = s.points
            .map((p) => ({ lat: p.lat, lon: p.lon, t: Date.parse(p.time), w: p.windKts }))
            .filter((p) => Number.isFinite(p.t));
        if (track.length === 0) continue;
        const t0 = track[0].t;
        const winds = track.filter((p) => p.t <= t0 + TRACK_WINDOW_MS && p.w !== null).map((p) => p.w as number);
        out.push({
            key: s.key,
            name: s.name,
            issuer: s.issuer,
            advisory: s.advisory,
            issuedMs: s.issued ? Date.parse(s.issued) : t0,
            current: { lat: track[0].lat, lon: track[0].lon },
            track: track.map(({ lat, lon, t }) => ({ lat, lon, t })),
            maxWindKts: winds.length ? Math.max(...winds) : null,
        });
    }
    return out;
}

/**
 * Below gale force now and for the next 72 h, by the warning centre's own
 * intensity: not pushed. GFS's maximum wind often reads a real tropical storm
 * below 34 kt, so a GFS-only storm is always measured.
 */
const tooWeak = (s: WatchStorm) => s.issuer !== 'GFS' && s.maxWindKts !== null && s.maxWindKts < 34;

/**
 * One run: every boat against every storm. `storms` is null when no source
 * answered; then nothing is assessed and nothing is cleared. States are keyed
 * `${userId}|${stormKey}`.
 */
export function runWatch(input: {
    storms: WatchStorm[] | null;
    boats: Boat[];
    states: Map<string, WatchState>;
    nowMs: number;
}): { pushes: CyclonePush[]; states: Map<string, WatchState>; unavailable: boolean } {
    const { boats, nowMs } = input;
    const states = new Map(input.states);
    const pushes: CyclonePush[] = [];
    const storms = input.storms ?? [];
    const seen = new Set<string>();
    for (const boat of boats) {
        for (const storm of storms) {
            const id = `${boat.userId}|${storm.key}`;
            const prev = states.get(id);
            if (tooWeak(storm)) {
                // Still in the feed, weakened: seen and kept, neither measured
                // nor pushed. Never "no longer in the cyclone feed".
                if (prev) {
                    seen.add(id);
                    states.set(id, { ...prev, seenAt: nowMs });
                }
                continue;
            }
            seen.add(id);
            const a = assess(boat.position, storm, nowMs);
            if (!prev && a.level === 0) continue;
            const r = step(prev, a, `${storm.issuer}|${storm.advisory}`, nowMs, boat.position.lon);
            const centre = cycloneCentre(storm.current.lat, storm.current.lon).id;
            states.set(id, { ...r.state, name: storm.name, centre });
            if (r.push) pushes.push(pushMessage(r.push as 1 | 2, storm, a, boat, nowMs));
        }
    }
    const lon = new Map(boats.map((b) => [b.userId, b.position.lon]));
    for (const [id, st] of states) {
        if (seen.has(id)) continue;
        if (nowMs - st.seenAt > FORGET_AFTER_MS) {
            states.delete(id);
            continue;
        }
        const [userId, key] = id.split('|');
        const boatLon = lon.get(userId);
        // Said once, and only for a storm last seen near the boat (not 100 NM
        // past the notice radius) after a push: a dropped storm is never erased
        // in silence, and a passed one is not news.
        if (st.sent === 0 || st.far[0] !== null || st.lostToldAt || boatLon === undefined) continue;
        if (nowMs - st.seenAt < LOST_AFTER_MS || (st.sent === 1 && isQuietHour(nowMs, boatLon))) continue;
        pushes.push(lostMessage(userId, key, st, input.storms === null));
        states.set(id, { ...st, lostToldAt: nowMs });
    }
    return { pushes, states, unavailable: input.storms === null };
}
