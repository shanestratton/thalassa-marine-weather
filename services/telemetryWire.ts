/**
 * telemetryWire — one snapshot off two wires.
 *
 * The Pi speaks one snake_case dialect to the cloud (TelemetryPublisher →
 * telemetry-relay → vessel_telemetry) and to a phone on the boat LAN
 * (GET /api/telemetry). The store learns one conversion; `via` says which
 * wire a reading came down, and NmeaStore ranks the LAN above the cloud.
 */
import type { RemoteInstrumentSnapshot, RemoteVia } from './NmeaStore';
import type { NmeaDepthReference } from '../types/navigation';
import { parseWindHistorySummary } from '../utils/windHistory';
import { readGnssDiagnostics } from './nmea/gnssDiagnostics';

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
    const gnss = source === 'pi' ? readGnssDiagnostics(extra) : undefined;
    const positionSampleAt = wireNumber(extra.position_at);
    const headingTrue = wireNumber(extra.heading_true_deg);
    const headingTrueAt = wireNumber(extra.heading_true_at_ms);
    const qualifiedHeadingTrue =
        headingTrue !== null &&
        headingTrue >= 0 &&
        headingTrue < 360 &&
        headingTrueAt !== null &&
        headingTrueAt > 0 &&
        headingTrueAt <= Date.now() + 1_000;
    // What depth_m is measured from. A Pi since 2026-09-29 sends the boat's
    // display depth (below the keel on Serene Summer) and says so; an older Pi
    // sends none, and its raw depth is below the transducer.
    const depthReference: NmeaDepthReference | undefined =
        extra.depth_reference === 'below-keel' ||
        extra.depth_reference === 'below-transducer' ||
        extra.depth_reference === 'below-waterline'
            ? extra.depth_reference
            : undefined;
    const depthOffset = wireNumber(extra.depth_offset_m);
    const lat = wireNumber(wire.lat);
    const lon = wireNumber(wire.lon);
    const hasPositionTime =
        positionSampleAt !== null &&
        positionSampleAt > 0 &&
        positionSampleAt <= Date.now() + 1_000 &&
        lat !== null &&
        lon !== null &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180 &&
        !(lat === 0 && lon === 0);
    return {
        source,
        deviceLabel,
        reportedAt,
        snapshot: {
            source,
            via,
            deviceLabel,
            reportedAt,
            // Diagnostic age only: the GPS/row clock is not the position's
            // own measurement time. Missing metadata stays unavailable.
            ...(hasPositionTime ? { positionSampleAt } : {}),
            lat,
            lon,
            sogKts: wireNumber(wire.sog_kts),
            cogDeg: wireNumber(wire.cog_deg),
            headingDeg: wireNumber(wire.heading_deg),
            // Never relabel legacy heading_deg as true or invent a fresh clock
            // from reported_at. NmeaStore applies the sensor-age budget.
            headingTrueDeg: qualifiedHeadingTrue ? headingTrue : null,
            ...(qualifiedHeadingTrue ? { headingTrueAt } : {}),
            stwKts: wireNumber(wire.stw_kts),
            twsKts: wireNumber(wire.tws_kts),
            twaDeg: wireNumber(wire.twa_deg),
            twdDeg: wireNumber(wire.twd_deg),
            awsKts: wireNumber(wire.aws_kts),
            awaDeg: wireNumber(wire.awa_deg),
            depthM: wireNumber(wire.depth_m),
            ...(depthReference ? { depthReference } : {}),
            ...(depthReference && depthOffset !== null && Math.abs(depthOffset) <= 10
                ? { depthOffsetM: depthOffset }
                : {}),
            heelDeg: wireNumber(wire.heel_deg),
            pitchDeg: wireNumber(wire.pitch_deg),
            waterTempC: wireNumber(wire.water_temp_c),
            rudderDeg: wireNumber(wire.rudder_deg),
            rpm: wireNumber(wire.rpm),
            voltageV: wireNumber(wire.voltage_v),
            ...(gnss ? { gnss } : {}),
            ...(windHistory ? { windHistory } : {}),
            // Never substitute reported_at (often the GPS clock) for the wind
            // sensor's own timestamp: cached wind would become new history.
            ...(wireNumber(extra.wind_tws_at_ms) !== null ? { windSampleAt: wireNumber(extra.wind_tws_at_ms)! } : {}),
            // The TWD reading's own time (Pi update 1); an older Pi sends none.
            ...(wireNumber(extra.wind_twd_at_ms) !== null ? { twdSampleAt: wireNumber(extra.wind_twd_at_ms)! } : {}),
            ...(windIdentity ? { windHistoryIdentity: windIdentity } : {}),
            ...(windSampleSource ? { windSampleSource } : {}),
        },
    };
}
