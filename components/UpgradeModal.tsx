import React, { useState } from 'react';
import { t } from '../theme';
import { XIcon, CheckIcon } from './Icons';
import { useFocusTrap } from '../hooks/useAccessibility';
import { TIER_INFO, type Feature as _Feature } from '../services/SubscriptionService';
import type { SubscriptionTier } from '../types/settings';
// Brand mark — same lockup as the SignInScreen. Vite resolves the
// import to a hashed URL string at build time. Replaces the previous
// DiamondIcon header treatment (the "jewelry-store / Vegas" vibe the
// 64/100 scorecard flagged as the biggest brand-cohesion hit).
import brandLockup from '../assets/brand/mark-simplified-dark.svg';

/** Format an annual price tightly: whole-dollar prices skip the .00
 *  (so $149 not $149.00), prices with cents keep two decimals
 *  ($49.95 stays as $49.95). */
function fmtPrice(annual: number): string {
    return annual % 1 === 0 ? `$${annual}` : `$${annual.toFixed(2)}`;
}

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
    // Removed "Chandlery Posting" from this list — it's gated 'free'
    // in FEATURE_GATES (Chandlery B-pivot, WD #11), so advertising
    // it as a First Mate benefit is misleading. Posting to the
    // Chandlery is available to every tier.
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
    // Removed "Crew Finder (as Skipper)" — crewFinderCaptain is
    // now 'free' (WD #11 network-effect parity with the Chandlery
    // B-pivot) and was never enforced in code anyway.
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
                    <p className="text-xl font-black text-white">{fmtPrice(info.priceAnnual)}</p>
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
            <div className="absolute inset-0 bg-black/90 transition-opacity" role="presentation" onClick={onClose} />

            <div
                className={`modal-panel-enter relative bg-slate-900 w-full max-w-lg rounded-2xl overflow-hidden ${t.border.default} shadow-2xl flex flex-col max-h-[90vh]`}
            >
                {/* Header — rebuilt 2026-05-17. Before: gradient
                    sky-900 → slate-900 → amber-900 + a Diamond-icon
                    badge in amber/sky on a glow ring. Read as a
                    casino-app "premium" upsell. Now: clean slate
                    backdrop + the actual Thalassa compass mark + a
                    subtle teal glow. Same brand language as the
                    sign-in screen so the conversion moment feels
                    like part of the app, not a vendor-pitch interlude. */}
                <div className="relative h-32 bg-slate-900 flex items-center justify-center overflow-hidden border-b border-white/5">
                    <div
                        className="absolute inset-0 pointer-events-none"
                        style={{
                            background: 'radial-gradient(ellipse at top, rgba(94, 234, 212, 0.10), transparent 60%)',
                        }}
                    />
                    <div className="relative z-10 text-center">
                        <img
                            src={brandLockup}
                            alt=""
                            className="w-12 h-12 mx-auto mb-2"
                            draggable={false}
                            style={{ filter: 'drop-shadow(0 0 12px rgba(94, 234, 212, 0.25))' }}
                        />
                        <h2 id="upgrade-title" className="text-xl font-bold text-white tracking-tight">
                            Upgrade Thalassa
                        </h2>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                            The marine platform sailors plan passages on — together
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

                    {/* Free tier note + competitive context */}
                    <div className="text-center py-2 space-y-1.5">
                        <p className="text-[11px] text-gray-500">
                            Deckhand (Free) includes basic 3-day weather, map, and Chandlery browsing.
                        </p>
                        <p className="text-[10px] text-gray-600 italic">
                            Skipper is half the price of PredictWind ($228/yr) and competitive with Orca CORE ($129/yr)
                            — with crew-talk, marketplace, and AI passage diary none of them ship.
                        </p>
                    </div>

                    {/* CTA — rebuilt 2026-05-17. Was: amber/orange
                        gradient (for owner tier) or sky/cyan gradient
                        (for crew), with BLACK text on top + a Lock
                        icon. Two problems: (1) the lock icon implies
                        "you can't access this yet" which is exactly
                        the wrong vibe for a button labelled "Start
                        free trial", (2) black text on gradient
                        failed contrast on the darker tier-amber. New:
                        solid brand colour, white text, no icon. Lets
                        the LABEL do the work. */}
                    <button
                        aria-label={`Start 7-day free trial of ${selectedInfo.label}`}
                        onClick={() => {
                            onUpgrade(selectedTier);
                            onClose();
                        }}
                        className="w-full py-4 rounded-xl font-bold shadow-lg transition-all active:scale-[0.98] flex items-center justify-center gap-2 text-white"
                        style={{
                            backgroundColor: selectedInfo.color,
                            boxShadow: `0 8px 24px -8px ${selectedInfo.color}`,
                        }}
                    >
                        Start 7-Day Free Trial — {selectedInfo.label}
                    </button>

                    <p className="text-center text-[11px] text-slate-500 pb-1">
                        {fmtPrice(selectedInfo.priceAnnual)}/year after trial • {selectedInfo.priceMonthly}/month
                    </p>

                    {/* Restore Purchases — rebuilt as a proper styled
                        secondary button rather than an unstyled grey
                        text link (the 2014-era treatment the
                        scorecard flagged). Apple HIG requires this
                        to be findable for the App Store review pass. */}
                    <button
                        aria-label="Restore previous purchases from this Apple ID"
                        className="w-full py-2.5 rounded-xl text-sm font-semibold text-slate-300 hover:text-white bg-white/[0.03] hover:bg-white/[0.06] border border-white/10 transition-colors"
                    >
                        Restore Purchases
                    </button>
                </div>
            </div>
        </div>
    );
};
