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
 *            form. On this yacht the EV-1 supplies heel/trim (skipper-confirmed),
 *            carried as XDR Roll/Pitch on the existing localhost passthrough.
 *            onboardSensors supplements this reader from the existing decoder's
 *            timestamped export, without opening another gateway connection.
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
export const TRUE_HEADING_MAX_AGE_MS = 15_000;

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

/** Closest Signal K envelope timestamp, including parent attitude.value objects. */
export function timestampAt(doc: unknown, path: string, inherit = true): number | null {
    let node: unknown = doc;
    let stamp: number | null = null;
    for (const key of [...path.split('.'), '']) {
        if (!node || typeof node !== 'object') break;
        let record = node as Record<string, unknown>;
        if ('timestamp' in record && (inherit || !key))
            stamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
        if (!key) break;
        if (!(key in record) && record.value && typeof record.value === 'object')
            record = record.value as Record<string, unknown>;
        node = record[key];
    }
    return stamp !== null && Number.isFinite(stamp) ? stamp : null;
}

export const knots = (msValue: number | null): number | null => (msValue === null ? null : msValue * MS_TO_KNOTS);

/** Radians to a compass bearing, normalised so nothing downstream sees -3°. */
export function degrees(rad: number | null): number | null {
    if (rad === null) return null;
    return (((rad * RAD_TO_DEG) % 360) + 360) % 360;
}

/** Bow orientation is not COG. These explicitly true-north fields are separate
 * from the legacy headingDeg, which historically allowed magnetic fallback.
 * Signal K uses radians and true = magnetic + east-positive variation:
 * https://signalk.org/specification/1.5.0/doc/vesselsBranch.html
 * A current GPS/HTTP timestamp cannot revive a cached heading sensor value. */
function readTrueHeadingExtra(doc: unknown, nowMs: number): Record<string, number> {
    const reading = (path: string, min: number, max: number) => {
        const value = num(doc, path);
        const at = timestampAt(doc, path, false);
        if (
            value === null ||
            value < min ||
            value > max ||
            at === null ||
            at <= 0 ||
            at > nowMs ||
            nowMs - at >= TRUE_HEADING_MAX_AGE_MS
        )
            return null;
        return { value, at };
    };
    const direct = reading('navigation.headingTrue', 0, 2 * Math.PI);
    if (direct) return { heading_true_deg: degrees(direct.value)!, heading_true_at_ms: direct.at };

    const magnetic = reading('navigation.headingMagnetic', 0, 2 * Math.PI);
    const variation = reading('navigation.magneticVariation', -Math.PI, Math.PI);
    if (!magnetic || !variation) return {};
    return {
        heading_true_deg: degrees(magnetic.value + variation.value)!,
        // Preserve the heading sensor's own time, never receipt/report time.
        heading_true_at_ms: magnetic.at,
    };
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
    /** Explicitly named supplemental sensors; no guessed SOC or public device identifiers. */
    extra?: Record<string, number | string>;
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

/** Signal K's standardized methodQuality values (the GGA adapter's 0..8 codes). */
const GNSS_FIX_QUALITY = [
    'no GPS',
    'GNSS Fix',
    'DGNSS fix',
    'Precise GNSS',
    'RTK fixed integer',
    'RTK float',
    'Estimated (DR) mode',
    'Manual input',
    'Simulator mode',
];

/** Match the exact receiver of the position we actually publish, not another
 * GPS that happened to write the quality path last. Signal K source keys may
 * contain dots, so values[source] must not go through the path walker. */
function readGnssExtra(doc: unknown, nowMs: number): Record<string, number | string> {
    const source = valueAt(doc, 'navigation.position.$source');
    if (typeof source !== 'string' || !source.trim() || source.length > 120 || /\p{Cc}/u.test(source)) return {};
    const navigation = (doc as { navigation?: { gnss?: Record<string, unknown> } } | null)?.navigation;
    const gnss = navigation?.gnss;
    const extra: Record<string, number | string> = {};
    for (const [leaf, key] of [
        ['satellites', 'gnss_satellites'],
        ['horizontalDilution', 'gnss_hdop'],
        ['methodQuality', 'gnss_fix_quality'],
    ]) {
        const raw = gnss?.[leaf];
        if (!raw || typeof raw !== 'object') continue;
        const envelope = raw as Record<string, unknown>;
        const values = envelope.values;
        const perSource =
            values && typeof values === 'object' ? (values as Record<string, unknown>)[source] : undefined;
        const selected = perSource ?? (envelope.$source === source ? envelope : undefined);
        if (!selected || typeof selected !== 'object') continue;
        const node = selected as Record<string, unknown>;
        const at = typeof node.timestamp === 'string' ? Date.parse(node.timestamp) : NaN;
        if (!Number.isFinite(at) || at <= 0 || at > nowMs + 1_000 || nowMs - at > 13_000) continue;
        const value =
            leaf === 'methodQuality'
                ? typeof node.value === 'string'
                    ? GNSS_FIX_QUALITY.indexOf(node.value)
                    : -1
                : node.value;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
        if (leaf === 'satellites' && (!Number.isInteger(value) || value > 256)) continue;
        if (leaf === 'horizontalDilution' && value > 100) continue;
        extra[key] = value;
        extra[`${key}_at_ms`] = at;
    }
    // HDOP is dimensionless, not metres. No standardized Signal K horizontal
    // accuracy path exists; leave metres absent unless an actual receiver
    // extension is explicitly supported in a future change.
    if (Object.keys(extra).length) extra.gnss_source = source;
    return extra;
}

/**
 * Read the boat's whole bus off a Signal K self document for the cloud
 * snapshot (services/CloudTelemetryService on the phones, vessel_telemetry in
 * the cloud). null when the document offers nothing at all.
 */
export function readTelemetrySnapshot(selfDocument: unknown, now: () => number = Date.now): TelemetrySnapshot | null {
    const nowMs = now();
    const extra: Record<string, number | string> = {
        ...readGnssExtra(selfDocument, nowMs),
        ...readTrueHeadingExtra(selfDocument, nowMs),
    };
    // The wind record must deduplicate the actual sensor envelope, not a
    // freshly fetched copy of Signal K's cached value or its current GPS clock.
    const twsAt = timestampAt(selfDocument, 'environment.wind.speedTrue', false);
    const twsKts = knots(num(selfDocument, 'environment.wind.speedTrue'));
    if (
        twsAt !== null &&
        twsAt > 0 &&
        twsAt <= nowMs &&
        nowMs - twsAt <= 20_000 &&
        twsKts !== null &&
        twsKts >= 0 &&
        twsKts <= 150
    ) {
        const twsSource = valueAt(selfDocument, 'environment.wind.speedTrue.$source');
        if (
            typeof twsSource === 'string' &&
            twsSource.trim() &&
            twsSource.length <= 120 &&
            !/\p{Cc}/u.test(twsSource)
        ) {
            extra.wind_tws_at_ms = twsAt;
            extra.wind_tws_source = twsSource.trim();
        }
    }
    const attitude = (axis: 'roll' | 'pitch', key: 'heel_at' | 'pitch_at'): number | null => {
        const path = `navigation.attitude.${axis}`;
        const at = timestampAt(selfDocument, path);
        if (at === null || at > nowMs + 5_000 || nowMs - at > 30_000) return null;
        const value = signedDegrees(num(selfDocument, path));
        if (value !== null && Math.abs(value) <= 90) {
            extra[key] = at;
            return value;
        }
        return null;
    };
    const latRaw = num(selfDocument, 'navigation.position.latitude');
    const lonRaw = num(selfDocument, 'navigation.position.longitude');
    const hasPosition =
        latRaw !== null &&
        lonRaw !== null &&
        Math.abs(latRaw) <= 90 &&
        Math.abs(lonRaw) <= 180 &&
        !(latRaw === 0 && lonRaw === 0);

    // A current ZDA clock does not prove the cached GPS position is current.
    // The public vessel clock may use this fix only with its own source time.
    const positionAt = timestampAt(selfDocument, 'navigation.position', false);
    if (hasPosition && positionAt !== null && positionAt <= nowMs + 5_000 && nowMs - positionAt < 600_000) {
        extra.position_at = positionAt;
    }

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
        heelDeg: attitude('roll', 'heel_at'),
        pitchDeg: attitude('pitch', 'pitch_at'),
        waterTempC: waterK === null ? null : waterK - KELVIN_OFFSET,
        pressureHpa: pressurePa === null ? null : pressurePa / 100,
        rudderDeg: signedDegrees(num(selfDocument, 'steering.rudderAngle')),
        rpm: revolutionsHz === null ? null : revolutionsHz * 60,
        voltageV: firstChildNumber(selfDocument, 'electrical.batteries', 'voltage'),
    };
    const anything = Object.entries(snapshot).some(([key, value]) => key !== 'reportedAt' && value !== null);
    if (Object.keys(extra).length) snapshot.extra = extra;
    return anything ? snapshot : null;
}
