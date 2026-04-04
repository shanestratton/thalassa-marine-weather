import React, { useState } from 'react';
import { t } from '../theme';
import { XIcon, DiamondIcon, CheckIcon, LockIcon } from './Icons';
import { useFocusTrap } from '../hooks/useAccessibility';
import { TIER_INFO, type Feature as _Feature } from '../services/SubscriptionService';
import type { SubscriptionTier } from '../types/settings';

interface UpgradeModalProps {
    isOpen: boolean;
    onClose: () => void;
    onUpgrade: (tier?: SubscriptionTier) => void;
}

/** Features to highlight per tier */
const FIRST_MATE_FEATURES: { label: string; feature: string }[] = [
    { label: 'Full 10-Day Forecast', feature: 'weatherFull' },
    { label: 'GPS Track Logging', feature: 'gpsTracking' },
    { label: 'Crew Talk Messaging', feature: 'crewTalkWrite' },
    { label: 'Direct Messages & Pin Drop', feature: 'directMessages' },
    { label: "Skipper's AI Advice", feature: 'aiAdvice' },
    { label: 'Anchor Watch', feature: 'anchorWatch' },
    { label: 'Chandlery Posting', feature: 'chandleryPost' },
    { label: 'Community Track Downloads', feature: 'communityDownload' },
];

const SKIPPER_FEATURES: { label: string; feature: string }[] = [
    { label: 'Everything in First Mate, plus:', feature: '_header' },
    { label: 'Route Planner & Passage Planning', feature: 'routePlanner' },
    { label: 'Passage Legs (Multi-Stop)', feature: 'passageLegs' },
    { label: "Ship's Log & Logbook", feature: 'shipLog' },
    { label: 'Vessel Profile & Management', feature: 'vesselProfile' },
    { label: 'Cast Off / Voyage Control', feature: 'castOff' },
    { label: 'Galley & Meal Planning', feature: 'galley' },
    { label: 'Crew Finder (as Skipper)', feature: 'crewFinderCaptain' },
    { label: 'Polar Diagrams & Smart Polars', feature: 'polars' },
    { label: 'Community Track Sharing', feature: 'communityShare' },
];

const PlanCard: React.FC<{
    tier: SubscriptionTier;
    features: { label: string; feature: string }[];
    selected: boolean;
    onSelect: () => void;
    recommended?: boolean;
}> = ({ tier, features, selected, onSelect, recommended }) => {
    const info = TIER_INFO[tier];
    const isSkipper = tier === 'owner';

    return (
        <button
            onClick={onSelect}
            className={`relative w-full text-left p-4 rounded-2xl border-2 transition-all active:scale-[0.98] ${
                selected
                    ? isSkipper
                        ? 'border-amber-500/60 bg-amber-500/[0.06]'
                        : 'border-cyan-500/60 bg-cyan-500/[0.06]'
                    : 'border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]'
            }`}
        >
            {recommended && (
                <div
                    className="absolute -top-2.5 left-4 px-2.5 py-0.5 rounded-full text-[11px] font-black uppercase tracking-widest"
                    style={{ background: info.color, color: '#000' }}
                >
                    Best Value
                </div>
            )}

            {/* Tier header */}
            <div className="flex items-center justify-between mb-3 mt-1">
                <div>
                    <h3 className="text-base font-black text-white">{info.label}</h3>
                    <p className="text-[11px] text-gray-500 mt-0.5">{info.badge} Plan</p>
                </div>
                <div className="text-right">
                    <p className="text-xl font-black text-white">${info.priceAnnual.toFixed(2)}</p>
                    <p className="text-[11px] text-gray-500">/year</p>
                </div>
            </div>

            {/* Feature list */}
            <div className="space-y-1.5">
                {features.map((f, i) =>
                    f.feature === '_header' ? (
                        <p key={i} className="text-[11px] font-bold text-amber-400/70 uppercase tracking-widest pt-1">
                            {f.label}
                        </p>
                    ) : (
                        <div key={i} className="flex items-center gap-2">
                            <span style={{ color: info.color }}>
                                <CheckIcon className="w-3 h-3 shrink-0" />
                            </span>
                            <span className="text-[11px] text-gray-300">{f.label}</span>
                        </div>
                    ),
                )}
            </div>

            {/* Selection indicator */}
            <div className="flex items-center justify-center mt-4">
                <div
                    className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
                        selected
                            ? isSkipper
                                ? 'bg-amber-500 border-amber-500'
                                : 'bg-cyan-500 border-cyan-500'
                            : 'border-gray-600'
                    }`}
                >
                    {selected && (
                        <svg
                            className="w-3 h-3 text-black"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={3}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                    )}
                </div>
            </div>
        </button>
    );
};

export const UpgradeModal: React.FC<UpgradeModalProps> = ({ isOpen, onClose, onUpgrade }) => {
    const focusTrapRef = useFocusTrap(isOpen);
    const [selectedTier, setSelectedTier] = useState<SubscriptionTier>('owner');

    if (!isOpen) return null;

    const selectedInfo = TIER_INFO[selectedTier];

    return (
        <div
            className="fixed inset-0 z-[1200] flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="upgrade-title"
            ref={focusTrapRef}
        >
            <div className="absolute inset-0 bg-black/90 transition-opacity" onClick={onClose} />

            <div
                className={`modal-panel-enter relative bg-slate-900 w-full max-w-lg rounded-2xl overflow-hidden ${t.border.default} shadow-2xl flex flex-col max-h-[90vh]`}
            >
                {/* Header */}
                <div className="relative h-32 bg-gradient-to-br from-sky-900 via-slate-900 to-amber-900/30 flex items-center justify-center overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-t from-[#0f172a] to-transparent" />
                    <div className="relative z-10 text-center">
                        <div className="w-14 h-14 mx-auto bg-gradient-to-br from-amber-500 to-sky-500 rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(245,158,11,0.3)] mb-2">
                            <DiamondIcon className="w-7 h-7 text-white" />
                        </div>
                        <h2 id="upgrade-title" className="text-xl font-bold text-white tracking-tight">
                            Upgrade Thalassa
                        </h2>
                        <p className="text-[11px] text-gray-400 mt-0.5">Annual subscription • Cancel anytime</p>
                    </div>

                    <button
                        onClick={onClose}
                        className="absolute top-4 right-4 p-2 bg-black/20 hover:bg-black/40 rounded-full text-white/70 hover:text-white transition-colors z-20"
                        aria-label="Close dialog"
                    >
                        <XIcon className="w-5 h-5" />
                    </button>
                </div>

                {/* Plan selection */}
                <div className="p-4 overflow-y-auto custom-scrollbar space-y-3">
                    <PlanCard
                        tier="owner"
                        features={SKIPPER_FEATURES}
                        selected={selectedTier === 'owner'}
                        onSelect={() => setSelectedTier('owner')}
                        recommended
                    />
                    <PlanCard
                        tier="crew"
                        features={FIRST_MATE_FEATURES}
                        selected={selectedTier === 'crew'}
                        onSelect={() => setSelectedTier('crew')}
                    />

                    {/* Free tier note */}
                    <div className="text-center py-2">
                        <p className="text-[11px] text-gray-500">
                            Deckhand (Free) includes basic 3-day weather, map, and Chandlery browsing.
                        </p>
                    </div>

                    {/* CTA */}
                    <button
                        aria-label="Upgrade subscription"
                        onClick={() => {
                            onUpgrade(selectedTier);
                            onClose();
                        }}
                        className="w-full py-4 rounded-xl font-bold shadow-lg transition-all active:scale-95 flex items-center justify-center gap-2"
                        style={{
                            background: `linear-gradient(135deg, ${selectedInfo.color}, ${selectedTier === 'owner' ? '#f97316' : '#06b6d4'})`,
                            color: '#000',
                        }}
                    >
                        <LockIcon className="w-5 h-5" />
                        Start 7-Day Free Trial — {selectedInfo.label}
                    </button>

                    <p className="text-center text-[11px] text-gray-500 pb-1">
                        ${selectedInfo.priceAnnual.toFixed(2)}/year after trial • {selectedInfo.priceMonthly}/month
                    </p>

                    <button
                        aria-label="Restore purchases"
                        className="w-full py-2 text-sm text-gray-400 hover:text-white transition-colors"
                    >
                        Restore Purchases
                    </button>
                </div>
            </div>
        </div>
    );
};
