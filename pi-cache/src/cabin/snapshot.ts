import type { LanTelemetryPayload } from '../lanTelemetry.js';
import { cabinRecent, type CabinSnapshot } from './wire.js';

/** A bounded projection of the existing telemetry/126 alarm mirror, never another watch. */
export function cabinSnapshot(
    payload: LanTelemetryPayload,
    now: number,
    anchor: { running: boolean; dragging: boolean } | null = null,
): CabinSnapshot {
    const raw = payload.telemetry;
    const reported = raw && typeof raw.reported_at === 'string' ? Date.parse(raw.reported_at) : NaN;
    const reportedAt = Number.isSafeInteger(reported) ? reported : null;
    const available = payload.available === true && cabinRecent(reportedAt, now);
    const reading = (key: string, min: number, max: number): number | null => {
        const value = raw?.[key];
        return available && typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
            ? value
            : null;
    };
    const description = payload.ais_watch;
    return {
        schema: 1,
        servedAt: now,
        reportedAt,
        available,
        anchor: anchor
            ? { running: anchor.running, dragging: anchor.running && anchor.dragging, sampleAt: null }
            : null,
        readings: {
            heading: reading('heading_deg', 0, 360),
            pressure: reading('pressure_hpa', 800, 1200),
            depth: reading('depth_m', -20, 12000),
            speed: reading('sog_kts', 0, 150),
            wind: reading('tws_kts', 0, 150),
        },
        watch: description
            ? {
                  state: description.state,
                  lastPassAt: description.lastPassAt,
                  servedAt: description.servedAt,
                  push: description.push?.state ?? null,
                  alarms: description.alarms.slice(0, 20).map((alarm) => ({
                      kind: alarm.kind,
                      name: [...alarm.name]
                          .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
                          .join('')
                          .slice(0, 80),
                      mmsi: alarm.mmsi,
                      raisedAt: alarm.raisedAt,
                      acknowledgedAt: alarm.ackedAt,
                      lost: alarm.lost !== null,
                  })),
              }
            : null,
    };
}
