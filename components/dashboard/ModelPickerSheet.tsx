/**
 * ModelPickerSheet — bottom sheet for choosing the Glass forecast model.
 *
 * Opens from the model pill in the StatusBadges row. Lists the six
 * selectable global models plus Auto (the legacy WeatherKit-primary blend).
 * Picking one writes settings.forecastModel; WeatherContext notices the
 * change and force-refetches, so the Glass repaints with that model's
 * numbers within a few seconds — no manual refresh step.
 *
 * Follows the MetricPinSheet portal idiom (bottom-anchored, Esc + body
 * scroll lock, backdrop dismiss).
 */
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { WeatherModel } from '../../types';
import {
    AUTO_MODEL,
    SELECTABLE_MODELS,
    MODEL_ATTRIBUTION_LINE,
    SPITFIRE_MODEL,
} from '../../services/weather/forecastModels';

interface ModelPickerSheetProps {
    visible: boolean;
    currentModel: WeatherModel;
    onPick: (id: WeatherModel) => void;
    onClose: () => void;
    /** Manual refresh escape hatch — refresh is automatic, but after an
     *  error the user needs a way to retry on their own schedule. */
    onRefresh: () => void;
    /** SPITFIRE is only computed for a fixed list of locations, so it is
     *  offered only when the boat is near one — it is a blend, not a grid,
     *  and has nothing to say anywhere else. */
    spitfireAvailable?: boolean;
    /** Where it applies, for the row's helper line. */
    spitfireLocationName?: string;
}

export const ModelPickerSheet: React.FC<ModelPickerSheetProps> = ({
    visible,
    currentModel,
    onPick,
    onClose,
    onRefresh,
    spitfireAvailable = false,
    spitfireLocationName,
}) => {
    // ESC closes the sheet
    useEffect(() => {
        if (!visible) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [visible, onClose]);

    // Lock body scroll while open
    useEffect(() => {
        if (!visible) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = prev;
        };
    }, [visible]);

    if (!visible) return null;

    const row = (id: WeatherModel, label: string, helper: string, swatch?: string): React.ReactNode => {
        const isActive = currentModel === id;
        return (
            <button
                key={id}
                onClick={() => onPick(id)}
                aria-label={`Use the ${label} forecast model`}
                aria-current={isActive ? 'true' : undefined}
                className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all active:scale-[0.98] ${
                    isActive
                        ? 'bg-sky-500/15 border-sky-400/40'
                        : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.06]'
                }`}
            >
                <div
                    className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                        isActive ? 'bg-sky-500/20' : 'bg-white/[0.04]'
                    }`}
                >
                    {swatch ? (
                        <span className="w-3 h-3 rounded-full" style={{ backgroundColor: swatch }} />
                    ) : (
                        <span className="text-[10px] font-black text-slate-400">A</span>
                    )}
                </div>
                <div className="flex-1 min-w-0 text-left">
                    <p
                        className={`text-xs font-bold uppercase tracking-widest ${
                            isActive ? 'text-sky-200' : 'text-white'
                        }`}
                    >
                        {label}
                    </p>
                    <p className="text-[12px] text-slate-400 truncate">{helper}</p>
                </div>
                {isActive && (
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-sky-300">Active</span>
                )}
            </button>
        );
    };

    return createPortal(
        <div
            className="fixed inset-0 z-[9998] flex items-end sm:items-center justify-center"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label="Choose a forecast model"
        >
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200" />

            {/* Sheet */}
            <div
                className="relative w-full max-w-md bg-slate-900/95 border-t sm:border border-white/10 rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[85dvh] overflow-hidden animate-in slide-in-from-bottom sm:zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
                style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
            >
                {/* Header */}
                <div className="px-5 pt-5 pb-3 border-b border-white/[0.06] sticky top-0 bg-slate-900/95 z-10">
                    <h2 className="text-base font-bold text-white tracking-tight">Forecast model</h2>
                    <p className="text-[12px] text-slate-400 mt-1 leading-relaxed">
                        The Glass repaints with the chosen model&apos;s numbers. Long-press any metric to see how the
                        models compare.
                    </p>
                </div>

                {/* Scrollable list */}
                <div className="overflow-y-auto max-h-[60dvh] px-3 py-3 space-y-1.5">
                    {/* SPITFIRE first when it applies here — it is the only
                        entry scored against real observations. */}
                    {spitfireAvailable && (
                        <>
                            {row(
                                SPITFIRE_MODEL,
                                'Spitfire',
                                `Weighted blend of 5 models${spitfireLocationName ? ` · ${spitfireLocationName}` : ''}`,
                                '#facc15',
                            )}
                            <div className="h-px bg-white/[0.06] my-2" />
                        </>
                    )}

                    {SELECTABLE_MODELS.map((m) => row(m.id, m.label, `${m.provider} — ${m.blurb}`, m.hex))}

                    {/* Divider */}
                    <div className="h-px bg-white/[0.06] my-2" />

                    {row(AUTO_MODEL, 'Auto', 'Blended sources — no pinned model')}
                </div>

                {/* Footer */}
                <div className="px-4 py-3 border-t border-white/[0.06] space-y-2">
                    <button
                        onClick={() => {
                            onRefresh();
                            onClose();
                        }}
                        aria-label="Refresh weather data now"
                        className="w-full py-2.5 rounded-xl bg-sky-500/10 border border-sky-400/20 text-sky-300 text-sm font-bold uppercase tracking-wider hover:bg-sky-500/20 transition-colors"
                    >
                        Refresh now
                    </button>
                    <p className="text-[9px] text-gray-600 text-center">{MODEL_ATTRIBUTION_LINE}</p>
                </div>
            </div>
        </div>,
        document.body,
    );
};

ModelPickerSheet.displayName = 'ModelPickerSheet';
