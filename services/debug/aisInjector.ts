/**
 * Debug AIS injector — DEVICE SMOKE BUILDS ONLY (build 125, 125-01 item 11).
 *
 * Package 125-11's locked-phone + Focus smoke needs a ship on a collision
 * course, on demand, with the phone in a pocket. This puts a fictional one
 * there through the REAL receiver path: genuine !AIVDM sentences (checksummed,
 * ITU-R M.1371 bit layout) into processAisSentence and AisStore, exactly as
 * the boat's radio would deliver them, so the decoder, the store, the guard's
 * pass, the collision rule, the alarm sound and the Time Sensitive alert are
 * all the production code.
 *
 * It is compiled ONLY when the build runs with THALASSA_DEBUG_AIS_INJECTOR=1.
 * Everything reaches it through components/settings/debugAisInjectorGate.ts,
 * whose build-time constant folds to false in every other build, and the
 * production build fails if this file's marker turns up in a chunk anyway
 * (scripts/debug-ais-injector-fence.mjs, tests/DebugAisInjectorRelease.test.ts).
 *
 * AT A BERTH the rule cannot alarm (it is awareness only under 0.5 kn), and
 * Shane runs the smoke at a marina dock. So when we are not making way the
 * injector also gives the rule a fictional own motion (5 kn on our heading,
 * else north) through ownshipPosition's smoke-only override, and feeds her
 * positions along the RELATIVE track: with our real position fixed, she
 * closes exactly as a crossing ship would on a boat making that motion, CPA
 * ~0 at the stated time. The panel says so plainly.
 *
 * Fictional vessels only: MMSIs in MID 123, which is not allocated to any
 * country, and names nobody sails under. This repository is public.
 *
 * Build 125, 125-02: a fictional AIS-SART too (970 + manufacturer 00), in test
 * mode (status 15, 'SART TEST') or active (status 14, 'SART ACTIVE'), drifting
 * so Go to it has a moving mark. Starting it active after test is the
 * test-to-active switch that must sound again.
 */
import { processAisSentence } from '../AisDecoder';
import { AisStore } from '../AisStore';
import { GpsService } from '../GpsService';
import { NmeaStore } from '../NmeaStore';
import { getCachedOwnshipPosition, resolveOwnMotion, setDebugOwnMotion } from '../ownshipPosition';

/** Kept in the shipped code on purpose: the release fence looks for it. */
const MARKER = 'thalassa-debug-ais-injector';

export const DEBUG_CROSSER = { mmsi: 123456789, name: 'DEBUG CROSSER' } as const;

// ── Encoding ────────────────────────────────────────────────────────────────

class BitWriter {
    private bits: number[] = [];
    uint(value: number, length: number): this {
        for (let i = length - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2);
        return this;
    }
    int(value: number, length: number): this {
        return this.uint(value < 0 ? 2 ** length + value : value, length);
    }
    text(value: string, chars: number = value.length): this {
        const padded = value.toUpperCase().padEnd(chars, '@').slice(0, chars);
        for (const ch of padded) {
            const code = ch.charCodeAt(0);
            this.uint(code >= 64 && code < 96 ? code - 64 : code >= 32 && code < 64 ? code : 0, 6);
        }
        return this;
    }
    sentence(formatter: 'VDM' | 'VDO' = 'VDM'): string {
        const fill = (6 - (this.bits.length % 6)) % 6;
        const bits = [...this.bits, ...new Array<number>(fill).fill(0)];
        let payload = '';
        for (let i = 0; i < bits.length; i += 6) {
            const v = bits.slice(i, i + 6).reduce((acc, bit) => acc * 2 + bit, 0);
            payload += String.fromCharCode(v < 40 ? v + 48 : v + 56);
        }
        const body = `AI${formatter},1,1,,A,${payload},${fill}`;
        let checksum = 0;
        for (const ch of body) checksum ^= ch.charCodeAt(0);
        return `!${body}*${checksum.toString(16).toUpperCase().padStart(2, '0')}`;
    }
}

export interface AisPositionFields {
    mmsi: number;
    navStatus?: number;
    /** Null sends 'not available' (1023). */
    sogKn: number | null;
    lat: number;
    lon: number;
    /** Null sends 'not available' (3600). */
    cogDeg: number | null;
    /** Null sends 'not available' (511). */
    headingDeg: number | null;
}

/** A Class A position report (message 1) as a checksummed !AIVDM (or, for our own ship, !AIVDO) sentence. */
export function encodeAisPositionReport(f: AisPositionFields, formatter: 'VDM' | 'VDO' = 'VDM'): string {
    return new BitWriter()
        .uint(1, 6)
        .uint(0, 2)
        .uint(f.mmsi, 30)
        .uint(f.navStatus ?? 0, 4)
        .int(-128, 8) // rate of turn: not available
        .uint(f.sogKn === null ? 1023 : Math.min(1022, Math.round(f.sogKn * 10)), 10)
        .uint(0, 1)
        .int(Math.round(f.lon * 600_000), 28)
        .int(Math.round(f.lat * 600_000), 27)
        .uint(f.cogDeg === null ? 3600 : Math.round(f.cogDeg * 10) % 3600, 12)
        .uint(f.headingDeg === null ? 511 : Math.round(f.headingDeg) % 360, 9)
        .uint(60, 6) // time stamp: not available
        .uint(0, 2)
        .uint(0, 3)
        .uint(0, 1)
        .uint(0, 19)
        .sentence(formatter);
}

/** A Class B static report, part A (message 24): the vessel's name. */
export function encodeAisStaticName(mmsi: number, name: string): string {
    return new BitWriter().uint(24, 6).uint(0, 2).uint(mmsi, 30).uint(0, 2).text(name, 20).sentence();
}

/** A safety-related broadcast (message 14): a beacon's 'SART ACTIVE' / 'SART TEST'. */
export function encodeAisSafetyText(mmsi: number, text: string): string {
    return new BitWriter().uint(14, 6).uint(0, 2).uint(mmsi, 30).uint(0, 2).text(text.slice(0, 161)).sentence();
}

// ── The crossing scenario ───────────────────────────────────────────────────

function project(lat: number, lon: number, bearingDeg: number, distNm: number): { lat: number; lon: number } {
    const b = (bearingDeg * Math.PI) / 180;
    const nextLat = lat + (distNm * Math.cos(b)) / 60;
    const nextLon = lon + (distNm * Math.sin(b)) / (60 * Math.cos((lat * Math.PI) / 180));
    return { lat: nextLat, lon: ((((nextLon + 180) % 360) + 360) % 360) - 180 };
}

export interface CrossingPlan {
    start: { lat: number; lon: number };
    courseDeg: number;
    speedKn: number;
}

/**
 * A target from our starboard side that reaches the point we will be at in
 * `minutes` at the same moment (CPA ~0). Needs us making way: see
 * planDebugCrossing for a berth.
 */
export function planCrossing(
    own: { lat: number; lon: number; sogKn: number | null; cogDeg: number | null },
    minutes = 8,
    speedKn = 10,
): CrossingPlan {
    const ourCourse = own.cogDeg ?? 0;
    const moving = own.sogKn !== null && own.sogKn >= 0.5 && own.cogDeg !== null;
    const meet = moving ? project(own.lat, own.lon, ourCourse, (own.sogKn! * minutes) / 60) : own;
    const start = project(meet.lat, meet.lon, (ourCourse + 90) % 360, (speedKn * minutes) / 60);
    return { start, courseDeg: (ourCourse + 270) % 360, speedKn };
}

/** The fictional own motion a berth smoke runs with. */
export const DEBUG_OWN_MOTION_KN = 5;
const CROSSING_MINUTES = 8;
const CROSSER_KN = 10;

export interface DebugCrossing {
    /** 'under-way': our real motion; 'berth': a fictional own motion for the rule. */
    mode: 'under-way' | 'berth';
    /** What the rule is told about us for the run (the real motion when under way). */
    ownMotion: { sogKn: number; cogDeg: number };
    /** Her reported speed and course (her real ones, not the relative track's). */
    speedKn: number;
    courseDeg: number;
    /** Where she is reported `elapsedMs` after the start. */
    positionAt(elapsedMs: number): { lat: number; lon: number };
    /** The panel's sentence. */
    summary: string;
}

/**
 * The smoke's crossing, from where we are and how we are moving. Pure, so a
 * test can prove the scenario as started really alarms, at a berth too.
 */
export function planDebugCrossing(
    position: { lat: number; lon: number },
    motion: { sogKn: number | null; cogDeg: number | null },
    minutes = CROSSING_MINUTES,
    speedKn = CROSSER_KN,
): DebugCrossing {
    const underWay = motion.sogKn !== null && motion.sogKn >= 0.5 && motion.cogDeg !== null;
    const summary = `${DEBUG_CROSSER.name} is crossing from starboard at ${speedKn} kn, CPA about 0 in ${minutes} min.`;
    if (underWay) {
        const plan = planCrossing({ ...position, sogKn: motion.sogKn, cogDeg: motion.cogDeg }, minutes, speedKn);
        return {
            mode: 'under-way',
            ownMotion: { sogKn: motion.sogKn!, cogDeg: motion.cogDeg! },
            speedKn,
            courseDeg: plan.courseDeg,
            positionAt: (elapsedMs) =>
                project(plan.start.lat, plan.start.lon, plan.courseDeg, (speedKn * elapsedMs) / 3_600_000),
            summary,
        };
    }
    // At a berth: our position stays put, so she moves along the relative
    // track (her velocity minus the fictional own velocity) to arrive at our
    // position in `minutes`, which is CPA 0 for a boat making that motion.
    const ourCourse = motion.cogDeg ?? 0;
    const courseDeg = (ourCourse + 270) % 360;
    const rad = Math.PI / 180;
    const relEast = speedKn * Math.sin(courseDeg * rad) - DEBUG_OWN_MOTION_KN * Math.sin(ourCourse * rad);
    const relNorth = speedKn * Math.cos(courseDeg * rad) - DEBUG_OWN_MOTION_KN * Math.cos(ourCourse * rad);
    const relKn = Math.hypot(relEast, relNorth);
    const relCourse = (Math.atan2(relEast, relNorth) / rad + 360) % 360;
    const start = project(position.lat, position.lon, (relCourse + 180) % 360, (relKn * minutes) / 60);
    return {
        mode: 'berth',
        ownMotion: { sogKn: DEBUG_OWN_MOTION_KN, cogDeg: ourCourse },
        speedKn,
        courseDeg,
        positionAt: (elapsedMs) => project(start.lat, start.lon, relCourse, (relKn * elapsedMs) / 3_600_000),
        summary: `${summary} We are not making way, so for this test the alarm is told we make ${DEBUG_OWN_MOTION_KN} kn on ${String(Math.round(ourCourse)).padStart(3, '0')}°.`,
    };
}

const UPDATE_MS = 2_000;
const RUN_MS = 16 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let sartTimer: ReturnType<typeof setInterval> | null = null;

/** The smoke's beacon: 970, manufacturer 00, a serial nobody carries. */
export const DEBUG_SART = { mmsi: 970_000_901 } as const;
const SART_OFF_NM = 1.5;
const SART_OFF_DEG = 45;
const SART_DRIFT_KN = 1;
const SART_DRIFT_DEG = 90;
/** A real SART repeats its position in bursts every minute and its text every few; this is close enough. */
const SART_POSITION_MS = 4_000;
const SART_TEXT_MS = 60_000;

function feed(sentence: string): void {
    const decoded = processAisSentence(sentence);
    if (decoded) AisStore.update(decoded);
}

/** Start the crossing target. Returns a sentence for the panel, never throws. */
export function startDebugCrossing(): string {
    // Its own run only: a beacon already running keeps going, so the smoke can
    // hear the distress and collision alarms together.
    if (timer) clearInterval(timer);
    timer = null;
    setDebugOwnMotion(null);
    const position = getCachedOwnshipPosition();
    if (!position) return 'No position fix: the injector needs one to place her.';
    const crossing = planDebugCrossing(
        position,
        resolveOwnMotion(NmeaStore.getState(), GpsService.getLastKnownPosition()),
    );
    const startedAt = Date.now();
    if (crossing.mode === 'berth') setDebugOwnMotion({ ...crossing.ownMotion, until: startedAt + RUN_MS });
    const tick = () => {
        const elapsed = Date.now() - startedAt;
        if (elapsed > RUN_MS) {
            if (timer) clearInterval(timer);
            timer = null;
            setDebugOwnMotion(null);
            return;
        }
        const at = crossing.positionAt(elapsed);
        feed(
            encodeAisPositionReport({
                mmsi: DEBUG_CROSSER.mmsi,
                navStatus: 0,
                sogKn: crossing.speedKn,
                lat: at.lat,
                lon: at.lon,
                cogDeg: crossing.courseDeg,
                headingDeg: crossing.courseDeg,
            }),
        );
    };
    feed(encodeAisStaticName(DEBUG_CROSSER.mmsi, DEBUG_CROSSER.name));
    tick();
    timer = setInterval(tick, UPDATE_MS);
    console.warn(`[${MARKER}] fictional crossing target started (${crossing.mode})`);
    return crossing.summary;
}

/**
 * Start the fictional AIS-SART 1.5 NM off on 045°, drifting east at 1 kn,
 * in test or active mode. Returns a sentence for the panel, never throws.
 */
export function startDebugSart(mode: 'active' | 'test'): string {
    if (sartTimer) clearInterval(sartTimer);
    sartTimer = null;
    const position = getCachedOwnshipPosition();
    if (!position) return 'No position fix: the injector needs one to place the beacon.';
    const start = project(position.lat, position.lon, SART_OFF_DEG, SART_OFF_NM);
    const startedAt = Date.now();
    const navStatus = mode === 'active' ? 14 : 15;
    const text = mode === 'active' ? 'SART ACTIVE' : 'SART TEST';
    let textAt = Number.NEGATIVE_INFINITY;
    const tick = () => {
        const elapsed = Date.now() - startedAt;
        if (elapsed > RUN_MS) {
            if (sartTimer) clearInterval(sartTimer);
            sartTimer = null;
            return;
        }
        const at = project(start.lat, start.lon, SART_DRIFT_DEG, (SART_DRIFT_KN * elapsed) / 3_600_000);
        feed(
            encodeAisPositionReport({
                mmsi: DEBUG_SART.mmsi,
                navStatus,
                sogKn: SART_DRIFT_KN,
                lat: at.lat,
                lon: at.lon,
                cogDeg: SART_DRIFT_DEG,
                headingDeg: null,
            }),
        );
        if (Date.now() - textAt >= SART_TEXT_MS) {
            textAt = Date.now();
            feed(encodeAisSafetyText(DEBUG_SART.mmsi, text));
        }
    };
    tick();
    sartTimer = setInterval(tick, SART_POSITION_MS);
    console.warn(`[${MARKER}] fictional AIS-SART started (${mode})`);
    return mode === 'active'
        ? `Fictional AIS-SART ${DEBUG_SART.mmsi} ACTIVE, ${SART_OFF_NM} NM on 045°, drifting east at 1 kn: the distress alarm should sound.`
        : `Fictional AIS-SART ${DEBUG_SART.mmsi} in TEST, ${SART_OFF_NM} NM on 045°: it shows on the chart, labelled test, and stays silent.`;
}

export function stopDebugAisInjector(): void {
    if (timer) clearInterval(timer);
    timer = null;
    if (sartTimer) clearInterval(sartTimer);
    sartTimer = null;
    setDebugOwnMotion(null);
}

export function debugAisInjectorRunning(): boolean {
    return timer !== null || sartTimer !== null;
}
