/**
 * PassageModelModal — "can we have a change model modal button" (Shane,
 * 2026-09-18).
 *
 * ONE MODEL ON THE CHART. The strip's look-ahead numbers and the wind field
 * drawn under them come from the SAME model: this modal writes WindStore's
 * model, which is the one the chart's own wind chips write. A strip quoting
 * ECMWF over a field painted from ICON would be two forecasts dressed as one.
 * The list is WIND_OVERLAY_MODELS under the Glass picker's names, so a model
 * named here means the same physics as on the Glass and on the chart's chips.
 *
 * Centred and clear of the tab bar with an internal scroll, per the standing
 * modal rule (Shane 2026-09-02) — not a bottom sheet.
 */
import React from 'react';
import { OverlayPortal } from '../ui/OverlayPortal';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { WindStore, useWindStore } from '../../stores/WindStore';
import {
    AVAILABLE_MODELS,
    WIND_OVERLAY_MODELS,
    type WeatherModelId,
} from '../../services/weather/MultiModelWeatherService';
import { MODEL_ATTRIBUTION_LINE, SELECTABLE_MODELS } from '../../services/weather/forecastModels';
import { triggerHaptic } from '../../utils/system';

export interface PassageModelChoice {
    id: WeatherModelId;
    /** Open-Meteo model-domain id — what actually goes in `models=`. */
    openMeteoModel: string;
    label: string;
    provider: string;
    blurb: string;
    noGust: boolean;
}

/** The five, resolved once. Exported so the strip names the model the same way. */
export const PASSAGE_MODEL_CHOICES: PassageModelChoice[] = WIND_OVERLAY_MODELS.map((id) => {
    const m = AVAILABLE_MODELS.find((x) => x.id === id)!;
    const glass = SELECTABLE_MODELS.find((g) => g.id === m.openMeteoModel);
    return {
        id,
        openMeteoModel: m.openMeteoModel,
        label: glass?.label ?? m.name,
        // The provider is the CREDIT (CC-BY-4.0): it may never come out empty.
        // The Glass entry and the chart's own registry both carry one; only a
        // model missing from both could leave "Forecast data: " with no name,
        // and a test walks the list so that cannot ship.
        provider: glass?.provider || m.provider,
        blurb: glass?.blurb ?? '',
        noGust: !!glass?.missing?.includes('gust'),
    };
});

/** The chart's current model as the strip should name and request it. */
export function passageModelChoice(id: WeatherModelId): PassageModelChoice {
    // A model outside the five (an old GFS default) has no chip and no entry
    // here; fall back to the first offered rather than to an unnamed forecast.
    return PASSAGE_MODEL_CHOICES.find((c) => c.id === id) ?? PASSAGE_MODEL_CHOICES[0];
}

export const PassageModelModal: React.FC<{ visible: boolean; onClose: () => void }> = ({ visible, onClose }) => {
    const current = useWindStore().model;
    const dialogRef = useFocusTrap<HTMLDivElement>(visible, { onEscape: onClose });
    if (!visible) return null;

    return (
        <OverlayPortal
            className="pointer-events-auto flex items-center justify-center bg-black/55 p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
            role="presentation"
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label="Change forecast model"
                data-testid="passage-model-modal"
                tabIndex={-1}
                className="flex max-h-full w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950/95 text-white shadow-2xl backdrop-blur-xl"
            >
                <div className="shrink-0 border-b border-white/10 px-4 py-3">
                    <p className="text-sm font-black">Forecast model</p>
                    <p className="text-xs font-semibold text-gray-400">
                        One model for the look-ahead numbers and the wind on the chart.
                    </p>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    {PASSAGE_MODEL_CHOICES.map((choice) => {
                        const selected = passageModelChoice(current).id === choice.id;
                        return (
                            <button
                                key={choice.id}
                                type="button"
                                aria-pressed={selected}
                                data-testid={`passage-model-${choice.id}`}
                                onClick={() => {
                                    void triggerHaptic('light');
                                    WindStore.setModel(choice.id);
                                    onClose();
                                }}
                                className={`mb-1 flex min-h-14 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left active:scale-[0.99] ${
                                    selected ? 'border-amber-300/60 bg-amber-300/10' : 'border-white/5 bg-white/[0.03]'
                                }`}
                            >
                                <span
                                    className={`h-3 w-3 shrink-0 rounded-full border-2 ${
                                        selected ? 'border-amber-300 bg-amber-300' : 'border-white/30'
                                    }`}
                                    aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1">
                                    <span className="block text-sm font-black">
                                        {choice.label}
                                        <span className="ml-2 text-xs font-semibold text-gray-400">
                                            {choice.provider}
                                        </span>
                                    </span>
                                    <span className="block text-xs font-semibold text-gray-400">{choice.blurb}</span>
                                </span>
                            </button>
                        );
                    })}
                </div>
                <div className="shrink-0 border-t border-white/10 px-4 py-3">
                    <p className="text-xs font-semibold text-gray-400">{MODEL_ATTRIBUTION_LINE}</p>
                    <button
                        type="button"
                        onClick={onClose}
                        className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-white/5 text-sm font-black active:scale-[0.99]"
                    >
                        Close
                    </button>
                </div>
            </div>
        </OverlayPortal>
    );
};
