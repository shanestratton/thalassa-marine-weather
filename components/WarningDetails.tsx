import React, { useEffect, useState } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('WarningDetails');
import { AlertTriangleIcon, CheckCircleIcon } from './Icons';
import { PageHeader } from './ui/PageHeader';
import { formatAge } from './ui/DataFreshness';
import { useUI } from '../context/UIContext';

interface WarningDetailsProps {
    alerts: string[];
    /** ISO time the weather report was generated — 'none issued' and 'not checked' must not look the same. */
    checkedAt?: string;
    /** The place the forecast was checked for, so the clear state says where. */
    placeName?: string;
}

// Critical warnings that CANNOT be dismissed (life/vessel safety)
const CRITICAL_PATTERNS = [
    'STORM WARNING',
    'GALE WARNING',
    'DANGEROUS SEAS',
    'FREEZING SPRAY',
    'FREEZE WARNING',
    'EXCESSIVE HEAT',
    'DENSE FOG',
    'STORM WATCH',
    'GALE WATCH',
];
const isCritical = (alert: string) => CRITICAL_PATTERNS.some((p) => alert.toUpperCase().includes(p));

export const WarningDetails: React.FC<WarningDetailsProps> = ({ alerts, checkedAt, placeName }) => {
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
                <PageHeader
                    title="Forecast Alerts"
                    subtitle={placeName || undefined}
                    onBack={() => setPage('dashboard')}
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
                            <button
                                aria-label="Dismiss all dismissable weather warnings"
                                onClick={dismissAll}
                                // 2026-05-17: bumped to min-h-[44px] to clear the
                                // Apple HIG tap-target floor (was py-1.5 ≈ 28 px).
                                // A "Dismiss All" button on a warnings page is
                                // exactly where you don't want mis-taps — could
                                // accidentally clear a critical alert in heavy
                                // weather. Aria-label rewritten to be specific.
                                className="bg-white/10 hover:bg-white/20 active:bg-white/30 text-white/80 font-bold text-xs px-3 py-2.5 min-h-[44px] rounded-lg transition-colors uppercase tracking-wider"
                            >
                                Dismiss All
                            </button>
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
                                                {isCritical(alert) ? 'Critical' : 'Advisory'}
                                            </span>
                                        </div>
                                        <p className="text-lg font-medium text-red-100 leading-relaxed">{alert}</p>
                                    </div>
                                    {!isCritical(alert) && (
                                        <button
                                            aria-label={`Dismiss warning: ${alert}`}
                                            onClick={() => dismiss(alert)}
                                            className="shrink-0 min-h-[44px] bg-white/10 hover:bg-white/20 active:bg-white/30 text-white/70 font-bold text-xs px-3 py-2 rounded-xl transition-colors uppercase tracking-wider mt-1"
                                        >
                                            Dismiss
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))
                ) : (
                    <div className="flex flex-col items-center justify-center h-full pb-20" role="status">
                        {/* A check, not the warning triangle: the clear state must not
                            wear the same glyph as the alarm. */}
                        <div className="bg-white/5 p-6 rounded-full mb-4">
                            <CheckCircleIcon className="w-12 h-12 text-emerald-400" />
                        </div>
                        {/* Not an all-clear: these are Thalassa's own forecast
                            thresholds, never the Bureau's warnings (UX scorecard run 6). */}
                        <p className="text-base font-semibold text-slate-200 text-center">
                            {placeName ? `No forecast alerts for ${placeName}` : 'No forecast alerts'}
                        </p>
                        <p className="mt-1 text-sm text-slate-400">
                            {checkedLabel ? `Forecast checked ${checkedLabel}` : 'Forecast not checked yet'}
                        </p>
                        <p className="mt-4 max-w-xs text-center text-sm leading-relaxed text-slate-400">
                            Thalassa checks the forecast for gale, storm, fog and heat thresholds. Not an official
                            warning service: check BoM marine warnings.
                        </p>
                        {dismissed.size > 0 && (
                            <p className="text-gray-400 text-sm mt-2">
                                {dismissed.size} warning{dismissed.size > 1 ? 's' : ''} dismissed this session
                            </p>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
