import React, { useState } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('WarningDetails');
import { AlertTriangleIcon, ChevronLeftIcon } from './Icons';
import { useUI } from '../context/UIContext';

interface WarningDetailsProps {
    alerts: string[];
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

export const WarningDetails: React.FC<WarningDetailsProps> = ({ alerts }) => {
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
        <div className="flex flex-col h-full bg-slate-900 text-white animate-in fade-in slide-in-from-right-4 duration-300">
            {/* Header */}
            <div className="flex items-center gap-2 p-4 pt-[max(1rem,env(safe-area-inset-top))] bg-slate-900 border-b border-white/10 shrink-0">
                <button
                    aria-label="Page"
                    onClick={() => setPage('dashboard')}
                    className="p-2 -ml-2 rounded-full hover:bg-white/10 active:bg-white/20 transition-colors"
                >
                    <ChevronLeftIcon className="w-6 h-6 text-sky-400" />
                </button>
                <div className="flex items-center gap-2 flex-1">
                    <AlertTriangleIcon className="w-5 h-5 text-red-500" />
                    <h2 className="text-lg font-bold uppercase tracking-wider">Active Warnings</h2>
                </div>
                {dismissableCount > 1 && (
                    <button
                        aria-label="All"
                        onClick={dismissAll}
                        className="bg-white/10 hover:bg-white/20 active:bg-white/30 text-white/80 font-bold text-xs px-3 py-1.5 rounded-lg transition-colors uppercase tracking-wider"
                    >
                        Dismiss All
                    </button>
                )}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
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
                                                {isCritical(alert) ? '⚠️ Critical' : 'Advisory'}
                                            </span>
                                        </div>
                                        <p className="text-lg font-medium text-red-100 leading-relaxed">{alert}</p>
                                    </div>
                                    {!isCritical(alert) && (
                                        <button aria-label="Close"
                                            onClick={() => dismiss(alert)}
                                            className="shrink-0 bg-white/10 hover:bg-white/20 active:bg-white/30 text-white/70 font-bold text-xs px-3 py-2 rounded-xl transition-colors uppercase tracking-wider mt-1"
                                        >
                                            Dismiss
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))
                ) : (
                    <div className="flex flex-col items-center justify-center h-full opacity-50 pb-20">
                        <div className="bg-white/5 p-6 rounded-full mb-4">
                            <AlertTriangleIcon className="w-12 h-12 text-gray-400" />
                        </div>
                        <p className="text-gray-400 font-medium">No active warnings.</p>
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
