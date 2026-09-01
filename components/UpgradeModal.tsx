import React from 'react';
import { XIcon, CheckIcon } from './Icons';
import { useFocusTrap } from '../hooks/useAccessibility';
import { PUBLIC_BETA_ACCESS } from '../services/SubscriptionService';
import { OverlayPortal } from './ui/OverlayPortal';

interface UpgradeModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const BETA_BENEFITS = [
    'Passage planning, routing and voyage tools',
    'Weather, charts, ship log and vessel workflows',
    'Calypso, Galley, Diary and community features',
] as const;

/**
 * Historical callers still open an "upgrade" surface. During public beta this
 * is deliberately an access-status dialog, not a price sheet or disabled
 * purchase funnel. The entitlement services remain in place for a later store
 * release, while this shipped UI makes the current free state unambiguous.
 */
export const UpgradeModal: React.FC<UpgradeModalProps> = ({ isOpen, onClose }) => {
    const focusTrapRef = useFocusTrap(isOpen, { onEscape: onClose });
    if (!isOpen) return null;

    return (
        <OverlayPortal
            className="flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="beta-access-title"
            ref={focusTrapRef}
        >
            <div className="absolute inset-0 bg-black/90" role="presentation" onClick={onClose} />
            <div className="modal-panel-enter relative flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900 shadow-2xl">
                <div className="relative border-b border-white/5 px-6 pb-5 pt-7 text-center">
                    <div
                        className="absolute inset-0 pointer-events-none"
                        style={{ background: 'radial-gradient(ellipse at top, rgba(94,234,212,.12), transparent 65%)' }}
                    />
                    <img
                        src="/thalassa-icon-128.png"
                        alt=""
                        className="relative mx-auto mb-3 h-14 w-14"
                        draggable={false}
                    />
                    <span className="relative inline-flex rounded-full border border-teal-300/30 bg-teal-300/10 px-3 py-1 text-[11px] font-black tracking-widest text-teal-200">
                        {PUBLIC_BETA_ACCESS.badge}
                    </span>
                    <h2 id="beta-access-title" className="relative mt-3 text-2xl font-black tracking-tight text-white">
                        {PUBLIC_BETA_ACCESS.label}
                    </h2>
                    <p role="status" className="relative mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-300">
                        {PUBLIC_BETA_ACCESS.message}
                    </p>
                    <button
                        type="button"
                        onClick={onClose}
                        className="absolute right-4 top-4 rounded-full bg-black/20 p-2 text-white/70 hover:bg-black/40 hover:text-white"
                        aria-label="Close public beta access dialog"
                    >
                        <XIcon className="h-5 w-5" />
                    </button>
                </div>

                <div className="space-y-4 p-5">
                    <div className="space-y-2 rounded-2xl border border-white/[0.07] bg-white/3 p-4">
                        {BETA_BENEFITS.map((benefit) => (
                            <div key={benefit} className="flex items-start gap-2.5 text-sm text-slate-200">
                                <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-teal-300" />
                                <span>{benefit}</span>
                            </div>
                        ))}
                    </div>
                    <p className="text-center text-xs leading-relaxed text-slate-400">
                        There is no subscription price, purchase button or trial countdown in this beta. We will explain
                        any future plans before access changes.
                    </p>
                    <button
                        type="button"
                        onClick={onClose}
                        className="w-full rounded-xl bg-sky-500 py-3.5 text-sm font-black text-white shadow-lg shadow-sky-500/20 transition-colors hover:bg-sky-400"
                    >
                        Continue Exploring
                    </button>
                </div>
            </div>
        </OverlayPortal>
    );
};
