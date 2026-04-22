/**
 * PaywallGate — Conditional render guard for gated features.
 *
 * If the current user can access `feature`, renders `children`.
 * Otherwise renders a full-screen upsell card with a CTA that opens
 * the existing UpgradeModal (via the `onUpgrade` callback).
 *
 * This is the runtime enforcement of the SubscriptionService gates.
 * The upgrade flow itself stays in App.tsx — PaywallGate just decides
 * "render the page" vs "render the upsell".
 *
 * Usage:
 *   <PaywallGate feature="galley" onUpgrade={() => setIsUpgradeOpen(true)}>
 *       <GalleyPage />
 *   </PaywallGate>
 */

import React from 'react';
import { useEntitlement } from '../hooks/useEntitlement';
import { TIER_INFO, requiredTier, type Feature } from '../services/SubscriptionService';
import { DiamondIcon, LockIcon } from './Icons';

interface PaywallGateProps {
    feature: Feature;
    /** Opens the global UpgradeModal (already wired in App.tsx). */
    onUpgrade: () => void;
    /** Optional override of the headline shown on the upsell card. */
    title?: string;
    /** Optional override of the body copy. */
    subtitle?: string;
    /** Where to send the user if they back out instead of upgrading. */
    onBack?: () => void;
    children: React.ReactNode;
}

/** Default copy for each gated feature — overridable via props. */
const DEFAULT_COPY: Partial<Record<Feature, { title: string; subtitle: string }>> = {
    galley: {
        title: 'Galley & Meal Planning',
        subtitle: 'Plan provisioning, log meals, and track inventory across your voyage.',
    },
    marketplace: {
        title: 'Gear Exchange',
        subtitle: 'Buy, sell, and trade marine gear with other Thalassa skippers.',
    },
    diary: {
        title: 'AI Sailing Diary',
        subtitle: 'Voice-narrated voyage notes with Gemini-powered summaries and weather context.',
    },
};

export const PaywallGate: React.FC<PaywallGateProps> = ({ feature, onUpgrade, title, subtitle, onBack, children }) => {
    const entitled = useEntitlement(feature);
    if (entitled) return <>{children}</>;

    const copy = DEFAULT_COPY[feature] ?? {
        title: 'Premium Feature',
        subtitle: 'Upgrade your plan to access this feature.',
    };
    const headline = title ?? copy.title;
    const body = subtitle ?? copy.subtitle;
    const tier = requiredTier(feature);
    const tierInfo = TIER_INFO[tier];

    return (
        <div className="flex flex-col items-center justify-center min-h-[70vh] p-6 text-center">
            <div
                className="w-16 h-16 mb-5 rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(245,158,11,0.25)]"
                style={{
                    background: `linear-gradient(135deg, ${tierInfo.color}, #f97316)`,
                }}
            >
                <LockIcon className="w-7 h-7 text-black" />
            </div>

            <h2 className="text-xl font-bold text-white mb-2 tracking-tight">{headline}</h2>
            <p className="text-sm text-gray-400 max-w-sm mb-6 leading-relaxed">{body}</p>

            <div
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full mb-6 text-[11px] font-bold uppercase tracking-widest"
                style={{
                    background: `${tierInfo.color}1f`,
                    color: tierInfo.color,
                    border: `1px solid ${tierInfo.color}66`,
                }}
            >
                <DiamondIcon className="w-3 h-3" />
                {tierInfo.label} plan
            </div>

            <button
                onClick={onUpgrade}
                className="px-6 py-3 rounded-xl font-bold shadow-lg active:scale-95 transition-all flex items-center gap-2"
                style={{
                    background: `linear-gradient(135deg, ${tierInfo.color}, #f97316)`,
                    color: '#000',
                }}
                aria-label={`Upgrade to ${tierInfo.label} to unlock ${headline}`}
            >
                <LockIcon className="w-4 h-4" />
                Unlock with {tierInfo.label}
            </button>

            {onBack && (
                <button
                    onClick={onBack}
                    className="mt-4 text-sm text-gray-500 hover:text-gray-300 transition-colors"
                    aria-label="Go back"
                >
                    ← Back
                </button>
            )}

            <p className="text-[11px] text-gray-600 mt-8">7-day free trial · cancel anytime</p>
        </div>
    );
};
