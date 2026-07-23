/**
 * WindModelFieldSelector — compact model + field switcher for the animated
 * wind chart layer.
 *
 * Flips the animated overlay between weather MODELS. The list is
 * WIND_OVERLAY_MODELS — the SAME five the Glass picker offers (ICON, ECMWF,
 * AIFS, UKMO, JMA), in the same order and under the same names, so a model
 * named on one page means the same physics on the other. Shane 2026-07-22:
 * "the models do not match our models in the glass page".
 *
 * The WIND/GUST field toggle was REMOVED the same day ("we do not need gusts
 * on this page. just wind"). WindStore still carries the field and the
 * Open-Meteo path still returns gust, so restoring it is a UI change only —
 * but two of the five models (AIFS, JMA) publish no gust field at all, so any
 * future gust control must grey out per-model rather than assume it exists.
 *
 * Self-positioned (absolute, bottom-anchored), LEFT-aligned to line up with
 * the legend/scrubber column rather than floating centred over the chart.
 */
import React, { memo } from 'react';
import {
    AVAILABLE_MODELS,
    WIND_OVERLAY_MODELS,
    type WeatherModelId,
} from '../../services/weather/MultiModelWeatherService';
import { SELECTABLE_MODELS } from '../../services/weather/forecastModels';

/**
 * The Glass-matching five, resolved in WIND_OVERLAY_MODELS order.
 *
 * The CHIP LABEL is taken from the Glass picker rather than from
 * AVAILABLE_MODELS.name, matched on openMeteoModel — which IS the Glass id
 * since 2026-07-22. Two reasons, both real: the labels then cannot drift
 * apart again (the chart said "ECMWF IFS" where the Glass said "ECMWF"), and
 * the Glass names are shorter, which is most of the width the row needed to
 * lose. Falls back to the long name if a model has no Glass entry.
 */
const MODELS = WIND_OVERLAY_MODELS.map((id) => {
    const m = AVAILABLE_MODELS.find((x) => x.id === id)!;
    const glass = SELECTABLE_MODELS.find((g) => g.id === m.openMeteoModel);
    return { id: m.id, label: glass?.label ?? m.name };
});

interface WindModelFieldSelectorProps {
    model: WeatherModelId;
    onModelChange: (model: WeatherModelId) => void;
    loading?: boolean;
    embedded?: boolean;
}

export const WindModelFieldSelector: React.FC<WindModelFieldSelectorProps> = memo(
    ({ model, onModelChange, loading = false, embedded = false }) => {
        return (
            <div
                className="absolute z-[500]"
                // 152px, was 132px. The scrubber below is anchored at 80px and
                // stands ~60px tall (44px play button + 8px padding each side),
                // so its top edge is ~140px — the row was OVERLAPPING it by
                // about 8px, not merely touching (Shane 2026-07-22). 152 leaves
                // a deliberate 12px gap so the two read as separate controls.
                style={{ left: 12, bottom: embedded ? 70 : 'calc(152px + env(safe-area-inset-bottom))' }}
            >
                <div className="bg-slate-900/90 border border-white/[0.08] rounded-2xl px-2 py-1.5 flex flex-col gap-1.5 shadow-lg shadow-black/30">
                    {/* Model chips (horizontally scrollable) */}
                    {/* Narrower (Shane 2026-07-22). Was max-w-[88vw], which
                        sprawled the row across almost the whole chart. The
                        shorter Glass labels do most of the work; this caps
                        what is left. Still overflow-x-auto, so a longer list
                        scrolls rather than being clipped. */}
                    <div className="flex items-center gap-1 overflow-x-auto no-scrollbar max-w-[68vw]">
                        {MODELS.map((m) => {
                            const active = m.id === model;
                            return (
                                <button
                                    key={m.id}
                                    aria-label={`Wind model ${m.label}`}
                                    aria-pressed={active}
                                    onClick={() => onModelChange(m.id)}
                                    className={
                                        'min-h-[44px] min-w-[44px] shrink-0 px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-wide transition-colors active:scale-95 ' +
                                        (active
                                            ? 'bg-sky-500/25 border border-sky-400/40 text-sky-200'
                                            : 'bg-white/[0.04] border border-white/[0.06] text-gray-400')
                                    }
                                >
                                    {m.label}
                                </button>
                            );
                        })}
                    </div>

                    {/* Loading pip while the new grid streams in */}
                    <div className="flex items-center justify-end">
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
