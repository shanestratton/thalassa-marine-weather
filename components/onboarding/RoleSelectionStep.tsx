/**
 * RoleSelectionStep — Onboarding Step 3: setup-role selector.
 *
 * A role personalises the wizard; it is deliberately independent from paid
 * entitlement. Choosing "Skipper" must never grant a subscription.
 */
import React from 'react';
import { AnchorIcon, CheckIcon, CompassIcon, EyeIcon } from '../Icons';

export type OnboardingRole = 'skipper' | 'crew' | 'deckhand';

/* CompassIcon takes a required rotation; a mate's compass points north. */
const NorthCompassIcon: React.FC<{ className?: string }> = ({ className }) => (
    <CompassIcon className={className} rotation={0} />
);

interface RoleSelectionStepProps {
    selectedRole: OnboardingRole;
    onRoleChange: (role: OnboardingRole) => void;
    onVesselTypeChange: (type: 'sail' | 'power' | 'observer') => void;
    onNext: () => void;
}

const ROLE_OPTIONS: {
    role: OnboardingRole;
    vesselType: 'sail' | 'power' | 'observer';
    /* An SVG from the app's own set, not an emoji: emoji ignore currentColor,
       so the role accent below could never tint them, and they render as
       Apple/Android artwork inside a stroked icon set. */
    Icon: React.FC<{ className?: string }>;
    label: string;
    tagline: string;
    features: string[];
    color: string;
    borderColor: string;
    bgColor: string;
    setupLabel: string;
}[] = [
    {
        role: 'skipper',
        vesselType: 'sail', // Will be refined in VesselDetailsStep (sail/power toggle)
        Icon: AnchorIcon,
        label: 'Skipper',
        tagline: 'I own or skipper a vessel',
        features: ['Configure your vessel', 'Set crew and safety details', 'Choose offshore preferences'],
        color: 'text-amber-400',
        borderColor: 'border-amber-500',
        bgColor: 'bg-amber-500/15',
        setupLabel: 'Vessel setup',
    },
    {
        role: 'crew',
        vesselType: 'observer',
        Icon: NorthCompassIcon,
        label: 'First Mate',
        tagline: "I crew regularly on someone else's boat",
        features: ['Set your crew identity', 'Prepare to join shared passages', 'Choose weather preferences'],
        color: 'text-cyan-400',
        borderColor: 'border-cyan-500',
        bgColor: 'bg-cyan-500/15',
        setupLabel: 'Crew setup',
    },
    {
        role: 'deckhand',
        vesselType: 'observer',
        Icon: EyeIcon,
        label: 'Deckhand',
        tagline: 'Just here for weather and community',
        features: ['Set weather preferences', 'Explore maps and forecasts', 'Add a vessel later'],
        color: 'text-gray-400',
        borderColor: 'border-gray-500',
        bgColor: 'bg-white/5',
        setupLabel: 'Quick setup',
    },
];

export const RoleSelectionStep: React.FC<RoleSelectionStepProps> = ({
    selectedRole,
    onRoleChange,
    onVesselTypeChange,
    onNext,
}) => {
    const handleSelect = (option: (typeof ROLE_OPTIONS)[number]) => {
        onRoleChange(option.role);
        onVesselTypeChange(option.vesselType);
    };

    return (
        <div className="animate-in fade-in slide-in-from-right-8 duration-500">
            <h2 className="text-2xl font-bold text-white mb-2 text-center">What brings you to the water?</h2>
            <p className="text-sm text-gray-400 text-center mb-6">
                This personalises setup only. It does not activate or change a paid plan.
            </p>
            <div className="grid grid-cols-1 gap-3 mb-8">
                {ROLE_OPTIONS.map((opt) => {
                    const isSelected = selectedRole === opt.role;
                    return (
                        <button
                            type="button"
                            key={opt.role}
                            aria-label={`Select ${opt.label} role`}
                            aria-pressed={isSelected}
                            onClick={() => handleSelect(opt)}
                            className={`relative p-5 rounded-2xl border-2 transition-all text-left group ${
                                isSelected
                                    ? `${opt.bgColor} ${opt.borderColor} shadow-lg`
                                    : 'bg-white/3 border-white/8 hover:bg-white/6 hover:border-white/15'
                            }`}
                        >
                            <div className="flex items-start gap-4">
                                {/* Role badge */}
                                <div
                                    className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 transition-all ${
                                        isSelected ? opt.bgColor : 'bg-white/6'
                                    }`}
                                >
                                    <opt.Icon className={`w-6 h-6 ${isSelected ? opt.color : 'text-gray-400'}`} />
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
                                                {opt.setupLabel}
                                            </span>
                                            {isSelected && <CheckIcon className={`w-5 h-5 ${opt.color}`} />}
                                        </div>
                                    </div>
                                    <p className="text-sm text-gray-400 mb-2">{opt.tagline}</p>
                                    <div className="space-y-1">
                                        {opt.features.map((f) => (
                                            <div key={f} className="flex items-center gap-2">
                                                <div
                                                    className={`w-1 h-1 rounded-full shrink-0 ${isSelected ? opt.color.replace('text-', 'bg-') : 'bg-gray-600'}`}
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
                type="button"
                aria-label="Continue after choosing your role"
                onClick={onNext}
                className="w-full bg-sky-500 hover:bg-sky-400 text-white font-bold py-4 rounded-xl transition-all active:scale-[0.98]"
            >
                Next
            </button>
        </div>
    );
};

RoleSelectionStep.displayName = 'RoleSelectionStep';
