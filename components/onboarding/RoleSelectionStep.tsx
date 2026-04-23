/**
 * RoleSelectionStep — Onboarding Step 4: Combined tier + role selector.
 * Maps to SubscriptionTier: Skipper (owner), First Mate (crew), Deckhand (free).
 */
import React from 'react';
import { CheckIcon } from '../Icons';
import type { SubscriptionTier } from '../../types/settings';
import { TIER_INFO } from '../../services/SubscriptionService';

/** Format a tier's annual price for the onboarding chips. Reads from
 *  TIER_INFO so changes to pricing in SubscriptionService propagate
 *  here automatically — no need to update copy in two places. */
function tierPriceLabel(tier: SubscriptionTier): string {
    const annual = TIER_INFO[tier].priceAnnual;
    if (annual <= 0) return 'Free';
    // Show whole dollars when there are no cents (e.g. $149/yr) to keep
    // the price chip tight; show 2dp when there are cents (e.g. $49.95/yr).
    const formatted = annual % 1 === 0 ? `$${annual}` : `$${annual.toFixed(2)}`;
    return `${formatted}/yr`;
}

interface RoleSelectionStepProps {
    selectedTier: SubscriptionTier;
    onTierChange: (tier: SubscriptionTier) => void;
    onVesselTypeChange: (type: 'sail' | 'power' | 'observer') => void;
    onNext: () => void;
}

const ROLE_OPTIONS: {
    tier: SubscriptionTier;
    vesselType: 'sail' | 'power' | 'observer';
    emoji: string;
    label: string;
    tagline: string;
    features: string[];
    color: string;
    borderColor: string;
    bgColor: string;
    price: string;
}[] = [
    {
        tier: 'owner',
        vesselType: 'sail', // Will be refined in VesselDetailsStep (sail/power toggle)
        emoji: '⚓',
        label: 'Skipper',
        tagline: 'I own or skipper a vessel',
        features: ['Route & passage planning', 'Full vessel profile & polars', "Galley & ship's stores"],
        color: 'text-amber-400',
        borderColor: 'border-amber-500',
        bgColor: 'bg-amber-500/15',
        price: tierPriceLabel('owner'),
    },
    {
        tier: 'crew',
        vesselType: 'observer',
        emoji: '🧭',
        label: 'First Mate',
        tagline: "I crew regularly on someone else's boat",
        features: ['GPS tracking & DMs', 'Full weather & tide charts', 'AI weather advice'],
        color: 'text-cyan-400',
        borderColor: 'border-cyan-500',
        bgColor: 'bg-cyan-500/15',
        price: tierPriceLabel('crew'),
    },
    {
        tier: 'free',
        vesselType: 'observer',
        emoji: '👀',
        label: 'Deckhand',
        tagline: 'Just here for weather and community',
        features: ['3-day marine forecast', 'Crew Talk & community', 'Shop the Chandlery'],
        color: 'text-gray-400',
        borderColor: 'border-gray-500',
        bgColor: 'bg-white/5',
        price: 'Free',
    },
];

export const RoleSelectionStep: React.FC<RoleSelectionStepProps> = ({
    selectedTier,
    onTierChange,
    onVesselTypeChange,
    onNext,
}) => {
    const handleSelect = (option: (typeof ROLE_OPTIONS)[number]) => {
        onTierChange(option.tier);
        onVesselTypeChange(option.vesselType);
    };

    return (
        <div className="animate-in fade-in slide-in-from-right-8 duration-500">
            <h2 className="text-2xl font-bold text-white mb-2 text-center">What brings you to the water?</h2>
            <p className="text-sm text-gray-400 text-center mb-6">
                Choose your role — you can change this anytime in Nav Station → Settings.
            </p>
            <div className="grid grid-cols-1 gap-3 mb-8">
                {ROLE_OPTIONS.map((opt) => {
                    const isSelected = selectedTier === opt.tier;
                    return (
                        <button
                            key={opt.tier}
                            aria-label={`Select ${opt.label} role`}
                            onClick={() => handleSelect(opt)}
                            className={`relative p-5 rounded-2xl border-2 transition-all text-left group ${
                                isSelected
                                    ? `${opt.bgColor} ${opt.borderColor} shadow-lg`
                                    : 'bg-white/[0.03] border-white/[0.08] hover:bg-white/[0.06] hover:border-white/[0.15]'
                            }`}
                        >
                            <div className="flex items-start gap-4">
                                {/* Emoji badge */}
                                <div
                                    className={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl flex-shrink-0 transition-all ${
                                        isSelected ? opt.bgColor : 'bg-white/[0.06]'
                                    }`}
                                >
                                    {opt.emoji}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center justify-between mb-0.5">
                                        <span
                                            className={`text-lg font-black ${isSelected ? opt.color : 'text-white/80'}`}
                                        >
                                            {opt.label}
                                        </span>
                                        <div className="flex items-center gap-2">
                                            <span
                                                className={`text-xs font-bold ${isSelected ? opt.color : 'text-gray-500'}`}
                                            >
                                                {opt.price}
                                            </span>
                                            {isSelected && <CheckIcon className={`w-5 h-5 ${opt.color}`} />}
                                        </div>
                                    </div>
                                    <p className="text-sm text-gray-400 mb-2">{opt.tagline}</p>
                                    <div className="space-y-1">
                                        {opt.features.map((f) => (
                                            <div key={f} className="flex items-center gap-2">
                                                <div
                                                    className={`w-1 h-1 rounded-full flex-shrink-0 ${isSelected ? opt.color.replace('text-', 'bg-') : 'bg-gray-600'}`}
                                                />
                                                <span className="text-[12px] text-gray-400">{f}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </button>
                    );
                })}
            </div>
            <button
                aria-label="Proceed to next step"
                onClick={onNext}
                className="w-full bg-sky-500 hover:bg-sky-400 text-white font-bold py-4 rounded-xl transition-all active:scale-[0.98]"
            >
                Next
            </button>
        </div>
    );
};

RoleSelectionStep.displayName = 'RoleSelectionStep';
