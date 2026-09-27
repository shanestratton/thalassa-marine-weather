import React, { useEffect, useId, useState } from 'react';
import type { VoyageLogInstruments } from '../voyageLogApi';
import { SereneWindRose } from '../../components/nmea/gauges/SereneWindRose';
import { HeadingGauge } from '../../components/nmea/gauges/HeadingGauge';
import { BarometerGauge } from '../../components/nmea/gauges/BarometerGauge';
import { RudderGauge } from '../../components/nmea/gauges/RudderGauge';
import { AttitudeGauge } from '../../components/nmea/gauges/AttitudeGauge';
import { ShipsBellClock } from '../../components/nmea/gauges/ShipsBellClock';
import { watchAt } from '../../utils/shipsBells';
import { clockInZone } from '../../utils/timeZones';
import { observedTendency } from '../../utils/barometerTendency';

const MODES = ['Apparent', 'True wind', 'COG', 'Barometer', 'Heel', 'Trim', 'Helm', 'Ship’s bell'] as const;
export type PublicInstrumentMode = (typeof MODES)[number];
const valid = (value: number | null | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The vessel-position zone supplied by the public API, never the visitor's clock. */
export function publicShipClock(now: number, zone: string | null | undefined) {
    if (!zone) return null;
    try {
        new Intl.DateTimeFormat('en', { timeZone: zone }).format(now);
        return clockInZone(new Date(now), zone);
    } catch {
        return null;
    }
}

const Bell: React.FC<{ zone: string | null | undefined }> = ({ zone }) => {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    const clock = publicShipClock(now, zone);
    if (!clock)
        return (
            <p role="status" className="pv-dial-note py-16">
                Waiting for a recent vessel position to set local time.
            </p>
        );
    return (
        <>
            <ShipsBellClock hour={clock.hour} minute={clock.minute} second={clock.second} zoneLabel={clock.label} />
            <p className="pv-dial-note pv-bell-zone">Vessel local time · {zone?.replaceAll('_', ' ')}</p>
            <details className="pv-more-panel">
                <summary className="pv-more min-h-11 cursor-pointer content-center">Traditional bell watches</summary>
                <dl className="space-y-2">
                    {[0, 4, 8, 12, 16, 18, 20].map((hour) => {
                        const watch = watchAt(hour, 0);
                        const active = watch.name === watchAt(clock.hour, clock.minute).name;
                        return (
                            <div
                                key={hour}
                                className="pv-watch flex flex-wrap justify-between gap-1"
                                data-active={active ? 'true' : undefined}
                            >
                                <dt>{watch.name}</dt>
                                <dd className="pv-num">
                                    {String(hour).padStart(2, '0')}:00–
                                    {String(hour + watch.lengthHours).padStart(2, '0')}:00
                                </dd>
                            </div>
                        );
                    })}
                </dl>
                <p className="pv-disclaimer mt-3">
                    Royal Navy bell convention, including dog watches. Crew duty assignments remain private.
                </p>
            </details>
        </>
    );
};

/** Native instrument faces, kept large enough to read on a phone. */
export const PublicInstrumentDials: React.FC<{
    instruments: VoyageLogInstruments;
    mode?: PublicInstrumentMode;
    onModeChange?: (mode: PublicInstrumentMode) => void;
}> = ({ instruments: t, mode: selectedMode, onModeChange }) => {
    const [localMode, setLocalMode] = useState<PublicInstrumentMode>('Apparent');
    const mode = selectedMode ?? localMode;
    const setMode = onModeChange ?? setLocalMode;
    const id = useId().replace(/:/g, '');
    const baro = valid(t.baro);
    const old = valid(t.pressure_3h);
    const tendency =
        baro !== null && old !== null && t.pressure_at && t.pressure_3h_at
            ? observedTendency(
                  [
                      { t: Date.parse(t.pressure_3h_at), hpa: old },
                      { t: Date.parse(t.pressure_at), hpa: baro },
                  ],
                  Date.parse(t.pressure_at),
              )
            : null;
    return (
        // A recessed well: the app's gauge reads as hardware set into the console.
        <div className="pv-well flex flex-col gap-3">
            {/* One segmented bezel, so every cell has a visible edge. On a
                320 px phone a cell is ~65 px: a long name hyphenates onto a
                second line instead of being clipped by the bezel. */}
            <div role="group" aria-label="Choose instrument" className="pv-modes grid grid-cols-4">
                {MODES.map((item) => (
                    <button
                        key={item}
                        type="button"
                        aria-pressed={mode === item}
                        onClick={() => setMode(item)}
                        className="pv-mode hyphens-auto"
                    >
                        {item}
                    </button>
                ))}
            </div>
            <h3 className="pv-dial-title mt-1">
                {mode === 'COG'
                    ? 'Course over ground'
                    : mode === 'Heel'
                      ? 'Heel / roll'
                      : mode === 'Trim'
                        ? 'Trim / pitch'
                        : mode === 'Apparent'
                          ? 'Apparent wind'
                          : mode}
            </h3>
            {mode === 'Apparent' && (
                <SereneWindRose
                    angle={valid(t.awa)}
                    speed={valid(t.aws)}
                    unit="kts"
                    gaugeKey={`${id}-apparent`}
                    isLive
                    className="mx-auto block h-auto w-full max-w-[360px]"
                />
            )}
            {mode === 'True wind' && (
                <>
                    <SereneWindRose
                        angle={valid(t.twa)}
                        speed={valid(t.tws)}
                        heading={valid(t.heading)}
                        unit="kts"
                        gaugeKey={`${id}-true`}
                        isLive
                        className="mx-auto block h-auto w-full max-w-[360px]"
                    />
                    {t.twa === null && <p className="pv-dial-note">True wind angle not reported.</p>}
                </>
            )}
            {mode === 'COG' && (
                <>
                    <HeadingGauge value={valid(t.cog)} isLive label="Course over ground compass" />
                    <p className="pv-dial-note">GPS course · not bow heading</p>
                </>
            )}
            {mode === 'Barometer' && (
                <>
                    <BarometerGauge
                        hpa={baro}
                        setHandHpa={tendency ? old : null}
                        readout={baro?.toFixed(1) ?? '—'}
                        severity={tendency?.severity ?? 'calm'}
                    />
                    {tendency ? (
                        <>
                            <p className="pv-dial-note">Onboard sensor · pale hand ≈ 3 h ago</p>
                            <p className="pv-tendency" data-severity={tendency.severity}>
                                {tendency.label}
                            </p>
                            <div className="grid grid-cols-2 gap-2 text-center pv-dial-note">
                                <p>
                                    3 h change{' '}
                                    <strong className="pv-dial-figure mt-1 block">
                                        {tendency.deltaHpa > 0 ? '+' : ''}
                                        {tendency.deltaHpa.toFixed(1)} hPa
                                    </strong>
                                </p>
                                <p>
                                    Average rate{' '}
                                    <strong className="pv-dial-figure mt-1 block" data-accent="">
                                        {tendency.perHour.toFixed(1)} hPa/h
                                    </strong>
                                </p>
                            </div>
                        </>
                    ) : (
                        <p className="pv-dial-note">
                            {baro === null
                                ? 'Waiting for onboard pressure.'
                                : 'Onboard pressure · collecting 3 h history.'}
                        </p>
                    )}
                </>
            )}
            {mode === 'Heel' && <AttitudeGauge angle={valid(t.heel)} axis="heel" />}
            {mode === 'Trim' && <AttitudeGauge angle={valid(t.pitch)} axis="pitch" />}
            {mode === 'Helm' && <RudderGauge angle={valid(t.rudder)} />}
            {mode === 'Ship’s bell' && <Bell zone={t.ship_time_zone} />}
        </div>
    );
};
