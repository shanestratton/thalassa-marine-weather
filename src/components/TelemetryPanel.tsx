import React from 'react';
import type { VoyageLogInstruments } from '../voyageLogApi';
import { formatPublicAge, isPublicPositionFresh } from '../publicVoyageFreshness';
import { ArcDial, CompassDial, WindDial } from './dials';

interface TelemetryPanelProps {
    instruments: VoyageLogInstruments | null;
    nowMs: number;
    connectionLost: boolean;
    lastSuccessfulAt: number | null;
}

const finite = (value: number | null | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value);

const Reading: React.FC<{ label: string; value: number | null; unit: string; digits?: number }> = ({
    label,
    value,
    unit,
    digits = 1,
}) => (
    <div className="min-w-0 rounded-xl border border-white/8 bg-slate-950/45 px-3 py-2.5">
        <dt className="text-sm text-slate-400">{label}</dt>
        <dd className="mt-1 flex flex-wrap items-baseline gap-x-1.5 font-mono text-xl font-semibold tabular-nums text-slate-100">
            {finite(value) ? value.toFixed(digits) : <span aria-label="Unavailable">—</span>}
            <span className="text-xs font-medium text-teal-200">{unit}</span>
        </dd>
    </div>
);

/** Only mounted after server-confirmed consent; never substitutes forecast or GPS data. */
export const TelemetryPanel: React.FC<TelemetryPanelProps> = ({
    instruments: t,
    nowMs,
    connectionLost,
    lastSuccessfulAt,
}) => {
    const fresh = !!t && isPublicPositionFresh(t.updated_at, nowMs);
    const available =
        t &&
        Object.entries(t).some(
            ([key, value]) =>
                key !== 'updated_at' && key !== 'source' && typeof value === 'number' && Number.isFinite(value),
        );

    return (
        <section
            aria-label="Onboard instruments"
            className="shrink-0 border-b border-teal-200/15 bg-linear-to-br from-teal-950/60 via-slate-900 to-slate-950 p-4 sm:p-5"
        >
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-300">From the boat</p>
                    <h2 className="mt-1 text-xl font-semibold tracking-tight text-white">Onboard instruments</h2>
                </div>
                {fresh && !connectionLost && available && (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-300/25 bg-teal-300/10 px-2.5 py-1 text-xs font-semibold text-teal-200">
                        <span className="h-1.5 w-1.5 rounded-full bg-teal-300 motion-safe:animate-pulse" />
                        Live
                    </span>
                )}
            </div>
            {connectionLost ? (
                <div
                    role="status"
                    className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/5 p-3 text-sm text-amber-200"
                >
                    <p className="font-semibold">Connection lost</p>
                    <p className="mt-1">
                        Last successful update {formatPublicAge(lastSuccessfulAt, nowMs)}. Readings paused.
                    </p>
                </div>
            ) : !fresh || !available ? (
                <div role="status" className="mt-3 text-sm leading-relaxed text-slate-400">
                    <p>Waiting for the next report from the boat.</p>
                    <p className="mt-1 text-xs">
                        {t
                            ? 'Last report ' + formatPublicAge(t.updated_at, nowMs) + '.'
                            : 'Sharing is on; no recent instrument readings have arrived.'}
                    </p>
                </div>
            ) : (
                <>
                    <p className="mt-2 text-xs text-slate-400">
                        {t.source === 'pi' ? 'Pi instrument feed' : 'Device instrument feed'} ·{' '}
                        {formatPublicAge(t.updated_at, nowMs)}
                    </p>
                    <div className="my-4 grid grid-cols-3 gap-2 rounded-2xl border border-white/8 bg-slate-950/35 px-1 py-3">
                        <ArcDial
                            value={finite(t.sog) ? t.sog : null}
                            max={12}
                            unit="kt"
                            label="Speed"
                            accent="#5eead4"
                        />
                        <CompassDial value={finite(t.heading) ? t.heading : null} label="Heading" accent="#fbbf24" />
                        <WindDial
                            awa={finite(t.awa) ? t.awa : null}
                            aws={finite(t.aws) ? t.aws : null}
                            label="App. wind · kt"
                            accent="#7dd3fc"
                        />
                    </div>
                    {finite(t.sog) && t.sog < 0.5 && (
                        <p className="mb-3 text-xs text-teal-200">No way on · Champagne &amp; good times 🥂</p>
                    )}
                    <dl className="grid grid-cols-2 gap-2">
                        <Reading label="Depth" value={t.depth} unit="m" />
                        <Reading label="Pressure" value={t.baro} unit="hPa" />
                        <Reading label="True wind" value={t.tws} unit="kt" />
                        <Reading label="Sea temperature" value={t.water_temp} unit="°C" />
                        <Reading label="Battery voltage" value={t.voltage} unit="V" />
                        <Reading label="Engine" value={t.rpm} unit="RPM" digits={0} />
                    </dl>
                    <details className="mt-3 border-t border-white/10 pt-1">
                        <summary className="min-h-11 cursor-pointer content-center text-sm font-medium text-teal-200 focus-visible:outline-2 focus-visible:outline-teal-300">
                            More instruments
                        </summary>
                        <dl className="mt-1 grid grid-cols-2 gap-2">
                            <Reading label="Through water" value={t.stw} unit="kt" />
                            <Reading label="Course over ground" value={t.cog} unit="°" digits={0} />
                            <Reading label="True wind direction" value={t.twd} unit="°" digits={0} />
                            <Reading label="True wind angle" value={t.twa} unit="°" digits={0} />
                            <Reading label="Heel" value={t.heel} unit="°" />
                            <Reading label="Pitch" value={t.pitch} unit="°" />
                            <Reading label="Rudder" value={t.rudder} unit="°" />
                        </dl>
                    </details>
                    <p className="mt-2 text-xs leading-relaxed text-slate-500">
                        Shared readings, not a navigation display. A dash means that sensor has not reported.
                    </p>
                </>
            )}
        </section>
    );
};
