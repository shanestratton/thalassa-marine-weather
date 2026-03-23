import React from 'react';

interface DisplayPrefsStepProps {
    prefAlwaysOn: boolean;
    onAlwaysOnChange: (value: boolean) => void;
    prefOrientation: 'auto' | 'portrait' | 'landscape';
    onOrientationChange: (value: 'auto' | 'portrait' | 'landscape') => void;
    onFinish: () => void;
}

const ORIENTATION_OPTIONS = [
    { value: 'auto' as const, label: 'Auto', icon: '🔄', desc: 'Rotates freely' },
    { value: 'portrait' as const, label: 'Portrait', icon: '📱', desc: 'Recommended', recommended: true },
    { value: 'landscape' as const, label: 'Landscape', icon: '🖥️', desc: 'Wide view' },
];

export const DisplayPrefsStep: React.FC<DisplayPrefsStepProps> = ({
    prefAlwaysOn,
    onAlwaysOnChange,
    prefOrientation,
    onOrientationChange,
    onFinish,
}) => (
    <div className="animate-in fade-in slide-in-from-right-8 duration-500">
        <h2 className="text-2xl font-bold text-white mb-6 text-center">Display Preferences</h2>

        <div className="space-y-6 mb-8">
            {/* Always On */}
            <div className="bg-white/5 rounded-xl p-5 border border-white/10">
                <div className="flex items-center justify-between">
                    <div>
                        <h3 className="text-sm font-bold text-white mb-1">Always On Display</h3>
                        <p className="text-xs text-gray-400 leading-relaxed">
                            Keep the screen awake while the app is open. Ideal for cockpit or helm use.
                        </p>
                    </div>
                    <button
                        aria-label="Pref Always On"
                        onClick={() => onAlwaysOnChange(!prefAlwaysOn)}
                        className={`relative w-12 h-7 rounded-full transition-all duration-300 shrink-0 ml-4 ${
                            prefAlwaysOn ? 'bg-sky-500' : 'bg-white/15'
                        }`}
                    >
                        <div
                            className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow-md transition-all duration-300 ${
                                prefAlwaysOn ? 'left-[22px]' : 'left-0.5'
                            }`}
                        />
                    </button>
                </div>
            </div>

            {/* Screen Orientation */}
            <div className="bg-white/5 rounded-xl p-5 border border-white/10">
                <h3 className="text-sm font-bold text-white mb-1">Screen Orientation</h3>
                <p className="text-xs text-gray-400 mb-4">Lock your screen orientation, or let it rotate freely.</p>
                <div className="grid grid-cols-3 gap-2">
                    {ORIENTATION_OPTIONS.map((opt) => {
                        const isActive = prefOrientation === opt.value;
                        return (
                            <button
                                aria-label="Pref Orientation"
                                key={opt.value}
                                onClick={() => onOrientationChange(opt.value)}
                                className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all duration-300 active:scale-95 ${
                                    isActive
                                        ? 'bg-gradient-to-br from-sky-500/20 to-sky-600/20 border-sky-500/40 shadow-lg shadow-sky-500/20'
                                        : 'bg-white/5 border-transparent hover:bg-white/10 hover:border-white/10'
                                }`}
                            >
                                <span className="text-2xl">{opt.icon}</span>
                                <span
                                    className={`text-xs font-black uppercase tracking-wider ${
                                        isActive ? 'text-white' : 'text-gray-400'
                                    }`}
                                >
                                    {opt.label}
                                </span>
                                <span
                                    className={`text-[11px] ${
                                        isActive
                                            ? 'text-white/70'
                                            : opt.recommended
                                              ? 'text-emerald-400/70'
                                              : 'text-gray-400'
                                    }`}
                                >
                                    {opt.desc}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>

        <button
            aria-label="Finish"
            onClick={onFinish}
            className="w-full bg-emerald-500 hover:bg-emerald-400 text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-emerald-500/20"
        >
            Launch Dashboard
        </button>
    </div>
);
