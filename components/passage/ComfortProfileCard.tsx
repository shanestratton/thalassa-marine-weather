/**
 * ComfortProfileCard — Voyage comfort threshold configuration.
 *
 * Sets max wind, max wave height, preferred wind angle, night sailing.
 * Used by WeatherWindowService to score departure windows.
 * Red → Green when thresholds are saved.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ComfortProfileService, ANGLE_LABELS, type ComfortProfile } from '../../services/ComfortProfileService';
import { triggerHaptic } from '../../utils/system';

interface ComfortProfileCardProps {
    voyageId?: string;
    onReviewedChange?: (ready: boolean) => void;
}

export const ComfortProfileCard: React.FC<ComfortProfileCardProps> = ({ voyageId, onReviewedChange }) => {
    const [profile, setProfile] = useState<ComfortProfile>(() => ComfortProfileService.load(voyageId));
    const [saved, setSaved] = useState(profile.configured);

    useEffect(() => {
        onReviewedChange?.(profile.configured);
    }, [profile.configured, onReviewedChange]);

    const updateField = useCallback(<K extends keyof ComfortProfile>(key: K, value: ComfortProfile[K]) => {
        setProfile((prev) => ({ ...prev, [key]: value }));
        setSaved(false);
    }, []);

    const handleSave = useCallback(() => {
        ComfortProfileService.save(profile, voyageId);
        setProfile((prev) => ({ ...prev, configured: true }));
        setSaved(true);
        triggerHaptic('medium');
    }, [profile, voyageId]);

    // Wind severity label
    const windSeverity =
        profile.maxWindKts <= 15
            ? 'Light'
            : profile.maxWindKts <= 20
              ? 'Moderate'
              : profile.maxWindKts <= 25
                ? 'Fresh'
                : profile.maxWindKts <= 30
                  ? 'Strong'
                  : 'Gale';

    const windColor =
        profile.maxWindKts <= 15
            ? 'text-emerald-400'
            : profile.maxWindKts <= 20
              ? 'text-cyan-400'
              : profile.maxWindKts <= 25
                ? 'text-amber-400'
                : profile.maxWindKts <= 30
                  ? 'text-orange-400'
                  : 'text-red-400';

    return (
        <div className="space-y-4">
            {/* Wind Threshold */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-bold text-white uppercase tracking-widest">
                        💨 Max Acceptable Wind
                    </span>
                    <span className={`text-sm font-bold ${windColor}`}>
                        {profile.maxWindKts}kt
                        <span className="text-[11px] opacity-60 ml-1">{windSeverity}</span>
                    </span>
                </div>
                <input
                    type="range"
                    min={10}
                    max={40}
                    step={1}
                    value={profile.maxWindKts}
                    onChange={(e) => updateField('maxWindKts', Number(e.target.value))}
                    className="w-full accent-cyan-500"
                />
                <div className="flex justify-between text-[11px] text-gray-500 mt-1">
                    <span>10kt Light</span>
                    <span>25kt Fresh</span>
                    <span>40kt Gale</span>
                </div>
            </div>

            {/* Wave Threshold */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-bold text-white uppercase tracking-widest">
                        🌊 Max Acceptable Wave
                    </span>
                    <span className="text-sm font-bold text-cyan-400">{profile.maxWaveM}m</span>
                </div>
                <input
                    type="range"
                    min={0.5}
                    max={5}
                    step={0.5}
                    value={profile.maxWaveM}
                    onChange={(e) => updateField('maxWaveM', Number(e.target.value))}
                    className="w-full accent-cyan-500"
                />
                <div className="flex justify-between text-[11px] text-gray-500 mt-1">
                    <span>0.5m Calm</span>
                    <span>2.5m Moderate</span>
                    <span>5m Rough</span>
                </div>
            </div>

            {/* Wind Angle Preference */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3">🧭 Preferred Wind Angle</h4>
                <div className="space-y-1.5">
                    {(Object.entries(ANGLE_LABELS) as Array<[ComfortProfile['preferredAngle'], string]>).map(
                        ([key, label]) => {
                            const active = profile.preferredAngle === key;
                            return (
                                <button
                                    key={key}
                                    onClick={() => updateField('preferredAngle', key)}
                                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all active:scale-[0.98] ${
                                        active
                                            ? 'bg-violet-500/15 border border-violet-500/25 text-violet-300'
                                            : 'bg-white/[0.02] border border-white/[0.04] text-gray-400 hover:bg-white/[0.04]'
                                    }`}
                                >
                                    <div
                                        className={`w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center shrink-0 transition-all ${
                                            active
                                                ? 'bg-violet-500 border-violet-500'
                                                : 'border-gray-500 bg-transparent'
                                        }`}
                                    >
                                        {active && <div className="w-2 h-2 rounded-full bg-white" />}
                                    </div>
                                    <span
                                        className={`text-xs font-semibold ${active ? 'text-violet-300' : 'text-gray-400'}`}
                                    >
                                        {label}
                                    </span>
                                </button>
                            );
                        },
                    )}
                </div>
            </div>

            {/* Night Sailing Toggle */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <button
                    onClick={() => updateField('nightSailing', !profile.nightSailing)}
                    className="w-full flex items-center gap-3 text-left"
                >
                    <span className="text-xl">{profile.nightSailing ? '🌙' : '☀️'}</span>
                    <div className="flex-1">
                        <h4 className="text-xs font-bold text-white uppercase tracking-widest">Night Sailing</h4>
                        <p className="text-[11px] text-gray-400 mt-0.5">
                            {profile.nightSailing
                                ? 'Comfortable sailing at night — include overnight windows'
                                : 'Prefer daylight departures only (0600–2000)'}
                        </p>
                    </div>
                    <div
                        className={`w-12 h-7 rounded-full transition-all ${
                            profile.nightSailing ? 'bg-violet-500' : 'bg-gray-600'
                        }`}
                    >
                        <div
                            className={`w-5 h-5 rounded-full bg-white shadow-md mt-1 transition-all ${
                                profile.nightSailing ? 'ml-6' : 'ml-1'
                            }`}
                        />
                    </div>
                </button>
            </div>

            {/* Save Button + Summary */}
            <div
                className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${
                    saved ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-violet-500/10 border-violet-500/20'
                }`}
            >
                {saved ? (
                    <>
                        <span className="text-lg">✅</span>
                        <div className="flex-1">
                            <p className="text-xs font-bold text-emerald-400">
                                Comfort limits set — {windSeverity} conditions
                            </p>
                            <p className="text-[11px] text-emerald-400/60 mt-0.5">
                                ≤{profile.maxWindKts}kt wind · ≤{profile.maxWaveM}m wave ·{' '}
                                {profile.nightSailing ? 'Night OK' : 'Day only'}
                            </p>
                        </div>
                    </>
                ) : (
                    <button
                        onClick={handleSave}
                        className="flex-1 py-2.5 bg-violet-600 hover:bg-violet-500 text-white font-bold text-sm rounded-xl transition-all active:scale-[0.97]"
                    >
                        Save Comfort Profile
                    </button>
                )}
            </div>
        </div>
    );
};
