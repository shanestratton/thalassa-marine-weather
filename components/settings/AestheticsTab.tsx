/**
 * AestheticsTab — App theme, display mode, dashboard layout settings.
 * Extracted from SettingsModal monolith (236 lines → standalone component).
 */
import React, { useState, useEffect } from 'react';
import { Section, Row, Toggle, type SettingsTabProps } from './SettingsPrimitives';
import { DisplayMode, UserSettings } from '../../types';
import { ArrowUpIcon, ArrowDownIcon, ArrowRightIcon, CheckIcon } from '../Icons';
import { ALL_HERO_WIDGETS, ALL_ROW_WIDGETS } from '../WidgetDefinitions';
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
                                auto: { name: 'Auto', desc: 'Detects your location', icon: '🌊', gradient: 'from-sky-500/20 to-blue-600/20 border-sky-500/40 shadow-sky-500/20' },
                                onshore: { name: 'Onshore', desc: 'Beautiful & polished', icon: '🏖️', gradient: 'from-emerald-500/20 to-teal-600/20 border-emerald-500/40 shadow-emerald-500/20' },
                                offshore: { name: 'Offshore', desc: 'Practical & readable', icon: '⚓', gradient: 'from-indigo-500/20 to-purple-600/20 border-indigo-500/40 shadow-indigo-500/20' },
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
                                    <span className={`text-[9px] ${isActive ? 'text-white/70' : 'text-gray-600'}`}>{cfg.desc}</span>
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

            <Section title="Dashboard Layout">
                <div className="p-4 space-y-6">
                    {/* MAIN LAYOUT ORDER */}
                    <div className="mb-8 p-3 rounded-xl bg-white/5 border border-white/5">
                        <h4 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-3">Main Layout Order</h4>
                        <p className="text-[10px] text-gray-400 mb-3 uppercase font-bold">Use arrows to reorder dashboard sections</p>
                        <div className="flex flex-col gap-2">
                            {(settings.rowOrder || []).map((id, idx, arr) => {
                                const w = ALL_ROW_WIDGETS.find(x => x.id === id);
                                if (!w) return null;

                                return (
                                    <div key={id} className="flex items-center gap-3 p-3 bg-black/20 border border-white/5 rounded-xl">
                                        <div className="text-sky-400">{w.icon}</div>
                                        <span className="text-xs font-bold text-white flex-1">{w.label}</span>

                                        {/* Reorder Controls */}
                                        <div className="flex gap-1">
                                            <button
                                                disabled={idx === 0}
                                                onClick={() => {
                                                    const newOrder = [...arr];
                                                    [newOrder[idx - 1], newOrder[idx]] = [newOrder[idx], newOrder[idx - 1]];
                                                    onSave({ rowOrder: newOrder });
                                                }}
                                                className={`p-1.5 rounded-lg border border-white/5 transition-colors ${idx === 0 ? 'opacity-20 cursor-not-allowed' : 'hover:bg-white/10 text-sky-400'}`}
                                            >
                                                <ArrowUpIcon className="w-4 h-4" />
                                            </button>
                                            <button
                                                disabled={idx === arr.length - 1}
                                                onClick={() => {
                                                    const newOrder = [...arr];
                                                    [newOrder[idx], newOrder[idx + 1]] = [newOrder[idx + 1], newOrder[idx]];
                                                    onSave({ rowOrder: newOrder });
                                                }}
                                                className={`p-1.5 rounded-lg border border-white/5 transition-colors ${idx === arr.length - 1 ? 'opacity-20 cursor-not-allowed' : 'hover:bg-white/10 text-sky-400'}`}
                                            >
                                                <ArrowDownIcon className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* TOP WIDGET SELECTOR */}
                    <div className="mb-8 p-3 rounded-xl bg-white/5 border border-white/5">
                        <h4 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-3">Top Header Widget</h4>
                        <div className="flex gap-2 overflow-x-auto pb-1">
                            {ALL_HERO_WIDGETS.map(w => {
                                const isActive = (settings.topHeroWidget || 'sunrise') === w.id;
                                return (
                                    <button
                                        key={w.id}
                                        onClick={() => onSave({ topHeroWidget: w.id })}
                                        className={`flex items-center gap-2 p-2 rounded-lg border transition-all whitespace-nowrap ${isActive ? 'bg-sky-500/10 border-sky-500/50 text-white' : 'bg-black/20 border-transparent text-gray-500 hover:bg-white/5'}`}
                                    >
                                        <div className={isActive ? 'text-sky-400' : 'text-gray-600'}>{w.icon}</div>
                                        <span className="text-[10px] font-bold">{w.label}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div>
                        <h4 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-3">Hero Widgets (Carousel) <span className="text-[9px] text-sky-400 ml-2">(MAX 3)</span></h4>

                        {/* REORDERING SECTION */}
                        {(settings.heroWidgets || []).length > 0 && (
                            <div className="mb-4 bg-black/20 rounded-xl p-3 border border-white/5">
                                <p className="text-[10px] text-gray-400 mb-2 uppercase font-bold">Active Order (Use arrows to move)</p>
                                <div className="flex gap-2 overflow-x-auto pb-2">
                                    {(settings.heroWidgets || []).map((id, idx, arr) => {
                                        const w = ALL_HERO_WIDGETS.find(x => x.id === id);
                                        if (!w) return null;
                                        return (
                                            <div key={id} className="flex flex-col gap-1 items-center bg-sky-500/10 border border-sky-500/30 rounded-lg p-2 min-w-[80px]">
                                                <div className="text-sky-400 mb-1">{w.icon}</div>
                                                <span className="text-[10px] font-bold text-white mb-1 truncate max-w-full">{w.label}</span>
                                                <div className="flex gap-1 mt-auto">
                                                    <button
                                                        disabled={idx === 0}
                                                        onClick={() => {
                                                            const newOrder = [...arr];
                                                            [newOrder[idx - 1], newOrder[idx]] = [newOrder[idx], newOrder[idx - 1]];
                                                            onSave({ heroWidgets: newOrder });
                                                        }}
                                                        className={`p-1 rounded hover:bg-white/10 ${idx === 0 ? 'opacity-20' : 'text-sky-300'}`}
                                                    >
                                                        <div className="rotate-180"><ArrowRightIcon className="w-3 h-3" /></div>
                                                    </button>
                                                    <button
                                                        disabled={idx === arr.length - 1}
                                                        onClick={() => {
                                                            const newOrder = [...arr];
                                                            [newOrder[idx], newOrder[idx + 1]] = [newOrder[idx + 1], newOrder[idx]];
                                                            onSave({ heroWidgets: newOrder });
                                                        }}
                                                        className={`p-1 rounded hover:bg-white/10 ${idx === arr.length - 1 ? 'opacity-20' : 'text-sky-300'}`}
                                                    >
                                                        <ArrowRightIcon className="w-3 h-3" />
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        <div className="grid grid-cols-2 gap-2">
                            {ALL_HERO_WIDGETS.map(w => {
                                const current = settings.heroWidgets || [];
                                const isActive = current.includes(w.id);
                                const isMaxed = current.length >= 3;
                                const disabled = !isActive && isMaxed;

                                return (
                                    <button
                                        key={w.id}
                                        disabled={disabled}
                                        onClick={() => {
                                            const newWidgets = isActive
                                                ? current.filter(id => id !== w.id)
                                                : [...current, w.id];
                                            onSave({ heroWidgets: newWidgets });
                                        }}
                                        className={`flex items-center gap-3 p-3 rounded-xl border transition-all text-left ${isActive ? 'bg-sky-500/10 border-sky-500/50 text-white' : 'bg-white/5 border-transparent text-gray-500 hover:bg-white/10'} ${disabled ? 'opacity-30 cursor-not-allowed' : ''}`}
                                    >
                                        <div className={isActive ? 'text-sky-400' : 'text-gray-600'}>{w.icon}</div>
                                        <span className="text-xs font-bold">{w.label}</span>
                                        {isActive && <CheckIcon className="w-3 h-3 ml-auto text-sky-500" />}
                                    </button>
                                );
                            })}
                        </div>
                    </div>


                </div>
            </Section>
        </div>
    );
};
