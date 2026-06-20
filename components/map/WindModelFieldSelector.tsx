/**
 * WindModelFieldSelector — compact model + field switcher for the animated
 * wind chart layer.
 *
 * Lets the user flip the animated overlay between weather MODELS (GFS / ECMWF /
 * ICON / ACCESS-G / GEM) and between the wind and GUST FIELDS — the PredictWind-
 * style capability the data pipeline already supports (multi-model gridded wind +
 * gust from Open-Meteo). GFS sustained wind keeps the fine GRIB-edge path; every
 * other selection routes through the Open-Meteo gridded source in WindDataController.
 *
 * Self-positioned (absolute, bottom-anchored) to float just above the scrubber.
 */
import React, { memo } from 'react';
import { AVAILABLE_MODELS, type WeatherModelId } from '../../services/weather/MultiModelWeatherService';
import type { WindFieldKind } from '../../stores/WindStore';

interface WindModelFieldSelectorProps {
    model: WeatherModelId;
    field: WindFieldKind;
    onModelChange: (model: WeatherModelId) => void;
    onFieldChange: (field: WindFieldKind) => void;
    loading?: boolean;
    embedded?: boolean;
}

const FIELDS: { id: WindFieldKind; label: string }[] = [
    { id: 'wind', label: 'Wind' },
    { id: 'gust', label: 'Gust' },
];

export const WindModelFieldSelector: React.FC<WindModelFieldSelectorProps> = memo(
    ({ model, field, onModelChange, onFieldChange, loading = false, embedded = false }) => {
        return (
            <div
                className="absolute left-1/2 -translate-x-1/2 z-[500]"
                style={{ bottom: embedded ? 70 : 'calc(132px + env(safe-area-inset-bottom))' }}
            >
                <div className="bg-slate-900/90 border border-white/[0.08] rounded-2xl px-2 py-1.5 flex flex-col gap-1.5 shadow-lg shadow-black/30">
                    {/* Model chips (horizontally scrollable) */}
                    <div className="flex items-center gap-1 overflow-x-auto no-scrollbar max-w-[88vw]">
                        {AVAILABLE_MODELS.map((m) => {
                            const active = m.id === model;
                            return (
                                <button
                                    key={m.id}
                                    aria-label={`Wind model ${m.name}`}
                                    aria-pressed={active}
                                    onClick={() => onModelChange(m.id)}
                                    className={
                                        'shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-black uppercase tracking-wider transition-colors active:scale-95 ' +
                                        (active
                                            ? 'bg-sky-500/25 border border-sky-400/40 text-sky-200'
                                            : 'bg-white/[0.04] border border-white/[0.06] text-gray-400')
                                    }
                                >
                                    {m.name}
                                </button>
                            );
                        })}
                    </div>

                    {/* Field toggle: Wind ↔ Gust */}
                    <div className="flex items-center gap-1">
                        <div className="flex-1 grid grid-cols-2 gap-1 bg-white/[0.03] rounded-lg p-0.5">
                            {FIELDS.map((f) => {
                                const active = f.id === field;
                                return (
                                    <button
                                        key={f.id}
                                        aria-label={`${f.label} field`}
                                        aria-pressed={active}
                                        onClick={() => onFieldChange(f.id)}
                                        className={
                                            'py-1 rounded-md text-[11px] font-black uppercase tracking-wider transition-colors active:scale-95 ' +
                                            (active ? 'bg-sky-500/30 text-white' : 'text-gray-400')
                                        }
                                    >
                                        {f.label}
                                    </button>
                                );
                            })}
                        </div>
                        {/* Loading pip while the new grid streams in */}
                        <span
                            className={
                                'w-2 h-2 rounded-full shrink-0 transition-opacity ' +
                                (loading ? 'bg-sky-400 animate-pulse opacity-100' : 'opacity-0')
                            }
                            aria-hidden
                        />
                    </div>
                </div>
            </div>
        );
    },
);

WindModelFieldSelector.displayName = 'WindModelFieldSelector';
