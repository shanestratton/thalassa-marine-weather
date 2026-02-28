/**
 * AestheticsTab — App theme, display mode, voyage tracking settings.
 * Extracted from SettingsModal monolith.
 */
import React, { useState, useEffect } from 'react';
import { Section, Row, Toggle, type SettingsTabProps } from './SettingsPrimitives';
import { DisplayMode } from '../../types';
import { EnvironmentService } from '../../services/EnvironmentService';
import type { EnvironmentMode } from '../../services/EnvironmentService';

export const AestheticsTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const [envMode, setEnvMode] = useState<EnvironmentMode>(() => EnvironmentService.getState().mode);
    const [envState, setEnvState] = useState(() => EnvironmentService.getState());

    useEffect(() => {
        const unsub = EnvironmentService.onStateChange((state) => {
            setEnvState(state);
            setEnvMode(state.mode);
        });
        return unsub;
    }, []);

    return (
        <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
            {/* Environment Theme */}
            <Section title="App Theme">
                <div className="p-4">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <label className="text-sm text-white font-bold block">Environment Mode</label>
                            <p className="text-xs text-gray-500 mt-0.5">
                                {envMode === 'auto'
                                    ? `Auto-detected: ${envState.current === 'offshore' ? '⚓ Offshore' : '🏖️ Onshore'} (${Math.round(envState.confidence * 100)}% confidence)`
                                    : envMode === 'offshore' ? '⚓ Offshore mode (manual)' : '🏖️ Onshore mode (manual)'}
                            </p>
                        </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                        {(['auto', 'onshore', 'offshore'] as EnvironmentMode[]).map((mode) => {
                            const isActive = envMode === mode;
                            const labels: Record<EnvironmentMode, { name: string, desc: string, icon: string, gradient: string }> = {
                                auto: { name: 'Auto', desc: 'Detects your location', icon: '🌊', gradient: 'from-sky-500/20 to-sky-600/20 border-sky-500/40 shadow-sky-500/20' },
                                onshore: { name: 'Onshore', desc: 'Beautiful & polished', icon: '🏖️', gradient: 'from-emerald-500/20 to-teal-600/20 border-emerald-500/40 shadow-emerald-500/20' },
                                offshore: { name: 'Offshore', desc: 'Practical & readable', icon: '⚓', gradient: 'from-sky-500/20 to-purple-600/20 border-sky-500/40 shadow-sky-500/20' },
                            };
                            const cfg = labels[mode];
                            return (
                                <button
                                    key={mode}
                                    onClick={() => {
                                        EnvironmentService.setMode(mode);
                                        setEnvMode(mode);
                                    }}
                                    className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all duration-300 active:scale-95 ${isActive
                                        ? `bg-gradient-to-br ${cfg.gradient} shadow-lg`
                                        : 'bg-white/5 border-transparent hover:bg-white/10 hover:border-white/10'
                                        }`}
                                >
                                    <span className="text-2xl">{cfg.icon}</span>
                                    <span className={`text-xs font-black uppercase tracking-wider ${isActive ? 'text-white' : 'text-gray-400'}`}>{cfg.name}</span>
                                    <span className={`text-[11px] ${isActive ? 'text-white/70' : 'text-gray-600'}`}>{cfg.desc}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            </Section>

            <Section title="Visual Preferences">
                <Row>
                    <div className="flex-1">
                        <label className="text-sm text-white font-medium block">Display Mode</label>
                        <p className="text-xs text-gray-500">Manage contrast and night vision</p>
                    </div>
                    <select
                        value={settings.displayMode}
                        onChange={(e) => onSave({ displayMode: e.target.value as DisplayMode })}
                        className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm outline-none focus:border-sky-500"
                    >
                        <option value="auto">Auto (Time based)</option>
                        <option value="night">Night Vision (Red)</option>
                        <option value="high-contrast">High Contrast</option>
                    </select>
                </Row>

                <Row>
                    <div className="flex-1">
                        <label className="text-sm text-white font-medium block">Always On Display</label>
                        <p className="text-xs text-gray-500">Prevent screen from sleeping</p>
                    </div>
                    <Toggle checked={settings.alwaysOn || false} onChange={(v) => onSave({ alwaysOn: v })} />
                </Row>
            </Section>

            <Section title="Voyage Tracking">
                <Row>
                    <div className="flex-1">
                        <label className="text-sm text-white font-medium block">Auto-Track on Launch</label>
                        <p className="text-xs text-gray-500">Automatically start recording your track when the app opens. GPS intervals adapt to your distance from shore. Duplicate positions within 5m are discarded.</p>
                    </div>
                    <Toggle checked={settings.autoTrackEnabled || false} onChange={(v) => onSave({ autoTrackEnabled: v })} />
                </Row>
            </Section>
        </div>
    );
};
