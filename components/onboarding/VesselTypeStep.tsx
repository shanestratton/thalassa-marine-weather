import React from 'react';
import { SailBoatIcon, PowerBoatIcon, EyeIcon, CheckIcon } from '../Icons';

interface VesselTypeStepProps {
    vesselType: 'sail' | 'power' | 'observer';
    onVesselTypeChange: (type: 'sail' | 'power' | 'observer') => void;
    onNext: () => void;
}

const VESSEL_OPTIONS = [
    {
        value: 'sail' as const,
        label: 'Sailing',
        desc: 'Wind-powered vessel',
        Icon: SailBoatIcon,
    },
    {
        value: 'power' as const,
        label: 'Power Boating',
        desc: 'Motor yacht or cruiser',
        Icon: PowerBoatIcon,
    },
    {
        value: 'observer' as const,
        label: 'Crew Member',
        desc: 'Joining a crew — no vessel setup needed',
        Icon: EyeIcon,
    },
];

export const VesselTypeStep: React.FC<VesselTypeStepProps> = ({ vesselType, onVesselTypeChange, onNext }) => (
    <div className="animate-in fade-in slide-in-from-right-8 duration-500">
        <h2 className="text-2xl font-bold text-white mb-6 text-center">What brings you to the water?</h2>
        <div className="grid grid-cols-1 gap-4 mb-8">
            {VESSEL_OPTIONS.map(({ value, label, desc, Icon }) => (
                <button
                    key={value}
                    aria-label="Vessel Type"
                    onClick={() => onVesselTypeChange(value)}
                    className={`p-6 rounded-2xl border transition-all flex items-center gap-4 group ${vesselType === value ? 'bg-sky-500/20 border-sky-500' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}
                >
                    <div
                        className={`p-3 rounded-full ${vesselType === value ? 'bg-sky-500 text-white' : 'bg-white/10 text-gray-400'}`}
                    >
                        <Icon className="w-8 h-8" />
                    </div>
                    <div className="text-left">
                        <span className="block text-lg font-bold text-white">{label}</span>
                        <span className="text-sm text-gray-400">{desc}</span>
                    </div>
                    {vesselType === value && <CheckIcon className="w-6 h-6 text-sky-500 ml-auto" />}
                </button>
            ))}
        </div>
        <button
            aria-label="Proceed to next step"
            onClick={onNext}
            className="w-full bg-sky-500 hover:bg-sky-400 text-white font-bold py-4 rounded-xl transition-all"
        >
            Next
        </button>
    </div>
);
