import React, { useEffect, useState } from 'react';
import type { VoyageLogInstruments } from '../voyageLogApi';
import { formatPublicAge, isPublicPositionFresh } from '../publicVoyageFreshness';
import { PublicInstrumentDials, publicShipClock, type PublicInstrumentMode } from './PublicInstrumentDials';

interface TelemetryPanelProps {
    instruments: VoyageLogInstruments | null;
    nowMs: number;
    connectionLost: boolean;
    lastSuccessfulAt: number | null;
}

const finite = (value: number | null | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value);

const Reading: React.FC<{ label: string; value: number | null; unit: string; digits?: number; status?: string }> = ({
    label,
    value,
    unit,
    digits = 1,
    status,
}) => (
    // A label that wraps ('Speed over ground') must not drop its value below
    // the neighbouring tile's: values sit on the foot of the stretched tile.
    <div className="pv-readout flex flex-col justify-between">
        <dt className="pv-readout__label">{label}</dt>
        <dd className="pv-readout__value pv-num">
            {status ? (
                <span className="pv-readout__status">{status}</span>
            ) : (
                <>
                    {finite(value) ? value.toFixed(digits) : <span aria-label="Unavailable">—</span>}
                    {/* The degree sign sits tight against its number (313°, 23.8°C). */}
                    <span className="pv-readout__unit" data-tight={unit.startsWith('°') ? '' : undefined}>
                        {unit}
                    </span>
                </>
            )}
        </dd>
    </div>
);

/** Public explanation only: no readings, inferred consent, or sharing controls. */
export const InstrumentsNotShared: React.FC = () => (
    <section aria-label="Instrument sharing status" className="pv-console flex shrink-0 flex-col gap-2">
        <h2 className="pv-console__title">Onboard instruments</h2>
        <p className="pv-console__body">Instruments aren’t currently being shared.</p>
        <p className="pv-console__body">
            Skipper: open the main Thalassa app → Settings → Voyage Log → Share my instruments.
        </p>
    </section>
);

/** Only mounted after server-confirmed consent; never substitutes forecast or GPS data. */
export const TelemetryPanel: React.FC<TelemetryPanelProps> = ({
    instruments: raw,
    nowMs,
    connectionLost,
    lastSuccessfulAt,
}) => {
    // Keep the chosen face while a paused/stale feed temporarily hides its readings.
    const [instrumentMode, setInstrumentMode] = useState<PublicInstrumentMode>('Apparent');
    // Reopening this panel must not rewind freshness to the parent's slower
    // clock tick and briefly revive an expired sensor reading.
    const [sensorClock, setSensorClock] = useState(() => Math.max(nowMs, Date.now()));
    useEffect(() => {
        const timer = setInterval(() => setSensorClock(Date.now()), 5_000);
        return () => clearInterval(timer);
    }, []);
    const sensorNow = Math.max(nowMs, sensorClock);
    // Let individual sensors expire between public-page polls as well.
    const recent = (at: string | null | undefined, age: number) => {
        const ms = at ? Date.parse(at) : NaN;
        return Number.isFinite(ms) && ms <= sensorNow + 5_000 && sensorNow - ms <= age;
    };
    const t = raw
        ? {
              ...raw,
              house_battery_soc: recent(raw.house_battery_at, 180_000) ? raw.house_battery_soc : null,
              baro: raw.pressure_at && !recent(raw.pressure_at, 180_000) ? null : raw.baro,
              heel: raw.heel_at && !recent(raw.heel_at, 30_000) ? null : raw.heel,
              pitch: raw.pitch_at && !recent(raw.pitch_at, 30_000) ? null : raw.pitch,
          }
        : null;
    const fresh = !!t && isPublicPositionFresh(t.updated_at, sensorNow);
    const available =
        t &&
        Object.entries(t).some(
            ([key, value]) => key !== 'pressure_3h' && typeof value === 'number' && Number.isFinite(value),
        );
    // Missing RPM is not proof that the engine has stopped (or even has a sensor).
    const engineRpm = finite(t?.rpm) && t.rpm >= 0 ? t.rpm : null;
    const engineStatus = engineRpm === null ? 'No RPM signal' : engineRpm === 0 ? 'Engine off' : undefined;

    return (
        <section aria-label="Onboard instruments" className="pv-console flex shrink-0 flex-col gap-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                    <p className="pv-eyebrow pv-eyebrow--sea">From the boat</p>
                    <h2 className="pv-console__title mt-1">Onboard instruments</h2>
                </div>
                {fresh && !connectionLost && available && (
                    <span className="pv-chip pv-chip--live">
                        <span className="pv-dot" data-tone="live" aria-hidden="true" />
                        Live
                    </span>
                )}
            </div>
            {connectionLost ? (
                <div role="status" className="pv-notice pv-notice--warn">
                    <p className="font-semibold">Connection lost</p>
                    <p className="pv-notice__sub mt-1">
                        Last successful update {formatPublicAge(lastSuccessfulAt, nowMs)}. Readings paused.
                    </p>
                </div>
            ) : !fresh || (!available && !publicShipClock(sensorNow, t?.ship_time_zone)) ? (
                <div role="status" className="pv-notice">
                    <p>Waiting for the next report from the boat.</p>
                    <p className="pv-notice__sub mt-1">
                        {t
                            ? 'Last report ' + formatPublicAge(t.updated_at, nowMs) + '.'
                            : 'Sharing is on; no recent instrument readings have arrived.'}
                    </p>
                </div>
            ) : (
                <>
                    {/* The answer first: who is reporting and how old it is, then
                        what the boat is doing, then the numbers, then the dial. */}
                    <p className="pv-console__source">
                        {t.source === 'pi' ? 'Boat’s instruments' : 'Device aboard'} ·{' '}
                        {formatPublicAge(t.updated_at, nowMs)}
                    </p>
                    {finite(t.sog) && t.sog < 0.5 && (
                        // Balanced lines keep the glass from wrapping onto a line of its own.
                        <p className="pv-now-line text-balance">No way on · Champagne &amp; good times 🥂</p>
                    )}
                    <dl className="pv-readouts grid grid-cols-2 gap-2">
                        <Reading label="Depth" value={t.depth} unit="m" />
                        <Reading label="Speed over ground" value={t.sog} unit="kt" />
                        <Reading label="House battery" value={t.house_battery_soc ?? null} unit="%" />
                        <Reading label="Sea temperature" value={t.water_temp} unit="°C" />
                        <Reading label="Heading" value={t.heading} unit="°" digits={0} />
                        <Reading label="Engine" value={engineRpm} unit="RPM" digits={0} status={engineStatus} />
                    </dl>
                    <PublicInstrumentDials instruments={t} mode={instrumentMode} onModeChange={setInstrumentMode} />
                    <details className="pv-more-panel pt-1">
                        <summary className="pv-more min-h-11 cursor-pointer content-center">More instruments</summary>
                        <dl className="mt-2 grid grid-cols-2 gap-2">
                            {/* Fuel senders are not connected to this feed yet.
                                Never turn their absence into an empty/full tank. */}
                            <Reading label="Port fuel" value={null} unit="%" status="Not connected" />
                            <Reading label="Starboard fuel" value={null} unit="%" status="Not connected" />
                            <Reading label="Through water" value={t.stw} unit="kt" />
                            <Reading label="Course over ground" value={t.cog} unit="°" digits={0} />
                            <Reading label="True wind angle" value={t.twa} unit="°" digits={0} />
                            <Reading label="Heel" value={t.heel} unit="°" />
                            <Reading label="Pitch" value={t.pitch} unit="°" />
                            <Reading label="Rudder" value={t.rudder} unit="°" />
                        </dl>
                    </details>
                    <p className="pv-disclaimer">
                        Shared readings, not a navigation display. A dash means that sensor has not reported.
                    </p>
                </>
            )}
        </section>
    );
};
