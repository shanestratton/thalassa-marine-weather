/**
 * ModelCheckAtBoat — the "Her wind vs the models" card, a lazy chunk opened
 * from the Wind panel's row (MapWeatherControls).
 *
 * Shane 2026-10-07: "go with your recommendation big Claude", for "her live
 * wind against each model's forecast for this hour at her position, ranked,
 * with a clear caveat that one reading is a snapshot, not a verdict".
 *
 * Read-only: no model can be picked from here, and nothing here calls a model
 * best. Every string comes from buildModelCheckView (boatModelCheck), so the
 * words are tested where they are made. Centred and clear of the tab bar, the
 * standing modal rule; the header (title, ⓘ, ✕ and the caveat) and the credit
 * never scroll, and the body scrolls only as a last resort.
 *
 * While open: her wind is re-read every 2 s from her own lanes, her cloud row
 * is asked for on the boat chain's shared 30 s throttle, and the models are
 * asked for once per 10 NM and hour, never while a refusal stands.
 */
import React, { useEffect, useState } from 'react';
import { OverlayPortal } from '../ui/OverlayPortal';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useSettingsStore } from '../../stores/settingsStore';
import {
    WEATHER_FOLLOW_TARGET_EVENT,
    lookUpFollowedBoatCloudRow,
    type WeatherFollowTarget,
} from '../../services/weatherPosition';
import { haversineNM } from '../../utils/gpsFollow';
import {
    CLOUD_LOOKUP_MS,
    EMPTY_SESSION,
    RECHECK_MS,
    SERIES_REUSE_NM,
    addHerReading,
    assessHerWind,
    buildModelCheckView,
    gatherHerWindInput,
    loadModelsAtHer,
    modelCheckDetails,
    peekModelsAtHer,
    type HerAssessment,
    type HerSession,
    type ModelCheckView,
    type ModelSeriesState,
} from './boatModelCheck';

const TONE_CLASS = { emerald: 'text-emerald-300', amber: 'text-amber-300', rose: 'text-rose-300' } as const;
const CONTROL_CLASS =
    'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-base active:scale-95';

export interface ModelCheckCardProps {
    view: ModelCheckView;
    details: boolean;
    onToggleDetails: () => void;
    onClose: () => void;
    /** The details' direction threshold is said in her speed unit. */
    speedUnit?: string;
}

/** The card itself: renders a view, holds no state. Exported for the layout fixture. */
export function ModelCheckCard({ view, details, onToggleDetails, onClose, speedUnit }: ModelCheckCardProps) {
    const dialogRef = useFocusTrap<HTMLDivElement>(true, { onEscape: onClose });
    const showRows = !details && view.rows.length > 0;
    return (
        <OverlayPortal
            data-model-check
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
                aria-label="Her wind vs the models"
                data-model-check-card
                tabIndex={-1}
                className="flex max-h-full w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950/95 text-white shadow-2xl backdrop-blur-xl"
            >
                <div data-model-check-header className="shrink-0 border-b border-white/10 px-4 py-2">
                    <div className="flex h-11 items-center gap-1">
                        <h2 className="min-w-0 flex-1 text-sm font-black leading-5">Her wind vs the models</h2>
                        <button
                            type="button"
                            aria-label="How this works"
                            aria-pressed={details}
                            onClick={onToggleDetails}
                            className={`${CONTROL_CLASS} ${details ? 'text-sky-300' : 'text-slate-200'}`}
                        >
                            <span aria-hidden="true">ⓘ</span>
                        </button>
                        <button type="button" aria-label="Close" onClick={onClose} className={CONTROL_CLASS}>
                            <span aria-hidden="true">✕</span>
                        </button>
                    </div>
                    <p className="mt-0.5 text-xs font-semibold leading-4 text-amber-200">{view.caveat}</p>
                </div>
                <div data-model-check-body className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
                    {details ? (
                        <div className="space-y-2">
                            {modelCheckDetails(speedUnit).map((text) => (
                                <p key={text} className="text-xs leading-4 text-slate-300">
                                    {text}
                                </p>
                            ))}
                        </div>
                    ) : (
                        <>
                            {view.her && (
                                <>
                                    <p className="text-base font-black leading-6">{view.her.value}</p>
                                    <p className="text-xs leading-4 text-slate-400">{view.her.source}</p>
                                </>
                            )}
                            {view.status && (
                                <div role="status" className={view.her ? 'mt-2' : ''}>
                                    <p className="text-sm leading-5 text-slate-200">{view.status.line1}</p>
                                    {view.status.line2 && (
                                        <p className="mt-1 text-xs leading-4 text-slate-400">{view.status.line2}</p>
                                    )}
                                </div>
                            )}
                            {showRows && view.verdict && (
                                <p role="status" className="mt-2 text-sm font-bold leading-5">
                                    {view.verdict}
                                </p>
                            )}
                            {showRows && (
                                // Rows on their 20 px line, unpadded: with both notes (the marina
                                // card) the whole card fits 320x568 in wide fonts (fit123).
                                <ol aria-label="Models, closest first" className="mt-1">
                                    {view.rows.map((row) => (
                                        <li
                                            key={row.id}
                                            className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-2 text-sm leading-5 tabular-nums"
                                        >
                                            <span
                                                className={`min-w-0 truncate ${row.mark ? 'font-black' : 'font-semibold'} ${row.onChart ? 'text-sky-300' : 'text-slate-100'}`}
                                            >
                                                {row.mark && <span aria-hidden="true">● </span>}
                                                {row.label}
                                                {row.onChart && <span className="sr-only"> (on the chart)</span>}
                                                {row.mark && (
                                                    <span className="sr-only">
                                                        {row.mark === 'closest' ? ' (closest)' : ' (too close to call)'}
                                                    </span>
                                                )}
                                            </span>
                                            <span className="whitespace-nowrap text-right text-slate-200">
                                                {row.tone === null ? (
                                                    <span aria-hidden="true">{row.forecast}</span>
                                                ) : (
                                                    row.forecast
                                                )}
                                            </span>
                                            <span
                                                className={`whitespace-nowrap text-right font-bold ${row.tone ? TONE_CLASS[row.tone] : 'text-slate-400'}`}
                                            >
                                                <span aria-hidden="true">{row.gap}</span>
                                                <span className="sr-only">{row.gapLong}</span>
                                            </span>
                                        </li>
                                    ))}
                                </ol>
                            )}
                            {showRows && view.notes.length > 0 && (
                                <div className="mt-2 space-y-1 text-xs leading-4 text-slate-400">
                                    {view.notes.map((note) => (
                                        <p key={note}>{note}</p>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </div>
                {showRows && view.credit && (
                    <div
                        data-model-check-footer
                        className="shrink-0 border-t border-white/10 px-4 py-2 text-xs leading-4 text-slate-400"
                    >
                        <p>{view.credit}</p>
                    </div>
                )}
            </div>
        </OverlayPortal>
    );
}

export interface ModelCheckAtBoatProps {
    onClose: () => void;
    speedUnit?: string;
    /** The chart's wind model (WindStore id), flagged in the rows. */
    chartModel?: string;
}

/** The container: re-reads her wind while open and renders the card. */
export function ModelCheckAtBoat({ onClose, speedUnit, chartModel }: ModelCheckAtBoatProps) {
    const lengthUnit = useSettingsStore((state) => state.settings?.units?.length);
    const airDraftFt = useSettingsStore((state) => state.settings?.vessel?.airDraft);
    const [check, setCheck] = useState<{ assessment: HerAssessment; follow: WeatherFollowTarget } | null>(null);
    const [session, setSession] = useState<HerSession>(EMPTY_SESSION);
    const [series, setSeries] = useState<ModelSeriesState | null>(null);
    const [details, setDetails] = useState(false);

    useEffect(() => {
        let mounted = true;
        /** Where her latest passing reading was; null while a refusal stands. */
        let latest: { lat: number; lon: number } | null = null;
        const step = () => {
            if (!mounted) return;
            const now = Date.now();
            const input = gatherHerWindInput(now);
            const assessment = assessHerWind(input, now);
            setCheck({ assessment, follow: input.follow });
            setSession((prev) =>
                assessment.ok ? addHerReading(prev, assessment.reading, input.followKey, now) : EMPTY_SESSION,
            );
            // No request while a refusal stands.
            latest = assessment.ok ? { lat: assessment.reading.lat, lon: assessment.reading.lon } : null;
            if (!assessment.ok) return;
            const { lat, lon } = assessment.reading;
            const held = peekModelsAtHer(lat, lon, now);
            setSeries(held ?? { state: 'loading' });
            if (held) return;
            void loadModelsAtHer(lat, lon, now).then((result) => {
                // A reply for where she was when it was asked: dropped if the follow
                // has moved on since (the cache keeps it for when she is back there).
                if (!mounted || !latest || haversineNM(lat, lon, latest.lat, latest.lon) > SERIES_REUSE_NM) return;
                setSeries(result);
            });
        };
        const lookUp = () => {
            void lookUpFollowedBoatCloudRow()
                .catch(() => {
                    /* the next re-check asks again */
                })
                .then(step);
        };
        step();
        lookUp();
        const recheck = window.setInterval(step, RECHECK_MS);
        const cloud = window.setInterval(lookUp, CLOUD_LOOKUP_MS);
        window.addEventListener(WEATHER_FOLLOW_TARGET_EVENT, step);
        return () => {
            mounted = false;
            window.clearInterval(recheck);
            window.clearInterval(cloud);
            window.removeEventListener(WEATHER_FOLLOW_TARGET_EVENT, step);
        };
    }, []);

    const view = buildModelCheckView({
        assessment: check?.assessment ?? null,
        session,
        series,
        follow: check?.follow ?? 'phone',
        speedUnit,
        lengthUnit,
        airDraftFt,
        chartModel,
    });
    return (
        <ModelCheckCard
            view={view}
            details={details}
            onToggleDetails={() => setDetails((open) => !open)}
            onClose={onClose}
            speedUnit={speedUnit}
        />
    );
}
