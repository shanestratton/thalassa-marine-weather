/**
 * collisionRule — the ONE collision rule (build 125, package 125-01).
 *
 * The popup's CPA chip (utils/cpaCalculation.ts), the collision alarm
 * (services/AisGuardWatch.ts → CollisionAlarmService) and Calypso's proximity
 * answer (services/voice/integrations/aisProximity.ts) all grade a target
 * here, so they cannot disagree.
 *
 * PURE AND DEPENDENCY-FREE ON PURPOSE: no imports, no browser or build
 * globals. Package 126-04 copies this file to the Pi (the way
 * pi-cache/scripts/sync-router-engine.mjs mirrors the router) so the Pi's
 * night watch runs the same rule; tests/CollisionRule.test.ts pins that.
 * 125-02's distress classifier belongs in this file too, in its own section.
 *
 * Defaults are the ones recommended to Shane in the 125 roadmap (they ship
 * unless he says otherwise): CPA 0.5 NM / TCPA 15 min offshore, 0.2 NM / 6 min
 * inshore or under 3 kn of our own speed.
 */

// ── AIS 'not available' (ITU-R M.1371) ──────────────────────────────────────

/** SOG 1023 → 102.3 kn means not available (and 1022 means '102.2 or more'). */
export const AIS_SOG_NOT_AVAILABLE = 102.3;
/** COG 3600 → 360.0° means not available. */
export const AIS_COG_NOT_AVAILABLE = 360;
/** True heading 511 means not available. */
export const AIS_HEADING_NOT_AVAILABLE = 511;

function finite(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/** A usable speed over ground in knots, or null for missing / not available. */
export function aisSogKn(value: unknown): number | null {
    const n = finite(value);
    return n !== null && n >= 0 && n < 102.2 ? n : null;
}

/** A usable course over ground in [0, 360), or null for missing / not available. */
export function aisCogDeg(value: unknown): number | null {
    const n = finite(value);
    return n !== null && n >= 0 && n < 360 ? n : null;
}

/** A usable true heading (whole degrees 0-359), or null (511 = not available). */
export function aisHeadingDeg(value: unknown): number | null {
    const n = finite(value);
    return n !== null && Number.isInteger(n) && n >= 0 && n < 360 ? n : null;
}

// ── Thresholds ──────────────────────────────────────────────────────────────

export interface CollisionPair {
    cpaNm: number;
    tcpaMin: number;
}

/** The skipper's pair of thresholds (Settings → Preferences → Collision alarm). */
export interface CollisionPrefs {
    offshore: CollisionPair;
    inshore: CollisionPair;
}

export const DEFAULT_COLLISION_PREFS: Readonly<CollisionPrefs> = Object.freeze({
    offshore: Object.freeze({ cpaNm: 0.5, tcpaMin: 15 }),
    inshore: Object.freeze({ cpaNm: 0.2, tcpaMin: 6 }),
});

/** The fixed parts of the rule. Not settings: changing these changes the rule. */
export const COLLISION_RULE = Object.freeze({
    /**
     * The pair switches with hysteresis, so speed jitter around 3 kn (light
     * air) cannot flip it pass by pass: the offshore pair applies from 3 kn,
     * and once it does, the inshore pair returns only under 2.5 kn. With no
     * history, under 3 kn is inshore.
     */
    offshoreFromOwnSogKn: 3,
    inshoreBelowOwnSogKn: 2.5,
    /** Under 3 kn of our own, targets slower than this are berths, not traffic. */
    minTargetSogKn: 0.5,
    /** Below this we are stopped: awareness only (the anchor watch owns that case). */
    ownStoppedBelowKn: 0.5,
    /** A moored/anchored/aground claim is believed only at or under this speed. */
    stationaryClaimMaxSogKn: 2,
    /** Inside both limits while we're moving, it always alarms: no mute, no threshold, no target filter. */
    closeQuarters: Object.freeze({ cpaNm: 0.1, tcpaMin: 3 }),
    muteMinutes: 30,
    /** No CPA from a report older than this: she has moved on (dead reckoning is 128-01). */
    maxReportAgeSec: 600,
    /** Further ahead than this is SAFE, whatever the CPA. */
    horizonMin: 60,
});

export const COLLISION_PREF_LIMITS = Object.freeze({
    cpaNm: Object.freeze({ min: 0.05, max: 3 }),
    tcpaMin: Object.freeze({ min: 1, max: 60 }),
});

function clampOr(value: unknown, fallback: number, limits: { min: number; max: number }): number {
    const n = finite(value);
    return n === null ? fallback : Math.min(limits.max, Math.max(limits.min, n));
}

function pairFrom(raw: unknown, fallback: CollisionPair): CollisionPair {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return {
        cpaNm: clampOr(r.cpaNm, fallback.cpaNm, COLLISION_PREF_LIMITS.cpaNm),
        tcpaMin: clampOr(r.tcpaMin, fallback.tcpaMin, COLLISION_PREF_LIMITS.tcpaMin),
    };
}

/** Saved thresholds, read defensively: anything unreadable is the default, the rest is clamped. */
export function sanitiseCollisionPrefs(raw: unknown): CollisionPrefs {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return {
        offshore: pairFrom(r.offshore, DEFAULT_COLLISION_PREFS.offshore),
        inshore: pairFrom(r.inshore, DEFAULT_COLLISION_PREFS.inshore),
    };
}

export type CollisionPairName = 'inshore' | 'offshore';

/**
 * Which of the skipper's pairs applies at our own speed, given the pair that
 * applied last (null: no history). Unknown speed keeps the last pair.
 */
export function collisionPairFor(ownSogKn: number | null, previous: CollisionPairName | null): CollisionPairName {
    const rule = COLLISION_RULE;
    if (ownSogKn === null || !Number.isFinite(ownSogKn)) return previous ?? 'inshore';
    if (previous === 'offshore') return ownSogKn < rule.inshoreBelowOwnSogKn ? 'inshore' : 'offshore';
    return ownSogKn >= rule.offshoreFromOwnSogKn ? 'offshore' : 'inshore';
}

/**
 * What our own motion lets the rule do: 'unknown' gives no CPA at all,
 * 'stopped' (under 0.5 kn) is awareness only, never an alarm.
 */
export function ownMotionState(sogKn: number | null, cogDeg: number | null): 'moving' | 'stopped' | 'unknown' {
    const sog = aisSogKn(sogKn);
    if (sog === null) return 'unknown';
    if (sog < COLLISION_RULE.ownStoppedBelowKn) return 'stopped';
    return aisCogDeg(cogDeg) === null ? 'unknown' : 'moving';
}

// ── Geometry ────────────────────────────────────────────────────────────────

const RAD = Math.PI / 180;
const EARTH_RADIUS_NM = 3440.065;

/** Longitude difference wrapped to [-180, 180): the antimeridian is just another meridian. */
function lonDelta(fromLon: number, toLon: number): number {
    return ((((toLon - fromLon + 180) % 360) + 360) % 360) - 180;
}

/** Great-circle range (NM) and initial bearing (°T), as utils/navigationCalculations computes them. */
export function rangeBearing(
    fromLat: number,
    fromLon: number,
    toLat: number,
    toLon: number,
): { rangeNm: number; bearingDeg: number } {
    const dLat = (toLat - fromLat) * RAD;
    const dLon = (toLon - fromLon) * RAD;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(fromLat * RAD) * Math.cos(toLat * RAD) * Math.sin(dLon / 2) ** 2;
    const rangeNm = EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const y = Math.sin(dLon) * Math.cos(toLat * RAD);
    const x =
        Math.cos(fromLat * RAD) * Math.sin(toLat * RAD) -
        Math.sin(fromLat * RAD) * Math.cos(toLat * RAD) * Math.cos(dLon);
    const bearingDeg = (Math.atan2(y, x) / RAD + 360) % 360;
    return { rangeNm, bearingDeg };
}

function validPosition(lat: unknown, lon: unknown): boolean {
    return (
        typeof lat === 'number' &&
        typeof lon === 'number' &&
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180
    );
}

/**
 * Velocity (NM/h, east and north), or null when it is not known. A speed known
 * to be under the 'stopped' line needs no course: AIS commonly sends COG 360
 * with SOG 0, and a stopped boat dead ahead must still count.
 */
function velocity(sogKn: number | null, cogDeg: number | null): [number, number] | null {
    if (sogKn === null) return null;
    if (cogDeg === null) return sogKn < COLLISION_RULE.ownStoppedBelowKn ? [0, 0] : null;
    return [sogKn * Math.sin(cogDeg * RAD), sogKn * Math.cos(cogDeg * RAD)];
}

// ── The rule ────────────────────────────────────────────────────────────────

export type CollisionRisk = 'DANGER' | 'CAUTION' | 'SAFE' | 'NONE';

export interface CollisionGrade {
    risk: CollisionRisk;
    /** CPA < 0.1 NM and TCPA < 3 min while we're moving: alarms whatever a mute, threshold or filter says. */
    closeQuarters: boolean;
    /** Which of the skipper's pairs applied (see collisionPairFor). */
    pair: CollisionPairName;
}

/**
 * Grade one encounter. `riskLevel` in utils/cpaCalculation.ts is this.
 *
 *  - A target claiming moored / at anchor / aground (status 1, 5, 6) is
 *    believed only while its speed agrees (≤ 2 kn, inclusive). Stale 'moored'
 *    on a 12 kt ship is common, so there is no bare nav-status filter.
 *  - Diverging (TCPA < 0) is NONE; more than 60 min out is SAFE.
 *  - Our own speed under 0.5 kn: awareness only, never an alarm.
 *  - While the inshore pair applies (`pair`, else from our speed: under
 *    3 kn), targets under 0.5 kn or believed moored are berths, not traffic:
 *    they never reach the DANGER line.
 *  - Close quarters (CPA < 0.1 NM, TCPA < 3 min, us making 0.5 kn or more)
 *    always alarms, whatever the target filters, thresholds or a mute say:
 *    a stopped or berthed boat dead ahead still counts.
 */
export function gradeCollisionRisk(
    cpaNm: number,
    tcpaMin: number,
    ownSogKn: number,
    targetSogKn: number,
    targetNavStatus?: number,
    prefs: CollisionPrefs = DEFAULT_COLLISION_PREFS,
    pair?: CollisionPairName | null,
): CollisionGrade {
    const rule = COLLISION_RULE;
    const pairName = pair ?? collisionPairFor(ownSogKn, null);
    const inshore = pairName === 'inshore';
    const limits = prefs[pairName];
    const claimsStationary = targetNavStatus === 1 || targetNavStatus === 5 || targetNavStatus === 6;
    const believedStationary =
        claimsStationary && (!Number.isFinite(targetSogKn) || targetSogKn <= rule.stationaryClaimMaxSogKn);
    const berthed = inshore && (believedStationary || targetSogKn < rule.minTargetSogKn);

    const closeQuarters =
        ownSogKn >= rule.ownStoppedBelowKn &&
        tcpaMin >= 0 &&
        cpaNm < rule.closeQuarters.cpaNm &&
        tcpaMin < rule.closeQuarters.tcpaMin;
    const grade = (risk: CollisionRisk): CollisionGrade => ({ risk, closeQuarters, pair: pairName });
    if (closeQuarters) return grade('DANGER');

    if (believedStationary || tcpaMin < 0) return grade('NONE');
    if (tcpaMin > rule.horizonMin) return grade('SAFE');

    if (ownSogKn < rule.ownStoppedBelowKn) {
        return grade(cpaNm < 0.2 && tcpaMin < 10 && targetSogKn > 3 ? 'CAUTION' : 'NONE');
    }

    if (!berthed && cpaNm < limits.cpaNm && tcpaMin < limits.tcpaMin) return grade('DANGER');
    if (cpaNm < 2 * limits.cpaNm && tcpaMin < 2 * limits.tcpaMin) return grade('CAUTION');
    // Offshore keeps the long look: inside the CPA line within an hour.
    if (!inshore && cpaNm < limits.cpaNm && tcpaMin < 4 * limits.tcpaMin) return grade('CAUTION');
    return grade('SAFE');
}

/** Our own position and motion. Unknown SOG/COG is null, never 0. */
export interface CollisionVessel {
    lat: number;
    lon: number;
    sogKn: number | null;
    cogDeg: number | null;
    /** Own ship only: the pair in use (collisionPairFor's hysteresis). Absent: from our speed alone. */
    pair?: CollisionPairName | null;
}

/** A target, as reported. Raw AIS values are fine: 102.3 / 360 are read as unknown here. */
export interface CollisionTarget extends CollisionVessel {
    navStatus?: number;
    /** Seconds since the report this position came from. */
    reportAgeSec?: number | null;
    /** Where the target came from: 'local' (her own receiver), 'cloud' (network AIS), … */
    source?: string | null;
}

export type CollisionBlindReason = 'target-motion-unknown' | 'own-motion-unknown' | 'report-too-old';

export interface CollisionAssessment extends CollisionGrade {
    rangeNm: number;
    bearingDeg: number;
    /** Null when range-only: never a CPA from an unknown speed, course or a stale report. */
    cpaNm: number | null;
    tcpaMin: number | null;
    rangeOnly: boolean;
    reason: CollisionBlindReason | null;
    /** DANGER or close quarters, from a real sensor: this is what sounds. */
    alarm: boolean;
}

/**
 * Only real-sensor targets raise the alarm: AIS from the boat's own receiver
 * ('local') or the AIS network ('cloud'). App-reported boat positions (135-04)
 * never can. Radar ARPA joins in 132-02.
 */
export function collisionSourceCanAlarm(source: unknown): boolean {
    return source === 'local' || source === 'cloud';
}

/** Assess one target. Null only when either position is invalid. */
export function assessCollision(
    own: CollisionVessel,
    target: CollisionTarget,
    prefs: CollisionPrefs = DEFAULT_COLLISION_PREFS,
): CollisionAssessment | null {
    if (!validPosition(own.lat, own.lon) || !validPosition(target.lat, target.lon)) return null;
    const { rangeNm, bearingDeg } = rangeBearing(own.lat, own.lon, target.lat, target.lon);
    const ownSog = aisSogKn(own.sogKn);
    const pair = own.pair ?? collisionPairFor(ownSog, null);
    const targetSog = aisSogKn(target.sogKn);
    const ownV = velocity(ownSog, aisCogDeg(own.cogDeg));
    const targetV = velocity(targetSog, aisCogDeg(target.cogDeg));
    const age = finite(target.reportAgeSec);

    const reason: CollisionBlindReason | null = !ownV
        ? 'own-motion-unknown'
        : !targetV
          ? 'target-motion-unknown'
          : age !== null && age > COLLISION_RULE.maxReportAgeSec
            ? 'report-too-old'
            : null;
    if (reason || ownSog === null || targetSog === null || !ownV || !targetV) {
        return {
            rangeNm,
            bearingDeg,
            cpaNm: null,
            tcpaMin: null,
            risk: 'NONE',
            closeQuarters: false,
            pair,
            rangeOnly: true,
            reason: reason ?? 'target-motion-unknown',
            alarm: false,
        };
    }

    // Two boats that are both stopped are not on a collision course.
    if (ownSog < COLLISION_RULE.ownStoppedBelowKn && targetSog < COLLISION_RULE.ownStoppedBelowKn) {
        return {
            rangeNm,
            bearingDeg,
            cpaNm: rangeNm,
            tcpaMin: 0,
            risk: 'NONE',
            closeQuarters: false,
            pair,
            rangeOnly: false,
            reason: null,
            alarm: false,
        };
    }

    // Local plane centred on us, NM; east is +x, north is +y.
    const dx = lonDelta(own.lon, target.lon) * 60 * Math.cos(own.lat * RAD);
    const dy = (target.lat - own.lat) * 60;
    const dvx = targetV[0] - ownV[0];
    const dvy = targetV[1] - ownV[1];
    const dvSq = dvx * dvx + dvy * dvy;
    let tcpaHours = 0;
    let cpaNm = rangeNm;
    if (dvSq >= 0.001) {
        tcpaHours = -(dx * dvx + dy * dvy) / dvSq;
        cpaNm = Math.hypot(dx + dvx * tcpaHours, dy + dvy * tcpaHours);
    }
    const tcpaMin = tcpaHours * 60;
    const grade = gradeCollisionRisk(cpaNm, tcpaMin, ownSog, targetSog, target.navStatus, prefs, pair);
    return {
        ...grade,
        rangeNm,
        bearingDeg,
        cpaNm,
        tcpaMin,
        rangeOnly: false,
        reason: null,
        alarm: (grade.risk === 'DANGER' || grade.closeQuarters) && collisionSourceCanAlarm(target.source),
    };
}

/**
 * Whether an alarming target should sound now. A per-target mute lasts 30
 * minutes and never silences close quarters.
 */
export function collisionShouldSound(
    a: { alarm: boolean; closeQuarters: boolean },
    mutedUntilMs: number | null | undefined,
    nowMs: number,
): boolean {
    if (!a.alarm) return false;
    if (a.closeQuarters) return true;
    return !(typeof mutedUntilMs === 'number' && mutedUntilMs > nowMs);
}

/**
 * Positive evidence that an encounter is over, from a CPA computed with known
 * motion on both sides: she is opening (TCPA < 0), or well outside the pair's
 * CAUTION box (CPA at twice the line or more, or TCPA at twice the line or
 * more). A target that merely stopped being an alarm is not evidence, and
 * neither is a target the watch can no longer see: a lost contact is never a
 * passed one.
 */
export function collisionOpening(a: CollisionAssessment, prefs: CollisionPrefs = DEFAULT_COLLISION_PREFS): boolean {
    if (a.rangeOnly || a.alarm || a.cpaNm === null || a.tcpaMin === null) return false;
    if (a.tcpaMin < 0) return true;
    const limits = prefs[a.pair];
    return a.cpaNm >= 2 * limits.cpaNm || a.tcpaMin >= 2 * limits.tcpaMin;
}

// ── Distress beacons (build 125, 125-02) ────────────────────────────────────
//
// AIS-SART (a liferaft's search and rescue transmitter), AIS man-overboard and
// EPIRB-AIS beacons. Their MMSIs start 970, 972 and 974 (ITU-R M.585). Active,
// they report nav status 14 and send message 14 'SART ACTIVE' (MOB / EPIRB
// ACTIVE); in a test, status 15 and 'SART TEST'. This classifier is what the
// app's distress alarm and chart symbol use, and what the Pi's watch copies
// (126-04). Display filters (128-02) must never hide a beacon.

export type DistressKind = 'sart' | 'mob' | 'epirb';
/** Active: alarms (from her own receiver). Test: shown, never an alarm. Caution: a beacon's MMSI, status unclear. */
export type DistressState = 'active' | 'test' | 'caution';

/** ITU nav status 14: 'AIS-SART (active), MOB-AIS, EPIRB-AIS'. */
export const AIS_NAV_STATUS_DISTRESS_ACTIVE = 14;

/** A beacon's kind from its MMSI (970 / 972 / 974 and six more digits), else null. */
export function distressKindOfMmsi(mmsi: unknown): DistressKind | null {
    const n = finite(mmsi);
    if (n === null || !Number.isInteger(n) || n < 970_000_000 || n > 974_999_999) return null;
    const prefix = Math.floor(n / 1_000_000);
    return prefix === 970 ? 'sart' : prefix === 972 ? 'mob' : prefix === 974 ? 'epirb' : null;
}

/** A target the store must never drop: a beacon's MMSI, or any target reporting status 14. */
export function aisTargetIsDistressBeacon(mmsi: unknown, navStatus: unknown): boolean {
    return distressKindOfMmsi(mmsi) !== null || finite(navStatus) === AIS_NAV_STATUS_DISTRESS_ACTIVE;
}

const DISTRESS_KIND_WORD = /\b(?:AIS[- ]?)?(SART|MOB|EPIRB)\b/;

/**
 * What a message 14 text says: active or test, and the beacon it names. From a
 * beacon's MMSI any ACTIVE or TEST counts; from any other MMSI only text that
 * names the beacon does (stations broadcast 'RANGE ACTIVE' too). A text saying
 * both is a test: a test never alarms.
 */
export function distressTextSignal(
    text: unknown,
    mmsi: unknown,
): { state: 'active' | 'test'; kind: DistressKind | null } | null {
    if (typeof text !== 'string') return null;
    const upper = text.toUpperCase();
    const test = /\bTEST\b/.test(upper);
    if (!test && !/\bACTIVE\b/.test(upper)) return null;
    const word = DISTRESS_KIND_WORD.exec(upper)?.[1];
    const kind: DistressKind | null =
        word === 'SART' ? 'sart' : word === 'MOB' ? 'mob' : word === 'EPIRB' ? 'epirb' : null;
    if (!kind && distressKindOfMmsi(mmsi) === null) return null;
    return { state: test ? 'test' : 'active', kind };
}

/** What is known of one target, for the classifier. */
export interface DistressEvidence {
    mmsi: number;
    /** Nav status from a position report; null when none has been heard. */
    navStatus?: number | null;
    /** When that position report was heard (epoch ms). */
    navStatusAt?: number | null;
    /** Its latest message 14 text, and when that was heard. */
    safetyText?: string | null;
    safetyTextAt?: number | null;
    /** 'local' (the boat's own receiver) or 'cloud' (internet AIS). Anything else is not a beacon. */
    source?: string | null;
    hasPosition: boolean;
}

export interface DistressClass {
    kind: DistressKind;
    state: DistressState;
    /** Active and heard by the boat's own receiver: this sounds, at any range. */
    sounds: boolean;
    /** Seen only over the internet: red and silent, never an alarm (a far or spoofed beacon). */
    relayed: boolean;
    /** False: alarms as 'position not yet received', with nothing to go to. */
    positionKnown: boolean;
}

/**
 * Classify one target, or null when it is not a beacon. Status 14 or an ACTIVE
 * text is active; status 15 on a beacon's MMSI or a TEST text is a test; when
 * both were heard, whichever was heard last decides (a test beacon switched to
 * active alarms on its first active report; at the same moment, active wins).
 * A beacon's MMSI with neither is a caution. Only 'local' active sounds.
 */
export function classifyDistress(e: DistressEvidence): DistressClass | null {
    if (e.source !== 'local' && e.source !== 'cloud') return null;
    const mmsiKind = distressKindOfMmsi(e.mmsi);
    const text = distressTextSignal(e.safetyText, e.mmsi);
    const status = finite(e.navStatus);
    const fromStatus = status === AIS_NAV_STATUS_DISTRESS_ACTIVE ? 'active' : status === 15 && mmsiKind ? 'test' : null;
    let state: DistressState | null;
    if (fromStatus && text) {
        const statusAt = finite(e.navStatusAt) ?? 0;
        const textAt = finite(e.safetyTextAt) ?? 0;
        if (statusAt === textAt) state = fromStatus === 'active' || text.state === 'active' ? 'active' : 'test';
        else state = textAt > statusAt ? text.state : fromStatus;
    } else {
        state = fromStatus ?? text?.state ?? (mmsiKind ? 'caution' : null);
    }
    if (!state) return null;
    const local = e.source === 'local';
    return {
        // Status 14 is 'AIS-SART (active)' in ITU's table: an unexpected MMSI still reads as one.
        kind: mmsiKind ?? text?.kind ?? 'sart',
        state,
        sounds: state === 'active' && local,
        relayed: !local,
        positionKnown: e.hasPosition,
    };
}
