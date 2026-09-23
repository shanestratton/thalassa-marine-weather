import type { NmeaStoreState } from '../services/NmeaStore';
import type { GpsReceiverStatus } from '../services/GpsReceiverStatusService';
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
    position: string;
    satellites: GpsDiagnosticValue;
    quality: GpsDiagnosticValue;
    accuracy: GpsDiagnosticValue;
    hdop: GpsDiagnosticValue;
}

function validTime(timestamp: number | null | undefined, now: number): timestamp is number {
    return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now + 1000;
}

function ageText(ageMs: number): string {
    if (ageMs < 1000) return 'just now';
    if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)} s ago`;
    if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)} min ago`;
    return `${Math.floor(ageMs / 3_600_000)} h ago`;
}

function presentMetric(
    metric: GpsDiagnosticMetric | null | undefined,
    now: number,
    maxAgeMs: number,
    format: (value: number | string) => string | null,
): GpsDiagnosticValue {
    const unknown: GpsDiagnosticValue = { text: 'Not reported', state: 'unknown' };
    if (!metric || metric.value === null || !validTime(metric.timestamp, now)) return unknown;
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
    const positionCurrent =
        validTime(source.positionAt, now) && now - source.positionAt <= (source.positionMaxAgeMs ?? source.maxAgeMs);
    const satellites = presentMetric(source.satellites, now, source.maxAgeMs, (value) =>
        typeof value === 'number' && Number.isInteger(value) && value >= 0 ? String(value) : null,
    );
    if (source.phone && satellites.state === 'unknown') satellites.text = 'Not exposed';
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
    return {
        label: source.label,
        position: validTime(source.positionAt, now)
            ? `${positionCurrent ? 'Position' : 'Last position'} ${ageText(Math.max(0, now - source.positionAt))}`
            : 'Position time unavailable',
        satellites,
        quality,
        accuracy,
        // HDOP is dimensionless. Never turn it into an unlabeled metre estimate.
        hdop: presentMetric(source.hdop, now, source.maxAgeMs, (value) => {
            const hdop = positiveNumber(value);
            return hdop === null ? null : hdop.toFixed(1);
        }),
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
            : `${remote?.source === 'device' ? 'Shared device GPS' : 'Boat GPS'} · ${remote?.via === 'lan' ? 'Pi LAN' : 'cloud'}`,
        maxAgeMs: NMEA_USABLE_MAX_AGE_MS,
        positionMaxAgeMs: remote?.via === 'cloud' ? 60_000 : remote ? 20_000 : NMEA_USABLE_MAX_AGE_MS,
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

/** Receiver identity stays in its row; timed measurements live in the diagnostics card. */
export function gpsReceiverConnectionDetail(
    receiver: Pick<GpsReceiverStatus, 'kind' | 'detail' | 'qualityLabel'>,
): string {
    if (receiver.kind === 'precision-location') return 'Receiver identity unavailable';
    if (receiver.kind !== 'vessel-nmea') return receiver.detail;
    return receiver.detail
        .split(' · ')
        .filter((part) => !/^\d+ sats$/.test(part) && !/^HDOP\s/.test(part) && part !== receiver.qualityLabel)
        .join(' · ');
}
