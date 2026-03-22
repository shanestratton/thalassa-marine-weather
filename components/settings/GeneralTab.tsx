/**
 * GeneralTab — Preferences panel: units, default location, legal, factory reset.
 * Extracted from SettingsModal to reduce component size.
 */
import React from 'react';
import { Section, Row, type SettingsTabProps } from './SettingsPrimitives';
import { CompassIcon, ArrowRightIcon, TrashIcon } from '../Icons';
import type { LengthUnit } from '../../types';

interface GeneralTabProps extends SettingsTabProps {
    onLocationSelect: (location: string) => void;
    onDetectLocation: () => void;
    onShowFactoryReset: () => void;
}

export const GeneralTab: React.FC<GeneralTabProps> = ({ settings, onSave, onDetectLocation, onShowFactoryReset }) => {
    const updateUnit = (type: keyof typeof settings.units, value: string) => {
        onSave({ units: { ...settings.units, [type]: value } });
    };

    return (
        <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
            <Section title="Location & Time">
                <Row>
                    <div className="flex-1">
                        <label className="text-sm text-white font-medium block">Default Port</label>
                    </div>
                    <div className="flex gap-2">
                        <div className="relative">
                            <input
                                type="text"
                                value={settings.defaultLocation || ''}
                                onChange={(e) => onSave({ defaultLocation: e.target.value })}
                                className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm w-48"
                                placeholder="City, Country"
                            />
                        </div>
                        <button
                            onClick={onDetectLocation}
                            className="p-2 bg-sky-500/20 text-sky-400 rounded-lg"
                            aria-label="Detect current location"
                        >
                            <CompassIcon rotation={0} className="w-4 h-4" />
                        </button>
                    </div>
                </Row>
            </Section>

            <Section title="Units">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-4">
                    {/* Speed */}
                    <div>
                        <label className="text-xs text-gray-300 uppercase font-bold mb-1 block">Wind Speed</label>
                        <select
                            value={settings.units.speed}
                            onChange={(e) => updateUnit('speed', e.target.value)}
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                        >
                            <option value="kts">Knots</option>
                            <option value="mph">MPH</option>
                            <option value="kmh">KM/H</option>
                            <option value="mps">M/S</option>
                        </select>
                    </div>
                    {/* Distance */}
                    <div>
                        <label className="text-xs text-gray-300 uppercase font-bold mb-1 block">Distance</label>
                        <select
                            value={settings.units.distance}
                            onChange={(e) => updateUnit('distance', e.target.value)}
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                        >
                            <option value="nm">Nautical Miles</option>
                            <option value="mi">Miles</option>
                            <option value="km">Kilometers</option>
                        </select>
                    </div>
                    {/* Seas (Wave Height) */}
                    <div>
                        <label className="text-xs text-gray-300 uppercase font-bold mb-1 block">
                            Seas (Wave Height)
                        </label>
                        <select
                            value={settings.units.waveHeight || 'm'}
                            onChange={(e) => updateUnit('waveHeight', e.target.value)}
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                        >
                            <option value="m">Meters</option>
                            <option value="ft">Feet</option>
                        </select>
                    </div>
                    {/* Tides / Length */}
                    <div>
                        <label className="text-xs text-gray-300 uppercase font-bold mb-1 block">Tides / Length</label>
                        <select
                            value={settings.units.length}
                            onChange={(e) => {
                                const val = e.target.value;
                                onSave({
                                    units: {
                                        ...settings.units,
                                        length: val as LengthUnit,
                                        tideHeight: val as LengthUnit,
                                    },
                                });
                            }}
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                        >
                            <option value="ft">Feet</option>
                            <option value="m">Meters</option>
                        </select>
                    </div>
                    {/* Temperature */}
                    <div>
                        <label className="text-xs text-gray-300 uppercase font-bold mb-1 block">Temperature</label>
                        <select
                            value={settings.units.temp}
                            onChange={(e) => updateUnit('temp', e.target.value)}
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                        >
                            <option value="C">Celsius</option>
                            <option value="F">Fahrenheit</option>
                        </select>
                    </div>
                    {/* Visibility */}
                    <div>
                        <label className="text-xs text-gray-300 uppercase font-bold mb-1 block">Visibility</label>
                        <select
                            value={settings.units.visibility || 'nm'}
                            onChange={(e) => updateUnit('visibility', e.target.value)}
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                        >
                            <option value="nm">Nautical Miles</option>
                            <option value="mi">Miles</option>
                            <option value="km">Kilometers</option>
                        </select>
                    </div>
                    {/* Volume */}
                    <div>
                        <label className="text-xs text-gray-300 uppercase font-bold mb-1 block">Liquid Volume</label>
                        <select
                            value={settings.units.volume || 'gal'}
                            onChange={(e) => updateUnit('volume', e.target.value)}
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                        >
                            <option value="gal">Gallons</option>
                            <option value="l">Liters</option>
                        </select>
                    </div>
                </div>
            </Section>
            <Section title="Legal">
                <div className="p-4">
                    <button
                        aria-label="Action"
                        onClick={() => window.open('/terms.html', '_blank')}
                        className="w-full flex items-center gap-3 p-3 bg-white/[0.03] border border-white/5 rounded-xl hover:bg-white/[0.07] hover:border-white/10 transition-all active:scale-[0.98] text-left"
                    >
                        <div className="p-2 bg-white/5 rounded-lg">
                            <svg
                                className="w-4 h-4 text-gray-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                                />
                            </svg>
                        </div>
                        <div className="flex-1">
                            <p className="text-sm text-white font-bold">Terms of Service & Privacy Policy</p>
                            <p className="text-xs text-gray-300 mt-0.5">
                                View our terms, conditions, and data practices
                            </p>
                        </div>
                        <ArrowRightIcon className="w-4 h-4 text-gray-400" />
                    </button>
                </div>
            </Section>
            <Section title="Danger Zone">
                <div className="p-4">
                    <button
                        aria-label="Reset"
                        onClick={onShowFactoryReset}
                        className="w-full py-3 bg-red-500/10 text-red-400 rounded-xl text-xs font-bold uppercase flex items-center justify-center gap-2"
                    >
                        <TrashIcon className="w-4 h-4" /> Factory Reset
                    </button>
                </div>
            </Section>
        </div>
    );
};
