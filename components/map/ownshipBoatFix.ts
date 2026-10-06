/**
 * ownshipBoatFix — whose position the own-ship marker draws, and from where.
 *
 * Shane 2026-10-07, on build 121 at home, the boat in a marina far up the
 * coast with her Pi publishing: "on the vessel location, that there is no
 * longer a dot for where the vessel is. We used to have a dot (but it could be
 * a nice little boat). With either anchored or stopped (depending on whether
 * the anchor watch is on). Also it would have sog."
 *
 * Build 121 moved the Obs camera onto the boat's own chain (obsCentre: her
 * bus, her Pi, her cloud row, then her held fix; never the phone) and left the
 * marker on the ownship arbiter, which ashore falls back to the phone. The
 * chart opened on the boat and the marker sat on the phone, off screen. The
 * "dot" Shane remembers from 120 was his phone drawn as the boat.
 *
 * Now the marker reads the SAME chain the camera does (boatFixNow), so the
 * two cannot disagree:
 *
 *  · the boat crewed on, while the location box follows her;
 *  · the account's own boat, always while the box follows her;
 *  · otherwise (the box on the phone or a place) the boat this device's own
 *    receivers belong to, by the chain's own ownership test: a gateway saved
 *    or a Pi paired is the own boat's unless it is known to be a boat this
 *    account crews on, and then it is that boat's (crew aboard see the boat
 *    under their feet); else the own boat when this device holds a fix of
 *    hers (live, held, or seen this session);
 *  · otherwise the phone: a punter whose phone is all the boat has keeps the
 *    marker exactly as it was.
 */
import { deviceRungOwner } from '../../services/boatPositionChain';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import { NmeaListenerService } from '../../services/NmeaListenerService';
import { piCache } from '../../services/PiCacheService';
import { listCrewVessels } from '../../services/vessel/sharedBinders';
import {
    boatCloudRowNow,
    boatFixNow,
    boatOrHeldFix,
    getWeatherFollowCrewOwner,
    getWeatherFollowTarget,
    lookUpBoatCloudRow,
    type WeatherFix,
} from '../../services/weatherPosition';
import { calculateDistance } from '../../utils/navigationCalculations';

/** Whose position the marker draws. */
export type OwnshipSubject = { kind: 'phone' } | { kind: 'boat'; crewOwnerId: string | null };

/** Which of the boat's lanes answered, or 'held' for her last known fix. */
export type OwnshipBoatLane = 'bus' | 'pi' | 'cloud' | 'held';

export interface VesselMarkerFix {
    lat: number;
    lon: number;
    /**
     * When the receiver sampled the position: the lane's own time, or the Pi's
     * position sample time when the row carries one (never later than the
     * row). Null when the lane cannot say: her cloud row without the Pi's
     * sample time is undated, never live.
     */
    timestamp: number | null;
    lane: OwnshipBoatLane;
    /** Knots, when the lane carries it; null is unknown, never 0. */
    sogKts: number | null;
    cogDeg: number | null;
    headingTrueDeg: number | null;
    headingTrueAt: number | null;
}

/** A fix with a sample time: the only kind the marker keeps as where she was. */
export type DatedVesselMarkerFix = VesselMarkerFix & { timestamp: number };

/**
 * How long a Pi or cloud fix counts as live on the marker: the weather's own
 * gate for those lanes (weatherFixStatus), and the cloud lane's gate on the
 * System status box (boatLiveFixMaxAgeMs). The chain re-reads the row every
 * 30 s and the Pi publishes every 5 s, so a healthy boat never leaves it.
 */
export const REMOTE_LANE_LIVE_MAX_AGE_MS = 60_000;

/** Her cloud row lends the Pi lane its speed and course only while this close to the Pi's fix. */
const CLOUD_MOTION_MATCH_M = 30;

const OWN_BOAT: OwnshipSubject = { kind: 'boat', crewOwnerId: null };

/** Same subject: one trail, one swing, one fix clock. */
export function sameOwnshipSubject(a: OwnshipSubject, b: OwnshipSubject): boolean {
    if (a.kind === 'phone' || b.kind === 'phone') return a.kind === b.kind;
    return a.crewOwnerId === b.crewOwnerId;
}

// ── What this device has seen of her this session (per account) ──
//
// A cloud row read for the marker keeps nothing in the chain (readOnly), and
// the chain's cache of it goes stale in a minute. Without a memory of her, one
// failed read handed the marker back to the phone, drawn as 'Own ship', for the
// rest of the mount. Held in memory only, and dropped with the account.
interface SessionMemory {
    scope: AuthIdentityScope;
    seen: Map<string, DatedVesselMarkerFix>;
    /** The own boat's chain has been asked once and answered (or failed) this session. */
    ownLookedUp: boolean;
}
let memory: SessionMemory | null = null;

function sessionMemory(): SessionMemory {
    if (!memory || !isAuthIdentityScopeCurrent(memory.scope)) {
        memory = { scope: getAuthIdentityScope(), seen: new Map(), ownLookedUp: false };
    }
    return memory;
}

/** Keep her newest dated fix this session (`crewOwnerId`: a crewed boat; null the own). Never older, never history. */
export function rememberSeenVesselFix(crewOwnerId: string | null, fix: VesselMarkerFix): void {
    if (fix.lane === 'held' || fix.timestamp === null || !Number.isFinite(fix.timestamp)) return;
    const seen = sessionMemory().seen;
    const key = crewOwnerId ?? '';
    const before = seen.get(key);
    if (before && before.timestamp > fix.timestamp) return;
    seen.set(key, { ...fix, timestamp: fix.timestamp });
}

/** Her newest dated fix this session, or null. */
export function seenVesselFix(crewOwnerId: string | null): DatedVesselMarkerFix | null {
    return sessionMemory().seen.get(crewOwnerId ?? '') ?? null;
}

/** Whether the own boat's chain has been asked once this session (the phone may be drawn without flashing). */
export function ownBoatLookedUp(): boolean {
    return sessionMemory().ownLookedUp;
}

/** Tests only. */
export function __resetOwnshipBoatFixForTests(): void {
    memory = null;
}

// ── Whose position ──

/** A skipper this account crews on, when this device's `rung` is known to be her boat's; else null. */
function crewedOwnerOf(rung: 'bus' | 'pi'): string | null {
    try {
        const owner = deviceRungOwner(rung);
        return owner && listCrewVessels().some((vessel) => vessel.ownerId === owner) ? owner : null;
    } catch {
        return null;
    }
}

/**
 * The boat this device has, for a box on the phone or a place, or null when
 * the phone is all there is. The chain's own ownership test (devicesAreHers):
 * a saved gateway or a paired Pi is the own boat's unless it is known to be a
 * boat this account crews on, and then it is THAT boat's, which the chain
 * would never answer for the own boat. Then a fix of the own boat's this
 * device holds (live, held, or seen this session). Nothing here throws: a
 * receiver that cannot answer counts as none.
 */
export function deviceOwnshipSubject(now = Date.now()): OwnshipSubject | null {
    const receivers: ReadonlyArray<readonly [rung: 'bus' | 'pi', present: () => unknown]> = [
        ['bus', () => NmeaListenerService.getSavedConfig()],
        ['pi', () => piCache.getBaseUrl()],
    ];
    let crewed: string | null = null;
    for (const [rung, present] of receivers) {
        let here = false;
        try {
            here = Boolean(present());
        } catch {
            here = false;
        }
        if (!here) continue;
        const owner = crewedOwnerOf(rung);
        if (!owner) return OWN_BOAT;
        crewed = crewed ?? owner;
    }
    if (crewed) return { kind: 'boat', crewOwnerId: crewed };
    try {
        if (boatFixNow(now, null) !== null) return OWN_BOAT;
    } catch {
        /* the chain could not say */
    }
    return seenVesselFix(null) ? OWN_BOAT : null;
}

/**
 * Whose position the marker draws right now. The box following the boat
 * crewed on: her. Following the own boat: her, receivers or not (the box asked
 * for the boat; no fix means no marker, never the phone in her place).
 * Otherwise (the phone, or a chosen place): the boat this device has
 * (deviceOwnshipSubject), else the phone.
 */
export function ownshipMarkerSubject(now = Date.now()): OwnshipSubject {
    const target = getWeatherFollowTarget();
    if (target === 'crew') {
        const crewOwnerId = getWeatherFollowCrewOwner();
        if (crewOwnerId) return { kind: 'boat', crewOwnerId };
    }
    if (target === 'boat' || target === 'crew') return OWN_BOAT;
    return deviceOwnshipSubject(now) ?? { kind: 'phone' };
}

// ── Where she is ──

function fromWeatherFix(fix: WeatherFix): VesselMarkerFix {
    const lane: OwnshipBoatLane = fix.kind === 'bus' || fix.kind === 'pi' || fix.kind === 'cloud' ? fix.kind : 'held';
    const held = lane === 'held';
    // Her cloud row's report time dates the REPORT: the Pi republishes its
    // cached lat/lon every 5 s whatever their age, and sends its own sample
    // time (position_at) only while it can prove the fix is under 10 min old
    // (pi-cache trackSignalk). A row without it is undated, exactly as the
    // System status card (gpsDiagnosticsPresentation) and Radio treat it, and
    // as the bus branch treats a Pi snapshot with no positionSampleAt.
    const timestamp =
        typeof fix.positionAt === 'number'
            ? Math.min(fix.positionAt, fix.timestamp)
            : lane === 'cloud'
              ? null
              : fix.timestamp;
    return {
        lat: fix.lat,
        lon: fix.lon,
        timestamp,
        lane,
        // A held fix is history: no speed, no course, no bow.
        sogKts: held ? null : (fix.sogKts ?? null),
        cogDeg: held ? null : (fix.cogDeg ?? null),
        headingTrueDeg: held ? null : (fix.headingTrueDeg ?? null),
        headingTrueAt: held ? null : (fix.headingTrueAt ?? null),
    };
}

/**
 * The Pi lane (/api/gps) carries a position and nothing else. Her cloud row,
 * a lane down, carries her speed and course: lend them while the row is dated
 * inside the live gate and puts her within a few metres of the Pi's fix.
 * Otherwise the speed stays unknown ('SOG —'), never 0.
 */
function withCloudMotion(fix: VesselMarkerFix, crewOwnerId: string | null, now: number): VesselMarkerFix {
    if (fix.lane !== 'pi' || fix.sogKts !== null) return fix;
    const row = boatCloudRowNow(now, crewOwnerId);
    if (!row || typeof row.positionAt !== 'number' || typeof row.sogKts !== 'number') return fix;
    const age = now - row.positionAt;
    if (!(age >= -5_000 && age <= REMOTE_LANE_LIVE_MAX_AGE_MS)) return fix;
    if (calculateDistance(fix.lat, fix.lon, row.lat, row.lon) * 1852 > CLOUD_MOTION_MATCH_M) return fix;
    return { ...fix, sogKts: row.sogKts, cogDeg: row.cogDeg ?? null };
}

/**
 * The boat's position as the marker draws it, asking no one: exactly what the
 * Obs camera reads (boatFixNow: her bus when the receivers are hers, else the
 * Pi's and her cloud row's latest answers, else her held fix). Never the phone.
 */
export function vesselMarkerFixNow(crewOwnerId: string | null, now = Date.now()): VesselMarkerFix | null {
    try {
        const fix = boatFixNow(now, crewOwnerId);
        return fix ? withCloudMotion(fromWeatherFix(fix), crewOwnerId, now) : null;
    } catch {
        return null;
    }
}

/**
 * Ask the boat's chain once (her Pi, her cloud row), keeping nothing and
 * ending no weather choice. Throttled by the chain itself (30 s per lane), so
 * the marker may call it on every re-check. When the Pi answers, her cloud row
 * is read too (same throttle) for the speed the Pi lane does not carry.
 */
export async function lookUpVesselMarkerFix(crewOwnerId: string | null): Promise<void> {
    const mine = sessionMemory();
    try {
        const fix = await boatOrHeldFix(Date.now(), crewOwnerId, { readOnly: true });
        if (fix?.kind === 'pi' && fix.sogKts === undefined) await lookUpBoatCloudRow(Date.now(), crewOwnerId);
    } catch {
        /* the next re-check asks again */
    } finally {
        if (crewOwnerId === null && mine === memory) mine.ownLookedUp = true;
    }
}
