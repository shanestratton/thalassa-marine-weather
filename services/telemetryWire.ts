/**
 * telemetryWire — one snapshot off two wires.
 *
 * The Pi speaks one snake_case dialect to the cloud (TelemetryPublisher →
 * telemetry-relay → vessel_telemetry) and to a phone on the boat LAN
 * (GET /api/telemetry). The store learns one conversion; `via` says which
 * wire a reading came down, and NmeaStore ranks the LAN above the cloud.
 */
import type { RemoteInstrumentSnapshot, RemoteVia } from './NmeaStore';
import { parseWindHistorySummary } from '../utils/windHistory';

export type TelemetryWire = Record<string, unknown>;

export function wireNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface WireReading {
    source: 'pi' | 'device';
    deviceLabel: string | null;
    /** Epoch ms of the instrument reading, as the Pi reported it. */
    reportedAt: number;
    snapshot: RemoteInstrumentSnapshot;
}

/** Null when the wire carries no parseable reported_at — a reading with no time is not a reading. */
export function snapshotFromWire(wire: TelemetryWire, via: RemoteVia): WireReading | null {
    const reportedAt = typeof wire.reported_at === 'string' ? Date.parse(wire.reported_at) : Number.NaN;
    if (!Number.isFinite(reportedAt)) return null;
    const source = wire.source === 'device' ? 'device' : 'pi';
    const deviceLabel =
        typeof wire.device_label === 'string' && wire.device_label.trim() ? wire.device_label.trim() : null;
    const extra =
        wire.extra && typeof wire.extra === 'object' && !Array.isArray(wire.extra)
            ? (wire.extra as Record<string, unknown>)
            : {};
    const windHistory = source === 'pi' ? parseWindHistorySummary(extra) : null;
    const boundedText = (value: unknown): string | undefined =>
        typeof value === 'string' && value.trim().length > 0 && value.length <= 120 && !/\p{Cc}/u.test(value)
            ? value.trim()
            : undefined;
    const windIdentity = boundedText(extra.wind_history_identity);
    const windSampleSource = boundedText(extra.wind_tws_source);
    return {
        source,
        deviceLabel,
        reportedAt,
        snapshot: {
            source,
            via,
            deviceLabel,
            reportedAt,
            lat: wireNumber(wire.lat),
            lon: wireNumber(wire.lon),
            sogKts: wireNumber(wire.sog_kts),
            cogDeg: wireNumber(wire.cog_deg),
            headingDeg: wireNumber(wire.heading_deg),
            stwKts: wireNumber(wire.stw_kts),
            twsKts: wireNumber(wire.tws_kts),
            twaDeg: wireNumber(wire.twa_deg),
            twdDeg: wireNumber(wire.twd_deg),
            awsKts: wireNumber(wire.aws_kts),
            awaDeg: wireNumber(wire.awa_deg),
            depthM: wireNumber(wire.depth_m),
            heelDeg: wireNumber(wire.heel_deg),
            pitchDeg: wireNumber(wire.pitch_deg),
            waterTempC: wireNumber(wire.water_temp_c),
            rudderDeg: wireNumber(wire.rudder_deg),
            rpm: wireNumber(wire.rpm),
            voltageV: wireNumber(wire.voltage_v),
            ...(windHistory ? { windHistory } : {}),
            // Never substitute reported_at (often the GPS clock) for the wind
            // sensor's own timestamp: cached wind would become new history.
            ...(wireNumber(extra.wind_tws_at_ms) !== null ? { windSampleAt: wireNumber(extra.wind_tws_at_ms)! } : {}),
            ...(windIdentity ? { windHistoryIdentity: windIdentity } : {}),
            ...(windSampleSource ? { windSampleSource } : {}),
        },
    };
}
