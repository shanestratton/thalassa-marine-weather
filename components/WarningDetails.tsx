import React, { useEffect, useMemo, useState } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('WarningDetails');
import { AlertTriangleIcon, CheckCircleIcon, ExternalLinkIcon } from './Icons';
import { Button } from './ui/Button';
import { PageHeader } from './ui/PageHeader';
import { formatAge } from './ui/DataFreshness';
import { useUI } from '../context/UIContext';
import { useThemeStore } from '../stores/themeStore';
import { touchTarget } from '../theme';
import { openExternalUrl } from '../services/externalLinks';
import { servedModelDisplayName } from '../services/weather/servedModelName';
import { forecastAlertRule, isCriticalForecastAlert as isCritical } from '../utils/forecastAlerts';
import { officialWarningsSource } from '../utils/officialWarningsSource';

interface WarningDetailsProps {
    alerts: string[];
    /** ISO time the weather report was generated — 'none issued' and 'not checked' must not look the same. */
    checkedAt?: string;
    /** The place the forecast was checked for, so the clear state says where. */
    placeName?: string;
    /** Where the forecast is for: picks the official warnings issuer to link. */
    coordinates?: { lat: number; lon: number };
    /** The report's own judgement of the position; 'offshore' links the METAREA warnings. */
    locationType?: string;
    /** The pipeline's model tag ('wx:ecmwf_ifs025', …), named on each card. */
    modelUsed?: string;
}

/**
 * The model one card may name, or null. The tag names whatever served the
 * Glass, which is not always what raised the alert, so a card names it only
 * where the tag can vouch for it:
 *   - a '+fallback:' blend carries the fallback report's alerts too
 *     (blendOffshoreForecast), and the Spitfire overlay rewrites the wind
 *     after the base report raised its alerts: no card names a model;
 *   - sea state comes from a wave model, never the atmospheric one named;
 *   - '+wk' borrows visibility and UV from WeatherKit;
 *   - a legacy text from a cached report has no rule to say what it reads.
 */
function cardModelName(alert: string, modelUsed: string | undefined): string | null {
    const name = servedModelDisplayName(modelUsed);
    if (!name || !modelUsed) return null;
    if (modelUsed.includes('+fallback:') || /\bspitfire\b/i.test(modelUsed)) return null;
    const rule = forecastAlertRule(alert);
    if (!rule || rule.reads === 'sea') return null;
    if ((rule.reads === 'visibility' || rule.reads === 'uv') && /(?:^|\+)wk(?:\+|$)/.test(modelUsed)) return null;
    return name;
}

const sourceLine = (modelName: string | null): string =>
    `Thalassa forecast check · ${modelName ? `${modelName} · ` : ''}not an official warning`;

export const WarningDetails: React.FC<WarningDetailsProps> = ({
    alerts,
    checkedAt,
    placeName,
    coordinates,
    locationType,
    modelUsed,
}) => {
    // These are Thalassa's own model checks, never official warnings (build
    // 123, W1-02). Each card says so, and the onward link goes to the
    // official issuer for this position anywhere in the world: it used to
    // send every boat, one in the Med included, to the Bureau of Meteorology.
    const source = useMemo(
        () => officialWarningsSource(coordinates?.lat, coordinates?.lon, { offshore: locationType === 'offshore' }),
        [coordinates?.lat, coordinates?.lon, locationType],
    );
    // Age, not clock time: 'checked at 08:01' read as this morning after a
    // night with the app closed. Re-rendered each minute so it stays honest.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!checkedAt) return;
        const id = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(id);
    }, [checkedAt]);
    const checkedLabel = (() => {
        if (!checkedAt) return null;
        const d = new Date(checkedAt);
        if (Number.isNaN(d.getTime())) return null;
        return formatAge(Math.max(0, now - d.getTime()));
    })();
    const { setPage } = useUI();
    const buttonTheme = useThemeStore((s) => s.theme.button);
    const [dismissed, setDismissed] = useState<Set<string>>(() => {
        try {
            const stored = sessionStorage.getItem('thalassa_dismissed_alerts');
            return stored ? new Set(JSON.parse(stored)) : new Set();
        } catch (e) {
            log.warn(e);
            return new Set();
        }
    });

    const dismiss = (alert: string) => {
        const newDismissed = new Set([...dismissed, alert]);
        setDismissed(newDismissed);
        try {
            sessionStorage.setItem('thalassa_dismissed_alerts', JSON.stringify([...newDismissed]));
        } catch (e) {
            log.warn(' non-critical:', e);
        }
    };

    const dismissAll = () => {
        const toDismiss = alerts.filter((a) => !isCritical(a));
        const newDismissed = new Set([...dismissed, ...toDismiss]);
        setDismissed(newDismissed);
        try {
            sessionStorage.setItem('thalassa_dismissed_alerts', JSON.stringify([...newDismissed]));
        } catch (e) {
            log.warn(' non-critical:', e);
        }
    };

    const activeAlerts = alerts.filter((a) => isCritical(a) || !dismissed.has(a));
    const dismissableCount = activeAlerts.filter((a) => !isCritical(a)).length;

    return (
        <div className="flex flex-col h-full bg-slate-950 text-white animate-in fade-in slide-in-from-right-4 duration-300">
            {/* Header — the shared PageHeader (h1 + back), the same chrome as
                every other sub-page. While anything is active a red count pill
                sits under the title; once the list is clear there is no
                triangle at all (a lone triangle sat where icon buttons sit). */}
            <div className="shrink-0 bg-slate-950">
                {/* Back always goes to The Glass, so the page says so: a THE
                    GLASS crumb and a 'Back to The Glass' chevron, like its
                    siblings, instead of a bare 'Go back' (UX scorecard run 9). */}
                <PageHeader
                    title="Forecast alerts"
                    subtitle={placeName || undefined}
                    onBack={() => setPage('dashboard')}
                    breadcrumbs={['The Glass', 'Forecast alerts']}
                    status={
                        activeAlerts.length > 0 ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 text-label font-black">
                                <AlertTriangleIcon className="w-3.5 h-3.5" />
                                {activeAlerts.length} active
                            </span>
                        ) : undefined
                    }
                    action={
                        dismissableCount > 1 ? (
                            // The house secondary button (ui/Button: 44 pt floor,
                            // one shape; UX scorecard run 9). A "Dismiss all" on a
                            // warnings page is exactly where you don't want
                            // mis-taps, so the name says what it clears.
                            <Button
                                variant="secondary"
                                aria-label="Dismiss all dismissable forecast alerts"
                                onClick={dismissAll}
                                className="shrink-0 text-white"
                            >
                                Dismiss all
                            </Button>
                        ) : undefined
                    }
                />
            </div>

            {/* Content */}
            <div className="thalassa-scroll-fade thalassa-scroll-fade--nav flex-1 overflow-y-auto p-4 pb-[calc(var(--thalassa-tabbar-height)+16px)] space-y-4">
                {activeAlerts && activeAlerts.length > 0 ? (
                    activeAlerts.map((alert, _index) => (
                        <div
                            key={alert}
                            className="bg-red-500/10 border border-red-500/20 rounded-2xl p-5 shadow-lg relative overflow-hidden animate-in fade-in slide-in-from-top-2"
                        >
                            <div className="absolute top-0 right-0 p-3 opacity-10">
                                <AlertTriangleIcon className="w-24 h-24 text-red-500" />
                            </div>
                            <div className="relative z-10">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex-1">
                                        <div className="flex items-center gap-2 mb-3">
                                            <span
                                                className={`inline-block text-white text-sm font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                                                    isCritical(alert) ? 'bg-red-600' : 'bg-amber-500'
                                                }`}
                                            >
                                                {/* 'Caution', not 'Advisory': an advisory is a
                                                    weather service's product (W1-02). */}
                                                {isCritical(alert) ? 'Critical' : 'Caution'}
                                            </span>
                                        </div>
                                        <p className="text-lg font-medium text-red-100 leading-relaxed">{alert}</p>
                                        <p className="mt-2 text-sm text-slate-300">
                                            {sourceLine(cardModelName(alert, modelUsed))}
                                        </p>
                                    </div>
                                    {!isCritical(alert) && (
                                        <Button
                                            variant="secondary"
                                            aria-label={`Dismiss forecast alert: ${alert}`}
                                            onClick={() => dismiss(alert)}
                                            className="mt-1 shrink-0 text-white"
                                        >
                                            Dismiss
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))
                ) : (
                    <div className="flex flex-col items-center justify-center h-full pb-20">
                        {/* The status region holds the state sentences only; the link
                            below stays outside it, as controls do. */}
                        <div role="status" className="flex flex-col items-center">
                            {/* A check, not the warning triangle: the clear state must not
                                wear the same glyph as the alarm. */}
                            <div aria-hidden="true" className="bg-white/5 p-6 rounded-full mb-4">
                                <CheckCircleIcon className="w-12 h-12 text-emerald-400" />
                            </div>
                            {/* Not an all-clear: these are Thalassa's own forecast
                                thresholds, never official warnings (UX scorecard run 6).
                                An h2, so heading navigation reaches the page's answer. */}
                            <h2 className="text-base font-semibold text-slate-200 text-center text-balance">
                                {placeName ? `No forecast alerts for ${placeName}` : 'No forecast alerts'}
                            </h2>
                            <p className="mt-1 text-sm text-slate-400">
                                {checkedLabel ? `Forecast checked ${checkedLabel}` : 'Forecast not checked yet'}
                            </p>
                            {/* Four lines read left-aligned in the centred column,
                                as Guardian's gate does on the same card recipe; the
                                heading and the link stay centred (UX scorecard run 9). */}
                            <p className="mt-4 max-w-xs text-left text-sm leading-relaxed text-slate-400">
                                Thalassa checks the forecast for gale, storm, fog and heat thresholds. It is not an
                                official warning service, so check {source.checkPhrase} too.
                            </p>
                            {dismissed.size > 0 && (
                                <p className="text-gray-400 text-sm mt-2">
                                    {dismissed.size} alert{dismissed.size > 1 ? 's' : ''} dismissed this session
                                </p>
                            )}
                        </div>
                        {/* The one onward step goes somewhere (UX scorecard run 7): a real
                            link, opened over the app like every other external page, to
                            the official issuer for this position (W1-02). */}
                        <a
                            href={source.url}
                            onClick={(e) => {
                                e.preventDefault();
                                void openExternalUrl(source.url);
                            }}
                            className={`${buttonTheme.secondary} ${touchTarget.button} mt-4 text-sky-300`}
                        >
                            Open {source.shortName} warnings
                            <span className="sr-only"> ({source.name} website)</span>
                            <ExternalLinkIcon className="h-4 w-4 shrink-0" />
                        </a>
                    </div>
                )}
            </div>
        </div>
    );
};
