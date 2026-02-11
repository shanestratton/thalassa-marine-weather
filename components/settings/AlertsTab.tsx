/**
 * AlertsTab — Weather notification thresholds settings panel.
 * Extracted from SettingsModal monolith (163 lines → standalone component).
 */
import React from 'react';
import { Section, Row, Toggle, type SettingsTabProps } from './SettingsPrimitives';
import {
    WindIcon, WaveIcon, EyeIcon, SunIcon, ThermometerIcon, RainIcon
} from '../Icons';

export const AlertsTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const updateAlert = async (
        key: keyof typeof settings.notifications,
        field: 'enabled' | 'threshold',
        value: boolean | number
    ) => {
        if (field === 'enabled' && value === true) {
            if ('Notification' in window && Notification.permission !== 'granted') {
                try { await Notification.requestPermission(); } catch { /* user denied or API unavailable */ }
            }
        }
        onSave({
            notifications: {
                ...settings.notifications,
                [key]: { ...settings.notifications[key as keyof typeof settings.notifications], [field]: value }
            }
        });
    };

    return (
        <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
            <Section title="Thresholds">
                {/* 1. High Wind */}
                <Row onClick={() => updateAlert('wind', 'enabled', !settings.notifications.wind.enabled)}>
                    <div className="flex items-center gap-4">
                        <div className="p-2 bg-purple-500/20 text-purple-300 rounded-lg"><WindIcon className="w-6 h-6" /></div>
                        <div>
                            <p className="text-white font-bold">High Wind</p>
                            <p className="text-[10px] text-gray-500 uppercase tracking-wide">Sustained Forecast</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-lg border border-white/10" onClick={e => e.stopPropagation()}>
                            <input type="number" value={settings.notifications.wind.threshold} onChange={(e) => updateAlert('wind', 'threshold', Number(e.target.value))} className="w-12 bg-transparent text-white text-right outline-none font-bold" />
                            <span className="text-xs text-gray-500">kts</span>
                        </div>
                        <Toggle checked={settings.notifications.wind.enabled} onChange={(v) => updateAlert('wind', 'enabled', v)} />
                    </div>
                </Row>

                {/* 2. Gusts */}
                <Row onClick={() => updateAlert('gusts', 'enabled', !settings.notifications.gusts.enabled)}>
                    <div className="flex items-center gap-4">
                        <div className="p-2 bg-orange-500/20 text-orange-300 rounded-lg"><WindIcon className="w-6 h-6" /></div>
                        <div>
                            <p className="text-white font-bold">Gusts</p>
                            <p className="text-[10px] text-gray-500 uppercase tracking-wide">Peak Gust Forecast</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-lg border border-white/10" onClick={e => e.stopPropagation()}>
                            <input type="number" value={settings.notifications.gusts.threshold} onChange={(e) => updateAlert('gusts', 'threshold', Number(e.target.value))} className="w-12 bg-transparent text-white text-right outline-none font-bold" />
                            <span className="text-xs text-gray-500">kts</span>
                        </div>
                        <Toggle checked={settings.notifications.gusts.enabled} onChange={(v) => updateAlert('gusts', 'enabled', v)} />
                    </div>
                </Row>

                {/* 3. High Seas */}
                <Row onClick={() => updateAlert('waves', 'enabled', !settings.notifications.waves.enabled)}>
                    <div className="flex items-center gap-4">
                        <div className="p-2 bg-blue-500/20 text-blue-300 rounded-lg"><WaveIcon className="w-6 h-6" /></div>
                        <div>
                            <p className="text-white font-bold">High Seas</p>
                            <p className="text-[10px] text-gray-500 uppercase tracking-wide">Significant Wave Hgt</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-lg border border-white/10" onClick={e => e.stopPropagation()}>
                            <input type="number" value={settings.notifications.waves.threshold} onChange={(e) => updateAlert('waves', 'threshold', Number(e.target.value))} className="w-12 bg-transparent text-white text-right outline-none font-bold" />
                            <span className="text-xs text-gray-500">ft</span>
                        </div>
                        <Toggle checked={settings.notifications.waves.enabled} onChange={(v) => updateAlert('waves', 'enabled', v)} />
                    </div>
                </Row>

                {/* 4. Long Period (Swell) */}
                <Row onClick={() => updateAlert('swellPeriod', 'enabled', !settings.notifications.swellPeriod.enabled)}>
                    <div className="flex items-center gap-4">
                        <div className="p-2 bg-indigo-500/20 text-indigo-300 rounded-lg"><WaveIcon className="w-6 h-6" /></div>
                        <div>
                            <p className="text-white font-bold">Long Period</p>
                            <p className="text-[10px] text-gray-500 uppercase tracking-wide">Swell Interval</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-lg border border-white/10" onClick={e => e.stopPropagation()}>
                            <input type="number" value={settings.notifications.swellPeriod.threshold} onChange={(e) => updateAlert('swellPeriod', 'threshold', Number(e.target.value))} className="w-12 bg-transparent text-white text-right outline-none font-bold" />
                            <span className="text-xs text-gray-500">s</span>
                        </div>
                        <Toggle checked={settings.notifications.swellPeriod.enabled} onChange={(v) => updateAlert('swellPeriod', 'enabled', v)} />
                    </div>
                </Row>

                {/* 5. Low Vis */}
                <Row onClick={() => updateAlert('visibility', 'enabled', !settings.notifications.visibility.enabled)}>
                    <div className="flex items-center gap-4">
                        <div className="p-2 bg-gray-500/20 text-gray-300 rounded-lg"><EyeIcon className="w-6 h-6" /></div>
                        <div>
                            <p className="text-white font-bold">Low Vis</p>
                            <p className="text-[10px] text-gray-500 uppercase tracking-wide">Fog / Mist</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-lg border border-white/10" onClick={e => e.stopPropagation()}>
                            <span className="text-xs text-gray-500 mr-1">&lt;</span>
                            <input type="number" value={settings.notifications.visibility.threshold} onChange={(e) => updateAlert('visibility', 'threshold', Number(e.target.value))} className="w-12 bg-transparent text-white text-right outline-none font-bold" />
                            <span className="text-xs text-gray-500">nm</span>
                        </div>
                        <Toggle checked={settings.notifications.visibility.enabled} onChange={(v) => updateAlert('visibility', 'enabled', v)} />
                    </div>
                </Row>

                {/* 6. High UV */}
                <Row onClick={() => updateAlert('uv', 'enabled', !settings.notifications.uv.enabled)}>
                    <div className="flex items-center gap-4">
                        <div className="p-2 bg-yellow-500/20 text-yellow-300 rounded-lg"><SunIcon className="w-6 h-6" /></div>
                        <div>
                            <p className="text-white font-bold">High UV</p>
                            <p className="text-[10px] text-gray-500 uppercase tracking-wide">Sun Intensity</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-lg border border-white/10" onClick={e => e.stopPropagation()}>
                            <input type="number" value={settings.notifications.uv.threshold} onChange={(e) => updateAlert('uv', 'threshold', Number(e.target.value))} className="w-12 bg-transparent text-white text-right outline-none font-bold" />
                            <span className="text-xs text-gray-500">idx</span>
                        </div>
                        <Toggle checked={settings.notifications.uv.enabled} onChange={(v) => updateAlert('uv', 'enabled', v)} />
                    </div>
                </Row>

                {/* 7. Heat Alert */}
                <Row onClick={() => updateAlert('tempHigh', 'enabled', !settings.notifications.tempHigh.enabled)}>
                    <div className="flex items-center gap-4">
                        <div className="p-2 bg-red-500/20 text-red-300 rounded-lg"><ThermometerIcon className="w-6 h-6" /></div>
                        <div>
                            <p className="text-white font-bold">Heat Alert</p>
                            <p className="text-[10px] text-gray-500 uppercase tracking-wide">High Temp</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-lg border border-white/10" onClick={e => e.stopPropagation()}>
                            <input type="number" value={settings.notifications.tempHigh.threshold} onChange={(e) => updateAlert('tempHigh', 'threshold', Number(e.target.value))} className="w-12 bg-transparent text-white text-right outline-none font-bold" />
                            <span className="text-xs text-gray-500">°</span>
                        </div>
                        <Toggle checked={settings.notifications.tempHigh.enabled} onChange={(v) => updateAlert('tempHigh', 'enabled', v)} />
                    </div>
                </Row>

                {/* 8. Freeze Alert */}
                <Row onClick={() => updateAlert('tempLow', 'enabled', !settings.notifications.tempLow.enabled)}>
                    <div className="flex items-center gap-4">
                        <div className="p-2 bg-cyan-500/20 text-cyan-300 rounded-lg"><ThermometerIcon className="w-6 h-6" /></div>
                        <div>
                            <p className="text-white font-bold">Freeze Alert</p>
                            <p className="text-[10px] text-gray-500 uppercase tracking-wide">Low Temp</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-lg border border-white/10" onClick={e => e.stopPropagation()}>
                            <span className="text-xs text-gray-500 mr-1">&lt;</span>
                            <input type="number" value={settings.notifications.tempLow.threshold} onChange={(e) => updateAlert('tempLow', 'threshold', Number(e.target.value))} className="w-12 bg-transparent text-white text-right outline-none font-bold" />
                            <span className="text-xs text-gray-500">°</span>
                        </div>
                        <Toggle checked={settings.notifications.tempLow.enabled} onChange={(v) => updateAlert('tempLow', 'enabled', v)} />
                    </div>
                </Row>

                {/* 9. Precipitation */}
                <Row onClick={() => updateAlert('precipitation', 'enabled', !settings.notifications.precipitation.enabled)}>
                    <div className="flex items-center gap-4">
                        <div className="p-2 bg-blue-500/20 text-blue-300 rounded-lg"><RainIcon className="w-6 h-6" /></div>
                        <div>
                            <p className="text-white font-bold">Precipitation</p>
                            <p className="text-[10px] text-gray-500 uppercase tracking-wide">Notify on rain/storm forecast</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-4">
                        <Toggle checked={settings.notifications.precipitation.enabled} onChange={(v) => updateAlert('precipitation', 'enabled', v)} />
                    </div>
                </Row>
            </Section>
        </div>
    );
};
