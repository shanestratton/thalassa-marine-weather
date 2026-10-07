import type { NmeaStoreState } from '../services/NmeaStore';
import type { GpsReceiverStatus } from '../services/GpsReceiverStatusService';
import type { WeatherFixKind, WeatherFollowTarget } from '../services/weatherPosition';
import {
    boatLiveFixMaxAgeMs,
    fixPositionLine,
    followedReceiver,
    gpsFixState,
    newestFixAt,
    validFixTime,
    type GpsBoxFixes,
    type GpsFixState,
} from './gpsFixState';
import { NMEA_USABLE_MAX_AGE_MS } from '../services/nmea/nmeaCadence';

/** A receiver-reported value and its own observation time, never receipt time. */
export interface GpsDiagnosticMetric {
    value: number | string | null;
    timestamp: number | null;
}

export interface GpsDiagnosticSource {
    label: string;
    maxAgeMs: number;
    positionMaxAgeMs?: number;
    positionAt: number | null;
    satellites?: GpsDiagnosticMetric | null;
    hdop?: GpsDiagnosticMetric | null;
    accuracyM?: GpsDiagnosticMetric | null;
    fixQuality?: GpsDiagnosticMetric | null;
    phone?: boolean;
}

export interface GpsDiagnosticValue {
    text: string;
    state: 'current' | 'stale' | 'unknown';
}

export interface GpsDiagnosticsPresentation {
    label: string;
    /** The one fix state behind the position line (and the phone's fix-quality tile). */
    fix: GpsFixState;
    position: string;
    satellites: GpsDiagnosticValue;
    quality: GpsDiagnosticValue;
    accuracy: GpsDiagnosticValue;
    hdop: GpsDiagnosticValue;
    /**
     * Nothing at all is known: no position time and no current or stale
     * reading. The card then says so once (NO_GPS_FIX_LINE) instead of a
     * position line and three tiles that each word "nothing" differently.
     */
    noFix: boolean;
}

/**
 * The one sentence for "no fix at all". System status said it five ways
 * ('Position time unavailable', 'No position yet — nothing is supplying a fix',
 * 'Not reported', 'No current fix', 'Not reported'); UX scorecard run 7.
 */
export const NO_GPS_FIX_LINE = 'No GPS fix: nothing is supplying a position';

function presentMetric(
    metric: GpsDiagnosticMetric | null | undefined,
    now: number,
    maxAgeMs: number,
    format: (value: number | string) => string | null,
): GpsDiagnosticValue {
    const unknown: GpsDiagnosticValue = { text: 'Not reported', state: 'unknown' };
    if (!metric || metric.value === null || !validFixTime(metric.timestamp, now)) return unknown;
    const text = format(metric.value);
    if (text === null) return unknown;
    if (now - metric.timestamp > maxAgeMs) return { text: 'Stale', state: 'stale' };
    return { text, state: 'current' };
}

function positiveNumber(value: number | string): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

const QUALITY_LABELS: Record<number, string> = {
    0: 'No fix',
    1: 'GPS fix',
    2: 'Differential GPS',
    4: 'RTK fixed',
    5: 'RTK float',
    6: 'Estimated position',
};

function formatQuality(value: number | string): string | null {
    if (typeof value === 'string') {
        const quality = value.trim();
        return quality.length > 0 && quality.length <= 60 && !/\p{Cc}/u.test(quality) ? quality : null;
    }
    if (!Number.isInteger(value) || value < 0) return null;
    return QUALITY_LABELS[value] ?? `Reported code ${value}`;
}

/** Keep boat diagnostics and phone accuracy in independently named source cards. */
export function presentGpsDiagnostics(source: GpsDiagnosticSource, now = Date.now()): GpsDiagnosticsPresentation {
    // One timestamp, one gate: the position line, the phone's fix tile and
    // the no-fix collapse all read this, so they cannot disagree (UX referee
    // run 8, gps-one-truth).
    const fix = gpsFixState(source.positionAt, source.positionMaxAgeMs ?? source.maxAgeMs, now);
    const positionCurrent = fix.kind === 'live';
    const satellites = presentMetric(source.satellites, now, source.maxAgeMs, (value) =>
        typeof value === 'number' && Number.isInteger(value) && value >= 0 ? String(value) : null,
    );
    // The phone's location service never reports satellites. It used to say
    // 'Not exposed' here, which is a developer's word; the plain 'Not reported'
    // that every other unknown reading uses already says it (UX referee
    // W-developer-speak), so the phone gets no special wording.
    const quality = source.phone
        ? {
              text: positionCurrent ? 'Position available' : 'No current fix',
              state: positionCurrent ? ('current' as const) : ('unknown' as const),
          }
        : presentMetric(source.fixQuality, now, source.maxAgeMs, formatQuality);
    const accuracy = presentMetric(source.accuracyM, now, source.maxAgeMs, (value) => {
        const metres = positiveNumber(value);
        return metres === null ? null : `±${metres < 10 ? metres.toFixed(1) : Math.round(metres)} m`;
    });
    if (!source.phone && quality.state === 'current' && source.fixQuality?.value === 0) {
        accuracy.text = 'No current fix';
        accuracy.state = 'unknown';
    }
    const hdop = presentMetric(source.hdop, now, source.maxAgeMs, (value) => {
        const reading = positiveNumber(value);
        return reading === null ? null : reading.toFixed(1);
    });
    const noFix =
        fix.kind === 'none' && [satellites, quality, accuracy, hdop].every((metric) => metric.state === 'unknown');
    return {
        label: source.label,
        fix,
        noFix,
        // 'Position 5 s ago' / 'No live fix · last position 46 s ago' /
        // 'No position yet' — the last only when no position time exists.
        position: fixPositionLine(fix),
        satellites,
        quality,
        accuracy,
        // HDOP is dimensionless. Never turn it into an unlabeled metre estimate.
        hdop,
    };
}

/** NMEA and Pi values belong to this boat feed, never to the phone's fix. */
export function boatGpsDiagnosticSource(
    state: Pick<
        NmeaStoreState,
        | 'connectionStatus'
        | 'remote'
        | 'latitude'
        | 'longitude'
        | 'satellites'
        | 'hdop'
        | 'gpsFixQuality'
        | 'gpsFixQualityUpdatedAt'
        | 'gpsAccuracyM'
    >,
): GpsDiagnosticSource | null {
    const direct = state.connectionStatus === 'connected';
    const remote = state.connectionStatus === 'remote' ? state.remote : null;
    if (!direct && !remote) return null;
    const positionValid =
        typeof state.latitude.value === 'number' &&
        Number.isFinite(state.latitude.value) &&
        Math.abs(state.latitude.value) <= 90 &&
        typeof state.longitude.value === 'number' &&
        Number.isFinite(state.longitude.value) &&
        Math.abs(state.longitude.value) <= 180;
    return {
        label: direct
            ? 'Boat GPS · NMEA'
            : `${remote?.source === 'device' ? 'Shared device GPS' : 'Boat GPS'} · ${remote?.via === 'lan' ? 'Pi direct' : 'cloud'}`,
        maxAgeMs: NMEA_USABLE_MAX_AGE_MS,
        // The same live gate the chart's own-ship marker uses for the boat.
        positionMaxAgeMs: boatLiveFixMaxAgeMs(state),
        // A row can be republished by a fresh clock sentence with old GPS
        // coordinates. Only its actual position sample dates those coordinates.
        positionAt: positionValid
            ? remote
                ? (remote.positionSampleAt ?? null)
                : Math.min(state.latitude.lastUpdated, state.longitude.lastUpdated)
            : null,
        satellites: { value: state.satellites.value, timestamp: state.satellites.lastUpdated },
        hdop: { value: state.hdop.value, timestamp: state.hdop.lastUpdated },
        fixQuality: { value: state.gpsFixQuality, timestamp: state.gpsFixQualityUpdatedAt ?? null },
        accuracyM: state.gpsAccuracyM
            ? { value: state.gpsAccuracyM.value, timestamp: state.gpsAccuracyM.lastUpdated }
            : null,
    };
}

/**
 * Receiver identity stays in its row; timed measurements live in the
 * diagnostics card. The boat receiver's own liveness words ('Live via the
 * Pi', 'Last GPS sentence 20s ago via …', 'Through the cloud · 2m ago') come
 * off a second clock — the feed's sentence and receipt times — and said
 * 'Live' beside a card that had no position. The card's position line owns
 * the fix; this row keeps only the link (UX referee run 8, gps-one-truth).
 */
export function gpsReceiverConnectionDetail(
    receiver: Pick<GpsReceiverStatus, 'kind' | 'detail' | 'qualityLabel'>,
): string {
    if (receiver.kind === 'precision-location') return 'Receiver identity unavailable';
    if (receiver.kind !== 'vessel-nmea') return receiver.detail;
    return receiver.detail
        .split(' · ')
        .map((part) => part.replace(/^(?:Live|Last GPS sentence \S+ ago) via /, 'Connected via '))
        .filter(
            (part) =>
                !/^\d+ sats$/.test(part) &&
                !/^HDOP\s/.test(part) &&
                !/^\d+[smh] ago$/.test(part) &&
                part !== receiver.qualityLabel,
        )
        .join(' · ');
}

/** The fix the weather follows, as the System status box receives it from the weather context. */
export interface WeatherBoxFix {
    kind: WeatherFixKind | null;
    target?: WeatherFollowTarget;
    timestamp: number;
}

export interface WeatherPositionBox {
    /** The boat card (when there is one) then the phone card. */
    sources: GpsDiagnosticsPresentation[];
    /** The same fix states the cards' position lines were written from — the header row reads these. */
    fixes: GpsBoxFixes;
}

/**
 * The System status Weather position box from one timestamp per receiver.
 *
 * The weather's own copy of the followed receiver's fix (its retained or
 * held fix) is folded into that receiver's card rather than dated
 * separately: it is the same receiver's position, so the card, the header row
 * above it and the chart all read one timestamp.
 *
 * - The phone: the weather's read is the same GPS, dated by its own fix, so
 *   the newer of the two is the phone's one timestamp.
 * - The boat: her card reads NmeaStore — the position sample the chart's
 *   own-ship badge and Radio read too. The weather's boat copies are not all
 *   dated that way (a bus fix off the Pi's LAN lane carries this phone's READ
 *   time, the cloud row its REPORT time, a held fix either), so they only
 *   fill a boat card that has no position time at all. They can never make
 *   old coordinates read as a live fix, and the header's 'the boat’s last
 *   fix' is never over 'No position yet'.
 */
export function presentWeatherPositionBox(input: {
    now: number;
    boat: GpsDiagnosticSource | null;
    phone: GpsDiagnosticSource;
    weather?: WeatherBoxFix | null;
}): WeatherPositionBox {
    const { now, weather } = input;
    const followed = weather ? followedReceiver(weather.kind, weather.target) : null;
    const weatherFixAt = weather?.kind ? weather.timestamp : null;
    const fold = (source: GpsDiagnosticSource, receiver: WeatherFollowTarget): GpsDiagnosticSource => {
        if (followed !== receiver || weatherFixAt === null) return source;
        if (receiver === 'boat' && validFixTime(source.positionAt, now)) return source;
        return { ...source, positionAt: newestFixAt([source.positionAt, weatherFixAt], now) };
    };
    const boat = input.boat ? presentGpsDiagnostics(fold(input.boat, 'boat'), now) : null;
    const phone = presentGpsDiagnostics(fold(input.phone, 'phone'), now);
    return {
        sources: boat ? [boat, phone] : [phone],
        fixes: { phone: phone.fix, boat: boat?.fix ?? null },
    };
}
