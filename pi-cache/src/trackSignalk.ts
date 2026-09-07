/**
 * Reading the boat off Signal K for the always-on track.
 *
 * Signal K speaks SI throughout and the log speaks the units a skipper reads,
 * so every field is converted here and nowhere else. Measured against Calypso's
 * live document on 2026-08-30: speeds in m/s, angles in RADIANS, temperature in
 * KELVIN. A missed conversion would not throw — it would quietly record 290.85
 * as a sea temperature for years.
 *
 * WHAT THE BUS ACTUALLY OFFERS, measured rather than assumed:
 *   present  navigation.position, navigation.datetime, speedOverGround,
 *            courseOverGroundTrue, speedThroughWater, headingTrue,
 *            headingMagnetic, environment.wind.speedTrue,
 *            environment.wind.directionTrue, environment.water.temperature
 *   ABSENT   navigation.attitude — Signal K does not map Yacht Devices' XDR
 *            form, which is the same reason the app can only show heel by
 *            parsing the raw passthrough. Heel is therefore null here until
 *            either Signal K learns the mapping or this reader also listens to
 *            10110. The column exists and the code handles it, so the day it
 *            appears nothing else changes.
 *   ABSENT   environment.depth.* — the transducer is dry with the boat on the
 *            hard. This one fills itself in the moment she floats.
 *   ABSENT   environment.outside.pressure — Serene Summer's MDA carries empty
 *            pressure fields. Other boats will have it.
 */

import { fetchSelfDocument, type BroadcastDeps } from './anchorBroadcaster.js';
import { DEFAULT_TRACK_RULES, type TrackFix } from './trackRecorder.js';

const MS_TO_KNOTS = 1.94384;
const RAD_TO_DEG = 180 / Math.PI;
const KELVIN_OFFSET = 273.15;

/**
 * Walk a Signal K path, unwrapping its { meta, value, timestamp, $source }
 * envelopes as it goes.
 *
 * The unwrapping has to happen at EVERY step, not just the last one. Signal K
 * nests position as `position: { meta, value: { latitude, longitude } }`, so a
 * walker that only unwraps at the end returns undefined for
 * `navigation.position.latitude` — and this reader would then have declined
 * every fix and recorded an empty track for ever, without erroring once.
 * Caught by testing against Calypso's real document rather than a handwritten
 * one (2026-08-30).
 */
export function valueAt(doc: unknown, path: string): unknown {
    let cur: unknown = doc;
    for (const key of path.split('.')) {
        if (typeof cur !== 'object' || cur === null) return undefined;
        let node = cur as Record<string, unknown>;
        if (!(key in node) && typeof node.value === 'object' && node.value !== null) {
            node = node.value as Record<string, unknown>;
        }
        if (!(key in node)) return undefined;
        cur = node[key];
    }
    if (typeof cur === 'object' && cur !== null && 'value' in (cur as Record<string, unknown>)) {
        return (cur as Record<string, unknown>).value;
    }
    return cur;
}

export function num(doc: unknown, path: string): number | null {
    const v = valueAt(doc, path);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export const knots = (msValue: number | null): number | null => (msValue === null ? null : msValue * MS_TO_KNOTS);

/** Radians to a compass bearing, normalised so nothing downstream sees -3°. */
export function degrees(rad: number | null): number | null {
    if (rad === null) return null;
    return (((rad * RAD_TO_DEG) % 360) + 360) % 360;
}

/**
 * Build a track fix from a Signal K self document.
 *
 * Returns null only when there is no usable POSITION — everything else is
 * optional colour and a missing instrument is a null column, not a lost point.
 */
export function readTrackFix(selfDocument: unknown): TrackFix | null {
    const lat = num(selfDocument, 'navigation.position.latitude');
    const lon = num(selfDocument, 'navigation.position.longitude');
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    // Null Island is a coordinate, not a position.
    if (lat === 0 && lon === 0) return null;

    /* GPS time, never the system clock. A Pi has no RTC battery, so a boot
       without network time would stamp the whole track from 1970 — misfiled
       for ever, and silently. navigation.datetime is the GPS's own time
       ($YDZDA / $YDRMC on this bus). No datetime, no recordable fix. */
    const iso = valueAt(selfDocument, 'navigation.datetime');
    const parsed = typeof iso === 'string' ? Date.parse(iso) : NaN;
    const gpsTimeMs = Number.isFinite(parsed) ? parsed : null;

    const sogKts = knots(num(selfDocument, 'navigation.speedOverGround'));

    /* A stopped boat's COG is noise — it swings the whole compass while she
       lies to her anchor. Recording it would be recording the weathervane, and
       it would make every gust look like a turn. */
    const moving = sogKts !== null && sogKts > DEFAULT_TRACK_RULES.stationarySpeedKts;
    const cogDeg = moving ? degrees(num(selfDocument, 'navigation.courseOverGroundTrue')) : null;

    /* TRUE heading for preference, because COG above is true. Mixing a
       magnetic heading with a true course would turn the difference between
       them — the leeway and set this log exists to capture — into the local
       magnetic variation, which is 11°E here and would look like a permanent
       current setting east. */
    const headingTrue = num(selfDocument, 'navigation.headingTrue');
    const hdgDeg = degrees(headingTrue);

    const waterK = num(selfDocument, 'environment.water.temperature');
    const pressurePa = num(selfDocument, 'environment.outside.pressure');
    const rollRad = num(selfDocument, 'navigation.attitude.roll');

    return {
        lat,
        lon,
        gpsTimeMs,
        sogKts,
        cogDeg,
        depthM: num(selfDocument, 'environment.depth.belowTransducer'),
        twsKts: knots(num(selfDocument, 'environment.wind.speedTrue')),
        twdDeg: degrees(num(selfDocument, 'environment.wind.directionTrue')),
        stwKts: knots(num(selfDocument, 'navigation.speedThroughWater')),
        hdgDeg,
        waterTempC: waterK === null ? null : waterK - KELVIN_OFFSET,
        pressureHpa: pressurePa === null ? null : pressurePa / 100,
        heelDeg: rollRad === null ? null : rollRad * RAD_TO_DEG,
    };
}

/** Ask Signal K for the boat, as a track fix. */
export async function currentTrackFix(deps: BroadcastDeps): Promise<TrackFix | null> {
    const doc = await fetchSelfDocument(deps);
    return doc === null ? null : readTrackFix(doc);
}

// ── The whole bus, for the cloud snapshot ────────────────────────────────

/** Everything the Instrument Panel draws, in the units it draws them in. */
export interface TelemetrySnapshot {
    /** ISO time of the reading: GPS time when the bus offers it, else the Pi's clock. */
    reportedAt: string;
    lat: number | null;
    lon: number | null;
    sogKts: number | null;
    cogDeg: number | null;
    headingDeg: number | null;
    stwKts: number | null;
    twsKts: number | null;
    /** Signed, negative to port — Signal K's angleTrueWater is already signed. */
    twaDeg: number | null;
    twdDeg: number | null;
    awsKts: number | null;
    /** Signed, negative to port. */
    awaDeg: number | null;
    depthM: number | null;
    heelDeg: number | null;
    pitchDeg: number | null;
    waterTempC: number | null;
    pressureHpa: number | null;
    rudderDeg: number | null;
    rpm: number | null;
    voltageV: number | null;
}

/** A signed angle in radians to degrees in -180..180, unlike `degrees()` which makes a bearing. */
function signedDegrees(rad: number | null): number | null {
    if (rad === null) return null;
    const d = ((((rad * RAD_TO_DEG) % 360) + 540) % 360) - 180;
    return d === -180 ? 180 : d;
}

/** First child of a Signal K collection (propulsion.*, electrical.batteries.*) that has `leaf`. */
function firstChildNumber(doc: unknown, collectionPath: string, leaf: string): number | null {
    const collection = valueAt(doc, collectionPath);
    if (typeof collection !== 'object' || collection === null) return null;
    for (const key of Object.keys(collection as Record<string, unknown>)) {
        if (key === 'meta' || key === 'value' || key === 'timestamp' || key === '$source') continue;
        const v = num(collection, `${key}.${leaf}`);
        if (v !== null) return v;
    }
    return null;
}

/**
 * Read the boat's whole bus off a Signal K self document for the cloud
 * snapshot (services/CloudTelemetryService on the phones, vessel_telemetry in
 * the cloud). null when the document offers nothing at all.
 */
export function readTelemetrySnapshot(selfDocument: unknown, now: () => number = Date.now): TelemetrySnapshot | null {
    const latRaw = num(selfDocument, 'navigation.position.latitude');
    const lonRaw = num(selfDocument, 'navigation.position.longitude');
    const hasPosition =
        latRaw !== null &&
        lonRaw !== null &&
        Math.abs(latRaw) <= 90 &&
        Math.abs(lonRaw) <= 180 &&
        !(latRaw === 0 && lonRaw === 0);

    const iso = valueAt(selfDocument, 'navigation.datetime');
    const gpsMs = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
    const reportedAt = new Date(Number.isFinite(gpsMs) ? gpsMs : now()).toISOString();

    const waterK = num(selfDocument, 'environment.water.temperature');
    const pressurePa = num(selfDocument, 'environment.outside.pressure');
    const revolutionsHz = firstChildNumber(selfDocument, 'propulsion', 'revolutions');

    const snapshot: TelemetrySnapshot = {
        reportedAt,
        lat: hasPosition ? latRaw : null,
        lon: hasPosition ? lonRaw : null,
        sogKts: knots(num(selfDocument, 'navigation.speedOverGround')),
        cogDeg: degrees(num(selfDocument, 'navigation.courseOverGroundTrue')),
        headingDeg: degrees(
            num(selfDocument, 'navigation.headingTrue') ?? num(selfDocument, 'navigation.headingMagnetic'),
        ),
        stwKts: knots(num(selfDocument, 'navigation.speedThroughWater')),
        twsKts: knots(num(selfDocument, 'environment.wind.speedTrue')),
        twaDeg: signedDegrees(num(selfDocument, 'environment.wind.angleTrueWater')),
        twdDeg: degrees(num(selfDocument, 'environment.wind.directionTrue')),
        awsKts: knots(num(selfDocument, 'environment.wind.speedApparent')),
        awaDeg: signedDegrees(num(selfDocument, 'environment.wind.angleApparent')),
        depthM:
            num(selfDocument, 'environment.depth.belowTransducer') ??
            num(selfDocument, 'environment.depth.belowSurface'),
        heelDeg: signedDegrees(num(selfDocument, 'navigation.attitude.roll')),
        pitchDeg: signedDegrees(num(selfDocument, 'navigation.attitude.pitch')),
        waterTempC: waterK === null ? null : waterK - KELVIN_OFFSET,
        pressureHpa: pressurePa === null ? null : pressurePa / 100,
        rudderDeg: signedDegrees(num(selfDocument, 'steering.rudderAngle')),
        rpm: revolutionsHz === null ? null : revolutionsHz * 60,
        voltageV: firstChildNumber(selfDocument, 'electrical.batteries', 'voltage'),
    };
    const anything = Object.entries(snapshot).some(([key, value]) => key !== 'reportedAt' && value !== null);
    return anything ? snapshot : null;
}
