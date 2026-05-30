/**
 * SettingsRestoredModal — Welcome-back celebration.
 *
 * Listens for the `thalassa:settings-restored-modal` CustomEvent
 * fired by settingsStore.pullFromCloud on a fresh-device cloud
 * restore (reinstall + sign-in, or first sign-in on a new device).
 *
 * Shows the user a branded modal confirming WHICH preferences came
 * back — vessel, units, home port, tier, notifications, saved
 * locations — so the "restored from cloud" moment is visible, not
 * silent. Fires at most once per user per device (the dispatcher
 * gates on a Preferences flag).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { t } from '../theme';
import { CheckIcon, XIcon, AnchorIcon, GaugeIcon, MapPinIcon, BellIcon, StarIcon, LifeBuoyIcon } from './Icons';
import { useFocusTrap } from '../hooks/useAccessibility';
import type { RestoredSummary } from '../stores/settingsStore';
import brandLockup from '../assets/brand/mark-simplified-dark.svg';
import { TIER_INFO } from '../services/SubscriptionService';
import type { SubscriptionTier } from '../types/settings';

/** Tier code → friendly label (matches UpgradeModal language) */
function tierLabel(tier: string): string {
    const known = TIER_INFO[tier as SubscriptionTier];
    return known?.label ?? tier;
}

function unitsLabel(flavour: RestoredSummary['unitsFlavour']): string {
    switch (flavour) {
        case 'metric':
            return 'Metric units';
        case 'imperial':
            return 'Imperial units';
        case 'mixed':
            return 'Custom unit mix';
    }
}

type Row = {
    icon: React.ReactNode;
    primary: string;
    secondary?: string;
};

function buildRows(summary: RestoredSummary): Row[] {
    const rows: Row[] = [];

    if (summary.vesselName) {
        rows.push({
            icon: <AnchorIcon className="w-4 h-4 text-teal-300" />,
            primary: summary.vesselName,
            secondary: summary.vesselDescriptor ?? undefined,
        });
    }

    rows.push({
        icon: <GaugeIcon className="w-4 h-4 text-teal-300" />,
        primary: unitsLabel(summary.unitsFlavour),
    });

    if (summary.defaultLocation) {
        rows.push({
            icon: <MapPinIcon className="w-4 h-4 text-teal-300" />,
            primary: 'Home port',
            secondary: summary.defaultLocation,
        });
    }

    if (summary.savedLocationCount > 0) {
        const noun = summary.savedLocationCount === 1 ? 'saved place' : 'saved places';
        rows.push({
            icon: <StarIcon className="w-4 h-4 text-teal-300" />,
            primary: `${summary.savedLocationCount} ${noun}`,
        });
    }

    if (summary.armedNotifications > 0) {
        const noun = summary.armedNotifications === 1 ? 'alert armed' : 'alerts armed';
        rows.push({
            icon: <BellIcon className="w-4 h-4 text-teal-300" />,
            primary: `${summary.armedNotifications} ${noun}`,
        });
    }

    rows.push({
        icon: <LifeBuoyIcon className="w-4 h-4 text-teal-300" />,
        primary: tierLabel(summary.subscriptionTier),
        secondary: 'Subscription restored',
    });

    return rows;
}

export const SettingsRestoredModal: React.FC = () => {
    const [summary, setSummary] = useState<RestoredSummary | null>(null);
    const focusTrapRef = useFocusTrap(summary !== null);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ summary: RestoredSummary }>).detail;
            if (detail?.summary) {
                setSummary(detail.summary);
            }
        };
        window.addEventListener('thalassa:settings-restored-modal', handler);
        return () => window.removeEventListener('thalassa:settings-restored-modal', handler);
    }, []);

    const onClose = useCallback(() => setSummary(null), []);

    if (!summary) return null;

    const greeting = summary.greetingName ? `Welcome back, ${summary.greetingName}` : 'Welcome back';
    const rows = buildRows(summary);

    return (
        <div
            className="fixed inset-0 z-[1300] flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-restored-title"
            aria-describedby="settings-restored-desc"
            ref={focusTrapRef}
        >
            <div className="absolute inset-0 bg-black/90 transition-opacity" role="presentation" onClick={onClose} />

            <div
                className={`modal-panel-enter relative bg-slate-900 w-full max-w-md rounded-2xl overflow-hidden ${t.border.default} shadow-2xl flex flex-col max-h-[90vh]`}
            >
                {/* Header — same compass + radial teal glow language
                    as UpgradeModal so the brand voice stays unified
                    across "conversion moments". */}
                <div className="relative h-32 bg-slate-900 flex items-center justify-center overflow-hidden border-b border-white/5">
                    <div
                        className="absolute inset-0 pointer-events-none"
                        style={{
                            background: 'radial-gradient(ellipse at top, rgba(94, 234, 212, 0.10), transparent 60%)',
                        }}
                    />
                    <div className="relative z-10 text-center px-6">
                        <img
                            src={brandLockup}
                            alt=""
                            className="w-12 h-12 mx-auto mb-2"
                            draggable={false}
                            style={{ filter: 'drop-shadow(0 0 12px rgba(94, 234, 212, 0.25))' }}
                        />
                        <h2 id="settings-restored-title" className="text-xl font-bold text-white tracking-tight">
                            {greeting}
                        </h2>
                        <p id="settings-restored-desc" className="text-[11px] text-slate-400 mt-0.5">
                            Your settings just synced from the cloud
                        </p>
                    </div>

                    <button
                        onClick={onClose}
                        className="absolute top-4 right-4 p-2 bg-black/20 hover:bg-black/40 rounded-full text-white/70 hover:text-white transition-colors z-20"
                        aria-label="Close dialog"
                    >
                        <XIcon className="w-5 h-5" />
                    </button>
                </div>

                {/* Restored-fields list */}
                <div className="p-5 overflow-y-auto custom-scrollbar">
                    <p className="text-[12px] text-slate-400 mb-3 uppercase tracking-wider font-medium">
                        What came back
                    </p>
                    <ul className="space-y-2">
                        {rows.map((row, idx) => (
                            <li
                                key={idx}
                                className="flex items-start gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/5"
                            >
                                <div className="mt-0.5 flex-shrink-0 w-6 h-6 rounded-full bg-teal-500/10 border border-teal-400/20 flex items-center justify-center">
                                    {row.icon}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-semibold text-white truncate">{row.primary}</p>
                                    {row.secondary && (
                                        <p className="text-[11px] text-slate-400 truncate">{row.secondary}</p>
                                    )}
                                </div>
                                <CheckIcon className="w-4 h-4 text-teal-300 mt-1.5 flex-shrink-0" />
                            </li>
                        ))}
                    </ul>

                    <p className="text-center text-[11px] text-slate-500 mt-4">
                        Changes you make on this device will keep syncing automatically.
                    </p>
                </div>

                {/* CTA — sky-500 to match UpgradeModal's "primary
                    action" language. Teal lives in iconography and
                    decoration only. */}
                <div className="p-5 pt-2 border-t border-white/5 bg-slate-900">
                    <button
                        onClick={onClose}
                        aria-label="Dismiss welcome-back dialog"
                        className="w-full py-3.5 rounded-xl font-bold shadow-lg transition-all active:scale-[0.98] flex items-center justify-center gap-2 text-white bg-sky-500 hover:bg-sky-400"
                        style={{ boxShadow: '0 8px 24px -8px rgba(14, 165, 233, 0.6)' }}
                    >
                        Welcome aboard
                    </button>
                </div>
            </div>
        </div>
    );
};
