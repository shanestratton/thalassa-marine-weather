/**
 * VesselProfileCard — Vessel performance configuration for passage planning.
 *
 * Simple wizard: vessel type, LOA, cruising speed, motoring speed.
 * Calculates hull speed automatically.
 * Red → Green when profile is saved.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { VesselProfileService, type VesselProfile } from '../../services/VesselProfileService';
import { triggerHaptic } from '../../utils/system';

interface VesselProfileCardProps {
    voyageId?: string;
    onReviewedChange?: (ready: boolean) => void;
}

const VESSEL_TYPES: Array<{ key: VesselProfile['vesselType']; label: string; icon: string }> = [
    { key: 'monohull', label: 'Monohull', icon: '⛵' },
    { key: 'catamaran', label: 'Catamaran', icon: '🚢' },
    { key: 'power', label: 'Power', icon: '🚤' },
];

export const VesselProfileCard: React.FC<VesselProfileCardProps> = ({ onReviewedChange }) => {
    const [profile, setProfile] = useState<VesselProfile>(() => VesselProfileService.load());
    const [saved, setSaved] = useState(profile.configured);

    useEffect(() => {
        onReviewedChange?.(profile.configured);
    }, [profile.configured, onReviewedChange]);

    const updateField = useCallback(<K extends keyof VesselProfile>(key: K, value: VesselProfile[K]) => {
        setProfile((prev) => ({ ...prev, [key]: value }));
        setSaved(false);
    }, []);

    const handleSave = useCallback(() => {
        VesselProfileService.save(profile);
        setProfile((prev) => ({ ...prev, configured: true }));
        setSaved(true);
        triggerHaptic('medium');
    }, [profile]);

    const hullSpeed = VesselProfileService.hullSpeed(profile);

    return (
        <div className="space-y-4">
            {/* Vessel Type Selector */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3">🚢 Vessel Type</h4>
                <div className="grid grid-cols-3 gap-2">
                    {VESSEL_TYPES.map(({ key, label, icon }) => {
                        const active = profile.vesselType === key;
                        return (
                            <button
                                key={key}
                                onClick={() => updateField('vesselType', key)}
                                className={`p-3 rounded-xl border text-center transition-all active:scale-[0.97] ${
                                    active
                                        ? 'bg-violet-500/15 border-violet-500/30 text-violet-300'
                                        : 'bg-white/[0.02] border-white/[0.06] text-gray-400 hover:bg-white/[0.05]'
                                }`}
                            >
                                <span className="text-2xl block mb-1">{icon}</span>
                                <span className="text-[11px] font-bold">{label}</span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* LOA + Speeds */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 space-y-4">
                {/* LOA */}
                <div>
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-xs font-bold text-white uppercase tracking-widest">
                            📏 Length Overall
                        </span>
                        <span className="text-sm font-bold text-violet-400">{profile.loaFeet}ft</span>
                    </div>
                    <input
                        type="range"
                        min={24}
                        max={65}
                        step={1}
                        value={profile.loaFeet}
                        onChange={(e) => updateField('loaFeet', Number(e.target.value))}
                        className="w-full accent-violet-500"
                    />
                    <div className="flex justify-between text-[11px] text-gray-500 mt-1">
                        <span>24ft</span>
                        <span className="text-violet-400/50 font-bold">Hull speed: {hullSpeed}kt</span>
                        <span>65ft</span>
                    </div>
                </div>

                {/* Cruising Speed */}
                <div>
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-xs font-bold text-white uppercase tracking-widest">
                            ⛵ Cruising Speed
                        </span>
                        <span className="text-sm font-bold text-cyan-400">{profile.cruisingSpeedKts}kt</span>
                    </div>
                    <input
                        type="range"
                        min={3}
                        max={12}
                        step={0.5}
                        value={profile.cruisingSpeedKts}
                        onChange={(e) => updateField('cruisingSpeedKts', Number(e.target.value))}
                        className="w-full accent-cyan-500"
                    />
                    <div className="flex justify-between text-[11px] text-gray-500 mt-1">
                        <span>3kt</span>
                        <span>12kt</span>
                    </div>
                </div>

                {/* Motoring Speed */}
                <div>
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-xs font-bold text-white uppercase tracking-widest">
                            🔧 Motoring Speed
                        </span>
                        <span className="text-sm font-bold text-amber-400">{profile.motoringSpeedKts}kt</span>
                    </div>
                    <input
                        type="range"
                        min={3}
                        max={8}
                        step={0.5}
                        value={profile.motoringSpeedKts}
                        onChange={(e) => updateField('motoringSpeedKts', Number(e.target.value))}
                        className="w-full accent-amber-500"
                    />
                    <div className="flex justify-between text-[11px] text-gray-500 mt-1">
                        <span>3kt</span>
                        <span>8kt</span>
                    </div>
                </div>
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
                                Profile saved — {VESSEL_TYPES.find((t) => t.key === profile.vesselType)?.label}{' '}
                                {profile.loaFeet}ft
                            </p>
                            <p className="text-[11px] text-emerald-400/60 mt-0.5">
                                {profile.cruisingSpeedKts}kt cruise · {profile.motoringSpeedKts}kt motor · {hullSpeed}kt
                                hull
                            </p>
                        </div>
                    </>
                ) : (
                    <>
                        <button
                            onClick={handleSave}
                            className="flex-1 py-2.5 bg-violet-600 hover:bg-violet-500 text-white font-bold text-sm rounded-xl transition-all active:scale-[0.97]"
                        >
                            Save Vessel Profile
                        </button>
                    </>
                )}
            </div>
        </div>
    );
};
