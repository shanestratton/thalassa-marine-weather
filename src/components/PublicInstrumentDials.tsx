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

const MODES = ['Apparent', 'True wind', 'COG', 'Barometer', 'Heel', 'Pitch', 'Helm', 'Ship’s bell'] as const;
type Mode = (typeof MODES)[number];
const valid = (value: number | null | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

/** A configured ship zone only. Never quietly falls back to the visitor's clock. */
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
            <p role="status" className="py-16 text-center text-sm text-slate-400">
                Waiting for the boat’s clock setting.
            </p>
        );
    return (
        <>
            <ShipsBellClock hour={clock.hour} minute={clock.minute} second={clock.second} zoneLabel={clock.label} />
            <p className="mt-2 text-center text-sm text-amber-200">Ship time · {zone?.replaceAll('_', ' ')}</p>
            <details className="mt-3 border-t border-white/10">
                <summary className="min-h-11 cursor-pointer content-center text-sm text-amber-200">
                    Traditional bell watches
                </summary>
                <dl className="space-y-2 text-sm">
                    {[0, 4, 8, 12, 16, 18, 20].map((hour) => {
                        const watch = watchAt(hour, 0);
                        const active = watch.name === watchAt(clock.hour, clock.minute).name;
                        return (
                            <div
                                key={hour}
                                className={`flex flex-wrap justify-between gap-1 ${active ? 'font-semibold text-amber-200' : 'text-slate-400'}`}
                            >
                                <dt>{watch.name}</dt>
                                <dd className="font-mono">
                                    {String(hour).padStart(2, '0')}:00–
                                    {String(hour + watch.lengthHours).padStart(2, '0')}:00
                                </dd>
                            </div>
                        );
                    })}
                </dl>
                <p className="mt-3 text-xs text-slate-400">
                    Royal Navy bell convention, including dog watches. Crew duty assignments remain private.
                </p>
            </details>
        </>
    );
};

/** Native instrument faces, kept large enough to read on a phone. */
export const PublicInstrumentDials: React.FC<{ instruments: VoyageLogInstruments }> = ({ instruments: t }) => {
    const [mode, setMode] = useState<Mode>('Apparent');
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
        <div className="my-4 rounded-2xl border border-white/10 bg-slate-950/75 p-3">
            <div role="group" aria-label="Choose instrument" className="grid grid-cols-4 gap-1">
                {MODES.map((item) => (
                    <button
                        key={item}
                        type="button"
                        aria-pressed={mode === item}
                        onClick={() => setMode(item)}
                        className={`min-h-11 rounded-lg px-1 py-2 text-sm leading-tight transition-colors focus-visible:outline-2 focus-visible:outline-teal-300 ${mode === item ? 'bg-teal-300/15 text-teal-200 ring-1 ring-teal-300/30' : 'text-slate-400 hover:bg-white/5 hover:text-white'}`}
                    >
                        {item}
                    </button>
                ))}
            </div>
            <h3 className="mb-2 mt-5 text-center text-sm font-bold uppercase tracking-[.2em] text-slate-300">
                {mode === 'COG'
                    ? 'Course over ground'
                    : mode === 'Heel'
                      ? 'Heel / roll'
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
                    className="mx-auto block h-auto w-full max-w-[300px]"
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
                        className="mx-auto block h-auto w-full max-w-[300px]"
                    />
                    {t.twa === null && (
                        <p className="mt-2 text-center text-sm text-slate-400">True wind angle not reported.</p>
                    )}
                </>
            )}
            {mode === 'COG' && (
                <>
                    <HeadingGauge value={valid(t.cog)} isLive label="Course over ground compass" />
                    <p className="text-center text-sm text-slate-400">GPS course · not bow heading</p>
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
                            <p className="mt-2 text-center text-sm text-slate-400">
                                Onboard sensor · pale hand ≈ 3 h ago
                            </p>
                            <p
                                className={`mt-3 text-center font-semibold ${tendency.severity === 'warn' ? 'text-rose-300' : tendency.severity === 'watch' ? 'text-amber-300' : 'text-teal-200'}`}
                            >
                                {tendency.label}
                            </p>
                            <div className="mt-3 grid grid-cols-2 gap-2 text-center text-sm text-slate-300">
                                <p>
                                    3 h change{' '}
                                    <strong className="mt-1 block font-mono text-lg text-white">
                                        {tendency.deltaHpa > 0 ? '+' : ''}
                                        {tendency.deltaHpa.toFixed(1)} hPa
                                    </strong>
                                </p>
                                <p>
                                    Average rate{' '}
                                    <strong className="mt-1 block font-mono text-lg text-teal-200">
                                        {tendency.perHour.toFixed(1)} hPa/h
                                    </strong>
                                </p>
                            </div>
                        </>
                    ) : (
                        <p className="mt-2 text-center text-sm text-slate-400">
                            {baro === null
                                ? 'Waiting for onboard pressure.'
                                : 'Onboard pressure · collecting 3 h history.'}
                        </p>
                    )}
                </>
            )}
            {mode === 'Heel' && <AttitudeGauge angle={valid(t.heel)} axis="heel" />}
            {mode === 'Pitch' && <AttitudeGauge angle={valid(t.pitch)} axis="pitch" />}
            {mode === 'Helm' && <RudderGauge angle={valid(t.rudder)} />}
            {mode === 'Ship’s bell' && <Bell zone={t.ship_time_zone} />}
        </div>
    );
};
