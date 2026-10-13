/**
 * WeatherInspectPopup — Glassmorphic weather info card shown on map tap.
 *
 * Renders a floating dark-glass card with current conditions at the
 * tapped coordinate. Shows atmospheric data always, marine data only
 * when over water.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { PointWeatherData } from '../../services/weather/pointWeather';
import { mToFt } from '../../utils/units';
import { ThermometerIcon, WaveIcon, WindIcon } from '../icons/WeatherIcons';
import { GaugeIcon } from '../icons/MaritimeIcons';
import { CheckIcon, RefreshIcon, StarIcon } from '../icons/UIIcons';
import { GustIcon, WavePeriodIcon } from '../icons/GlassGlyphs';
import { describeNearestBuoy, type BuoyLineUnits } from '../../services/weather/buoys/describe';
import type { NearestBuoyResult } from '../../services/weather/buoys/types';

/**
 * Save affordance. The popup renders in its OWN React root (MapHub calls
 * createRoot on a detached node), so it sits outside the app's context
 * providers — it cannot reach useSettings itself. MapHub owns the
 * settings write and hands the behaviour down.
 */
export interface InspectSaveProps {
    /** Reverse-geocoded place name, or a coord string until one lands. */
    suggestedName: string;
    /** Name this exact point is already saved under, if it is. */
    savedAs: string | null;
    /** Persist under the (possibly user-edited) name. */
    onSave: (name: string) => void;
    /** Drop the saved entry. */
    onUnsave: (name: string) => void;
    /**
     * Called when the user opens the name editor. Reverse geocoding is
     * deferred to here rather than run on popup open: this popup appears
     * on EVERY inspect tap, the name is only ever shown in the editor,
     * and each lookup is a billed, on-device-unbounded request.
     */
    onRequestName?: () => void;
}

interface Props {
    data: PointWeatherData | null;
    loading: boolean;
    error?: string | null;
    onRetry?: () => void;
    onClose: () => void;
    /** Omitted where saving makes no sense (e.g. no settings owner). */
    save?: InspectSaveProps;
    /**
     * The nearest wave buoy: 'checking' while the feeds load, the answer once
     * they have, null (or omitted) when there is no check to show.
     */
    buoy?: NearestBuoyResult | 'checking' | null;
    /** The user's wave-height and distance units, for the buoy line. */
    units?: BuoyLineUnits;
    /**
     * Open the Sounding sheet for this point (build 125, SND): ECMWF's upper
     * air as a skew-T. An explicit tap, so nothing is fetched until asked.
     */
    onOpenSounding?: () => void;
}

// ── Direction helpers ──

function degToCardinal(deg: number): string {
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
}

function kmhToKnots(kmh: number): number {
    return Math.round(kmh / 1.852);
}

function metresToFeet(m: number): number {
    return Math.round(mToFt(m)); // canonical 3.28084 (was a drifted 3.281)
}

// ── Skeleton shimmer ──

const Shimmer: React.FC<{ w?: string }> = ({ w = 'w-12' }) => (
    <div className={`h-4 ${w} rounded-sm bg-white/10 animate-pulse`} />
);

// ── Metric row ──

const Metric: React.FC<{
    icon: React.ReactNode;
    label: string;
    value: string;
    sub?: string;
    loading?: boolean;
}> = ({ icon, label, value, sub, loading }) => (
    <div className="flex items-center gap-2.5 py-1.5">
        <span className="shrink-0 w-5 flex items-center justify-center text-sky-300">{icon}</span>
        <div className="flex-1 min-w-0">
            <p className="text-xs text-white/50 font-bold uppercase tracking-wider leading-none">{label}</p>
            {loading ? (
                <Shimmer />
            ) : (
                <p className="text-[13px] text-white font-bold leading-tight">
                    {value}
                    {sub && <span className="text-white/40 text-xs font-medium ml-1">{sub}</span>}
                </p>
            )}
        </div>
    </div>
);

/** Missing reading → '--', never an invented 0 (UX scorecard run 6). */
const DASH = '--';

// ── Wind direction arrow ──

/** The bubble is upright on a turned chart: the arrow takes off its --chart-bearing (127-11a). */
const WindArrow: React.FC<{ deg: number }> = ({ deg }) => (
    <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        style={{
            transform: `rotate(calc(${deg + 180}deg - var(--chart-bearing, 0deg)))`,
            transition: 'transform 0.3s',
        }}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-sky-400 shrink-0"
    >
        <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
);

// ── Save row ──

/**
 * Save-this-spot footer. Collapsed it's one button; naming is behind an
 * explicit tap so the iOS keyboard never ambushes a punter who only
 * wanted to read the conditions (this popup opens on EVERY inspect tap).
 */
const SaveRow: React.FC<{ save: InspectSaveProps }> = ({ save }) => {
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState(save.suggestedName);
    /** Has the punter typed? Once they have, nothing overwrites them. */
    const [dirty, setDirty] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    // Follow the suggested name until the user types. The geocode is
    // kicked off when the editor opens, so it lands WHILE the field is
    // showing the coord fallback — this is what upgrades it in place to
    // "Airlie Beach, QLD, AU" without stomping anything they've typed.
    useEffect(() => {
        if (!dirty) setName(save.suggestedName);
    }, [save.suggestedName, dirty]);

    useEffect(() => {
        if (!editing) return;
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [editing]);

    const commit = () => {
        const trimmed = name.trim();
        if (!trimmed) return;
        save.onSave(trimmed);
        setEditing(false);
    };

    if (save.savedAs) {
        return (
            <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-white/6">
                <CheckIcon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="flex-1 min-w-0 truncate text-xs text-white/60">
                    Saved as <span className="text-white/90 font-semibold">{save.savedAs}</span>
                </span>
                <button
                    type="button"
                    onClick={() => save.onUnsave(save.savedAs!)}
                    className="hit-target-44 shrink-0 px-2 py-1 rounded-lg text-xs font-semibold text-white/40 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                >
                    Remove
                </button>
            </div>
        );
    }

    if (!editing) {
        return (
            <button
                type="button"
                onClick={() => {
                    save.onRequestName?.();
                    setEditing(true);
                }}
                className="w-full flex items-center justify-center gap-1.5 mt-2 pt-2 border-t border-white/6 py-2 text-amber-300 hover:text-amber-200 transition-colors"
            >
                <StarIcon className="w-3.5 h-3.5" />
                <span className="text-[12px] font-bold">Save this spot</span>
            </button>
        );
    }

    return (
        <div className="mt-2 pt-2 border-t border-white/6">
            <input
                ref={inputRef}
                value={name}
                onChange={(e) => {
                    setDirty(true);
                    setName(e.target.value);
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') commit();
                    if (e.key === 'Escape') setEditing(false);
                }}
                aria-label="Location name"
                placeholder="Name this spot"
                className="w-full px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[12px] text-white placeholder-white/30 outline-hidden focus:border-amber-400/50"
            />
            <div className="flex gap-1.5 mt-1.5">
                <button
                    type="button"
                    onClick={commit}
                    disabled={!name.trim()}
                    className="min-h-[44px] flex-1 py-1.5 rounded-lg bg-amber-500/20 text-amber-200 text-[12px] font-bold hover:bg-amber-500/30 disabled:opacity-40 transition-colors"
                >
                    Save
                </button>
                <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="min-h-[44px] px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white/40 hover:text-white/70 transition-colors"
                >
                    Cancel
                </button>
            </div>
        </div>
    );
};

// ── Main component ──

export const WeatherInspectPopup: React.FC<Props> = ({
    data,
    loading,
    error,
    onRetry,
    onClose,
    save,
    buoy,
    units,
    onOpenSounding,
}) => {
    const hasMarine = data && data.waveHeightM != null && data.waveHeightM > 0;
    /**
     * The sea half is still in the air. The atmospherics now paint as soon as
     * they land rather than waiting for the marine request, so there is a real
     * moment where wind and pressure are known and waves are not — and it must
     * read as "coming", not as "this is dry land".
     */
    const marinePending = data?.marineStatus === 'pending';

    /**
     * The way into the upper air over this point (build 125, SND): a pill on
     * a line the bubble already has, never a row of its own. The bubble
     * cannot scroll, and on a 568 px screen every line pushes the Save row
     * toward the tab bar. The sounding is its own fetch, so it is there
     * whether or not the point forecast loaded: beside the coordinates once
     * they show, at the foot while the forecast loads or after it failed.
     */
    const soundingPill = onOpenSounding ? (
        <button
            type="button"
            onClick={onOpenSounding}
            aria-label="Sounding: the upper air over this point"
            className="hit-target-44 inline-flex min-h-7 shrink-0 items-center gap-1 rounded-full bg-sky-400/10 px-2.5 text-[12px] font-bold text-sky-300 transition-colors hover:bg-sky-400/20 hover:text-sky-200"
        >
            Sounding
            <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true" className="shrink-0">
                <path d="M2 1l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
        </button>
    ) : null;

    return (
        <div style={{ minWidth: 240, maxWidth: 280 }}>
            {/* Card */}
            <div
                style={{
                    background: 'var(--day-ui-surface, linear-gradient(135deg, rgb(15,23,42), rgb(20,30,50)))',
                    backdropFilter: 'blur(20px) saturate(1.4)',
                    WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
                    border: '1px solid var(--day-ui-border, rgba(255,255,255,0.1))',
                    borderRadius: 16,
                    boxShadow:
                        'var(--day-ui-shadow, 0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05) inset)',
                }}
                className="p-3 relative"
            >
                {/* Close button */}
                <button
                    onClick={onClose}
                    className="absolute top-1 right-1 w-11 h-11 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10"
                    aria-label="Close dialog"
                >
                    <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        className="text-white/50"
                    >
                        <path d="M1 1l8 8M9 1l-8 8" />
                    </svg>
                </button>

                {/* ── Loading skeleton ── */}
                {loading && !data && (
                    <div className="animate-pulse">
                        {/* Coord placeholder */}
                        <div className="h-3.5 w-28 rounded-sm bg-sky-400/10 mb-3" />

                        {/* Atmospheric skeleton grid */}
                        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                            {[0, 1, 2, 3].map((i) => (
                                <div key={i} className="flex items-center gap-2.5 py-1.5">
                                    <div className="w-5 h-5 rounded-sm bg-white/5 shrink-0" />
                                    <div className="flex-1 space-y-1.5">
                                        <div className="h-2.5 w-10 rounded-sm bg-white/5" />
                                        <div className="h-3.5 w-14 rounded-sm bg-white/10" />
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Divider */}
                        <div className="h-px bg-white/6 my-2" />

                        {/* Marine skeleton grid */}
                        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                            {[0, 1].map((i) => (
                                <div key={i} className="flex items-center gap-2.5 py-1.5">
                                    <div className="w-5 h-5 rounded-sm bg-white/5 shrink-0" />
                                    <div className="flex-1 space-y-1.5">
                                        <div className="h-2.5 w-10 rounded-sm bg-white/5" />
                                        <div className="h-3.5 w-16 rounded-sm bg-white/10" />
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Loading label */}
                        <div className="flex items-center justify-center gap-2 mt-2 pt-2 border-t border-white/4">
                            <div className="w-3 h-3 border-2 border-sky-400/30 border-t-sky-400 rounded-full animate-spin" />
                            <span className="text-xs text-sky-400/50 font-medium tracking-wider uppercase">
                                Loading weather…
                            </span>
                        </div>
                    </div>
                )}

                {/* A failed point request must never collapse into a blank
                    card. Keep Save available, state what is missing, and put
                    the recovery action directly beside the failure. */}
                {!loading && !data && error && (
                    <div role="alert" className="px-2 pb-2 pt-8 text-center">
                        <RefreshIcon className="mx-auto w-5 h-5 text-amber-200" />
                        <p className="mt-1 text-sm font-bold text-amber-200">Weather unavailable</p>
                        <p className="mt-1 text-xs leading-relaxed text-slate-300">{error}</p>
                        {onRetry && (
                            <button
                                type="button"
                                onClick={onRetry}
                                className="mt-3 min-h-11 w-full rounded-xl border border-sky-300/25 bg-sky-400/15 px-4 py-2 text-sm font-bold text-sky-100 transition-colors hover:bg-sky-400/25"
                            >
                                Retry weather
                            </button>
                        )}
                    </div>
                )}

                {/* ── Real content (shown when data arrives, or loading + data for updates) ── */}
                {(data || (loading && data)) && (
                    <div
                        style={{
                            animation: 'fadeInUp 0.3s ease-out',
                        }}
                    >
                        {/* Coordinate header; the Sounding pill keeps clear of the close button. */}
                        <div
                            className={`flex flex-wrap items-center gap-x-2 gap-y-1 mb-2 ${soundingPill ? 'pr-10' : 'pr-6'}`}
                        >
                            <span className="text-xs text-sky-400/70 font-mono font-bold">
                                {data
                                    ? `${Math.abs(data.lat).toFixed(2)}°${data.lat >= 0 ? 'N' : 'S'} ${Math.abs(data.lon).toFixed(2)}°${data.lon >= 0 ? 'E' : 'W'}`
                                    : '…'}
                            </span>
                            {soundingPill}
                        </div>

                        {/* Atmospheric section */}
                        <div className="grid grid-cols-2 gap-x-3">
                            <Metric
                                icon={<WindIcon className="w-4 h-4" />}
                                label="Wind"
                                value={
                                    data
                                        ? data.windSpeedKmh != null
                                            ? `${kmhToKnots(data.windSpeedKmh)} kts`
                                            : DASH
                                        : ''
                                }
                                sub={data && data.windDirectionDeg != null ? degToCardinal(data.windDirectionDeg) : ''}
                                loading={loading && !data}
                            />
                            <Metric
                                icon={<ThermometerIcon className="w-4 h-4" />}
                                label="Temp"
                                value={
                                    data
                                        ? data.temperatureC != null
                                            ? `${Math.round(data.temperatureC)}°C`
                                            : DASH
                                        : ''
                                }
                                loading={loading && !data}
                            />
                            <Metric
                                icon={<GustIcon className="w-4 h-4" />}
                                label="Gusts"
                                value={
                                    data
                                        ? data.windGustsKmh != null
                                            ? `${kmhToKnots(data.windGustsKmh)} kts`
                                            : DASH
                                        : ''
                                }
                                loading={loading && !data}
                            />
                            <Metric
                                icon={<GaugeIcon className="w-4 h-4" />}
                                label="Pressure"
                                value={
                                    data
                                        ? data.pressureMsl != null
                                            ? `${Math.round(data.pressureMsl)} hPa`
                                            : DASH
                                        : ''
                                }
                                loading={loading && !data}
                            />
                        </div>

                        {/* Wind direction arrow row */}
                        {data && !loading && data.windDirectionDeg != null && (
                            <div className="flex items-center gap-1.5 mt-1 mb-1 px-0.5">
                                <WindArrow deg={data.windDirectionDeg} />
                                <span className="text-xs text-white/50 font-medium">
                                    From {degToCardinal(data.windDirectionDeg)} ({Math.round(data.windDirectionDeg)}°)
                                </span>
                            </div>
                        )}

                        {/* Marine section — only when over water */}
                        {hasMarine && (
                            <>
                                <div className="h-px bg-white/6 my-1.5" />
                                <div className="grid grid-cols-2 gap-x-3">
                                    <Metric
                                        icon={<WaveIcon className="w-4 h-4" />}
                                        label="Waves"
                                        value={
                                            data && data.waveHeightM != null
                                                ? `${data.waveHeightM.toFixed(1)}m / ${metresToFeet(data.waveHeightM)}ft`
                                                : ''
                                        }
                                        loading={loading && !data}
                                    />
                                    <Metric
                                        icon={<WavePeriodIcon className="w-4 h-4" />}
                                        label="Period"
                                        value={
                                            data && data.wavePeriodS != null ? `${data.wavePeriodS.toFixed(0)}s` : ''
                                        }
                                        sub={
                                            data && data.waveDirectionDeg != null
                                                ? degToCardinal(data.waveDirectionDeg)
                                                : ''
                                        }
                                        loading={loading && !data}
                                    />
                                    {data && data.swellHeightM != null && data.swellHeightM > 0 && (
                                        <>
                                            <Metric
                                                icon={<WaveIcon className="w-4 h-4" />}
                                                label="Swell"
                                                value={`${data.swellHeightM.toFixed(1)}m / ${metresToFeet(data.swellHeightM)}ft`}
                                                loading={loading && !data}
                                            />
                                            <Metric
                                                icon={<WavePeriodIcon className="w-4 h-4" />}
                                                label="Swell period"
                                                value={
                                                    data.swellPeriodS != null
                                                        ? `${data.swellPeriodS.toFixed(0)}s`
                                                        : DASH
                                                }
                                                sub={
                                                    data.swellDirectionDeg != null
                                                        ? degToCardinal(data.swellDirectionDeg)
                                                        : ''
                                                }
                                                loading={loading && !data}
                                            />
                                        </>
                                    )}
                                </div>
                            </>
                        )}

                        {marinePending && (
                            <div
                                role="status"
                                aria-live="polite"
                                className="mt-2 flex items-center gap-2 rounded-lg border border-white/6 bg-white/3 px-2.5 py-2 text-xs text-white/55"
                            >
                                <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-sky-400/30 border-t-sky-400" />
                                Sea state loading&hellip;
                            </div>
                        )}

                        {data?.marineStatus === 'land' && !hasMarine && (
                            <p className="mt-2 text-xs leading-relaxed text-white/45">
                                No sea state here — this point is over land.
                            </p>
                        )}

                        {data?.marineStatus === 'unavailable' && (
                            <div
                                role="status"
                                className="mt-2 rounded-lg border border-amber-300/20 bg-amber-400/10 px-2.5 py-2 text-xs leading-relaxed text-amber-100"
                            >
                                Marine wave data could not be reached. Wind and pressure above are still available.
                            </div>
                        )}

                        {/* Measured, not modelled: the nearest wave buoy, owner
                            credited. Not on land, and nothing when no check ran. */}
                        {data && !loading && buoy && data.marineStatus !== 'land' && (
                            <p role="status" aria-live="polite" className="mt-2 text-xs leading-relaxed text-white/70">
                                {buoy === 'checking' ? 'Checking wave buoys…' : describeNearestBuoy(buoy, units)}
                            </p>
                        )}

                        {data && !loading && (
                            <p className="mt-2 border-t border-white/6 pt-2 text-xs text-white/55">
                                Open-Meteo · fetched{' '}
                                {Math.max(0, Math.round((Date.now() - data.fetchedAt) / 60_000)) <= 1
                                    ? 'now'
                                    : `${Math.round((Date.now() - data.fetchedAt) / 60_000)} min ago`}
                            </p>
                        )}
                    </div>
                )}

                {/* No coordinates to sit beside yet (loading) or at all (failed): the pill waits at the foot. */}
                {soundingPill && !data && <div className="mt-2 flex border-t border-white/6 pt-2">{soundingPill}</div>}

                {/* Outside the data block on purpose: the spot is worth
                    saving whether or not its weather loaded (offshore on a
                    flaky link, the fetch is exactly what fails). */}
                {save && <SaveRow save={save} />}
            </div>
        </div>
    );
};
