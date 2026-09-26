/**
 * ModelPickerSheet — bottom sheet for choosing the Glass forecast model.
 *
 * Opens from the model pill in the StatusBadges row. Inshore lists atmospheric
 * models plus Auto; offshore lists supported offshore sources.
 * Picking one writes the matching preference; WeatherContext notices the
 * change and force-refetches, so the Glass repaints with that model's
 * numbers within a few seconds — no manual refresh step.
 *
 * Follows the MetricPinSheet portal idiom (bottom-anchored, Esc + body
 * scroll lock, backdrop dismiss).
 */
import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePanePortalTarget } from '../../context/PanePortalContext';
import type { OffshoreModel, WeatherModel } from '../../types';
import {
    AUTO_MODEL,
    SELECTABLE_MODELS,
    MODEL_ATTRIBUTION_LINE,
    SPITFIRE_MODEL,
    OFFSHORE_MODELS,
} from '../../services/weather/forecastModels';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { Button } from '../ui/Button';
import { PartlyCloudyIcon, XIcon } from '../Icons';

interface ModelPickerSheetProps {
    visible: boolean;
    currentModel: WeatherModel;
    onPick: (id: WeatherModel) => void;
    onClose: () => void;
    /** Manual refresh escape hatch — refresh is automatic, but after an
     *  error the user needs a way to retry on their own schedule. */
    onRefresh: () => void;
    /** Offshore uses the supported StormGlass source keys and a separate
     * preference, not the atmospheric Open-Meteo/publisher catalogue. */
    offshore?: { currentModel: OffshoreModel; onPick: (id: OffshoreModel) => void };
    /** SPITFIRE is only computed for a fixed list of locations, so it is
     *  offered only when the boat is near one — it is a blend, not a grid,
     *  and has nothing to say anywhere else. */
    spitfireAvailable?: boolean;
    /** Where it applies, for the row's helper line. */
    spitfireLocationName?: string;
    /**
     * Models the wx publisher has FRESH rows for in the boat's current cell
     * (wx_point_forecasts). When non-empty, the grid list is filtered to it —
     * a model the publisher does not carry here is not offered, which is also
     * how Spitfire's QLD-only domain expresses itself without any coastline
     * hardcoded. Empty/undefined = publisher not live for this cell: the full
     * built-in list is offered and fetches fall through to the live proxy.
     */
    publishedModels?: string[];
}

/** Words that keep their capital after the dash (proper nouns, acronyms). */
const KEEPS_CAPITAL = /^(?:[A-Z]{2,}|European|German|Japan|Japanese|British|French|Australian)\b/;

/**
 * One clause per row. Blurbs that already carry their own em-dash clause
 * ('ECMWF AI model — no gust field', 'Japan — western Pacific, …') stuttered
 * behind a second 'Provider — ' prefix; they stand alone, and the provider is
 * still credited in the attribution line at the foot of the sheet. A provider
 * that IS the row's label ('ECMWF' under 'ECMWF') is not repeated, and the
 * clause after an added dash continues the sentence in lower case, as the
 * blurbs with their own dash already do (UX scorecard run 6).
 */
function modelHelper(label: string, provider: string, blurb: string): string {
    if (blurb.includes('—') || blurb.startsWith(provider) || provider === label) return blurb;
    const clause = KEEPS_CAPITAL.test(blurb) ? blurb : blurb.charAt(0).toLowerCase() + blurb.slice(1);
    return `${provider} — ${clause}`;
}

/**
 * How far ahead each model reaches, in whole days from today, for the row's
 * '· 7 days'. The Glass pages past a model's last day into cells of dashes,
 * and nothing said why (UX scorecard run 6).
 *
 * The model catalogue carries no horizon, so these were measured on the wx
 * server on 2026-09-26: hours of non-null 10 m wind from 00 UTC (ICON 181,
 * ECMWF 351, AIFS 366, UKMO 157, JMA 258), floored so a row never promises a
 * day the model does not reach. The run lengths behind them are fixed by each
 * centre's schedule (ICON 180 h, UKMO 168 h, JMA 264 h, IFS and AIFS 360 h).
 * Blends (Spitfire, Auto) and the StormGlass offshore sources have no single
 * horizon and show none.
 */
const MODEL_RANGE_DAYS: Readonly<Record<string, number>> = {
    dwd_icon: 7,
    ecmwf_ifs025: 14,
    ecmwf_aifs025_single: 15,
    ukmo_global_deterministic_10km: 6,
    jma_gsm: 10,
};

/** The attribution line, with 'Météo-France' kept on one line. */
const AttributionLine: React.FC<{ text: string }> = ({ text }) => {
    const name = 'Météo-France';
    const at = text.indexOf(name);
    if (at < 0) return <>{text}</>;
    return (
        <>
            {text.slice(0, at)}
            <span className="whitespace-nowrap">{name}</span>
            {text.slice(at + name.length)}
        </>
    );
};

export const ModelPickerSheet: React.FC<ModelPickerSheetProps> = ({
    visible,
    currentModel,
    onPick,
    onClose,
    onRefresh,
    offshore,
    spitfireAvailable = false,
    spitfireLocationName,
    publishedModels,
}) => {
    const portalTarget = usePanePortalTarget();
    const titleId = useId();
    // Intersect, but never present an EMPTY picker: a publisher outage must
    // degrade to the built-in list, not to a sheet with nothing to choose.
    const grids =
        publishedModels && publishedModels.length > 0
            ? (() => {
                  const filtered = SELECTABLE_MODELS.filter((m) => publishedModels.includes(m.id));
                  return filtered.length > 0 ? filtered : SELECTABLE_MODELS;
              })()
            : SELECTABLE_MODELS;
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(visible, { initialFocusRef: closeButtonRef, onEscape: onClose });

    // Lock body scroll while open
    useEffect(() => {
        if (!visible || portalTarget !== document.body) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = prev;
        };
    }, [visible, portalTarget]);

    if (!visible) return null;

    const row = (
        id: string,
        label: string,
        helper: string,
        swatch: string | undefined,
        isActive: boolean,
        onSelect: () => void,
        rangeDays?: number,
    ): React.ReactNode => {
        return (
            <button
                key={id}
                onClick={onSelect}
                aria-label={`Use the ${label} forecast model`}
                aria-current={isActive ? 'true' : undefined}
                className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all active:scale-[0.98] ${
                    isActive ? 'bg-sky-500/15 border-sky-400/40' : 'bg-white/3 border-white/6 hover:bg-white/6'
                }`}
            >
                <div
                    className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                        isActive ? 'bg-sky-500/20' : 'bg-white/4'
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
                        {rangeDays !== undefined && (
                            <span className="normal-case tracking-normal font-semibold text-slate-400">
                                {' · '}
                                {rangeDays} days
                            </span>
                        )}
                    </p>
                    <p className="text-[12px] leading-snug text-slate-400 line-clamp-2">{helper}</p>
                </div>
                {isActive && (
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-sky-300">Active</span>
                )}
            </button>
        );
    };
    const atmosphericRow = (id: WeatherModel, label: string, helper: string, swatch?: string) =>
        row(id, label, helper, swatch, currentModel === id, () => onPick(id), MODEL_RANGE_DAYS[id]);

    return createPortal(
        <div
            className="fixed inset-0 z-9998 flex items-center justify-center p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
            onClick={onClose}
            role="dialog"
            aria-modal={portalTarget?.tagName === 'BODY' ? true : undefined}
            aria-labelledby={titleId}
            ref={dialogRef}
        >
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/70 backdrop-blur-xs animate-in fade-in duration-200" />

            {/* Centred per the standing modal rule (Shane 2026-09-02: "all modal boxes centered on the punters screen"). */}
            <div
                className="relative w-full max-w-md bg-slate-900/95 border border-white/10 rounded-2xl shadow-2xl max-h-full overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header — the one Glass dialog header: icon, sentence-case
                    title, top-right close (UX scorecard run 6). */}
                <div className="px-5 pt-5 pb-3 border-b border-white/6 sticky top-0 bg-slate-900/95 z-10">
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                            <div className="w-7 h-7 shrink-0 rounded-full bg-sky-500/20 flex items-center justify-center">
                                <PartlyCloudyIcon className="w-4 h-4 text-sky-400" />
                            </div>
                            <h2 id={titleId} className="text-base font-bold text-white tracking-tight">
                                {offshore ? 'Offshore forecast model' : 'Forecast model'}
                            </h2>
                        </div>
                        <button
                            ref={closeButtonRef}
                            type="button"
                            onClick={onClose}
                            aria-label={offshore ? 'Close offshore forecast model' : 'Close forecast model'}
                            className="hit-target-44 shrink-0 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
                        >
                            <XIcon className="w-4 h-4" />
                        </button>
                    </div>
                    <p className="text-[12px] text-slate-400 mt-1 leading-relaxed">
                        {offshore
                            ? 'Choose the offshore source used here. Your inshore model stays saved separately. Unavailable fields and fallback sources remain labelled.'
                            : "The Glass repaints with the chosen model's numbers. Long-press any metric to see how the models compare."}
                    </p>
                </div>

                {/* Scrollable list */}
                <div className="overflow-y-auto max-h-[60dvh] px-3 py-3 space-y-1.5">
                    {/* SPITFIRE first when it applies here — it is the only
                        entry scored against real observations. */}
                    {offshore ? (
                        OFFSHORE_MODELS.map((m) =>
                            row(
                                m.id,
                                m.label,
                                modelHelper(m.label, m.provider, m.blurb),
                                m.hex,
                                offshore.currentModel === m.id,
                                () => offshore.onPick(m.id),
                            ),
                        )
                    ) : (
                        <>
                            {spitfireAvailable && (
                                <>
                                    {atmosphericRow(
                                        SPITFIRE_MODEL,
                                        'Spitfire',
                                        `Weighted blend of 5 models${spitfireLocationName ? ` · ${spitfireLocationName}` : ''}`,
                                        '#facc15',
                                    )}
                                    <div className="h-px bg-white/6 my-2" />
                                </>
                            )}

                            {grids.map((m) =>
                                atmosphericRow(m.id, m.label, modelHelper(m.label, m.provider, m.blurb), m.hex),
                            )}

                            {/* Divider */}
                            <div className="h-px bg-white/6 my-2" />

                            {atmosphericRow(AUTO_MODEL, 'Auto', 'Blended sources — no pinned model')}
                        </>
                    )}
                </div>

                {/* Footer */}
                <div className="px-4 py-3 border-t border-white/6 space-y-2">
                    <button
                        onClick={() => {
                            onRefresh();
                            onClose();
                        }}
                        aria-label="Refresh weather data now"
                        className="w-full min-h-11 py-2.5 rounded-xl bg-sky-500/10 border border-sky-400/20 text-sky-300 text-sm font-bold hover:bg-sky-500/20 transition-colors"
                    >
                        Refresh now
                    </button>
                    <Button variant="secondary" onClick={onClose} className="w-full text-slate-300">
                        Close
                    </Button>
                    <p className="text-[9px] text-gray-400 text-center">
                        {offshore ? (
                            'Marine forecasts via StormGlass. ICON atmosphere: DWD / Open-Meteo (CC-BY-4.0).'
                        ) : (
                            <AttributionLine text={MODEL_ATTRIBUTION_LINE} />
                        )}
                    </p>
                </div>
            </div>
        </div>,
        portalTarget!,
    );
};

ModelPickerSheet.displayName = 'ModelPickerSheet';
