/**
 * VesselTab — Vessel configuration: type, name, dimensions, performance, capacity.
 * Extracted from SettingsModal monolith (63 lines → standalone component).
 */
import React, { useState, useEffect, useRef } from 'react';
import { Section, Row, type SettingsTabProps } from './SettingsPrimitives';
import { LengthUnit, WeightUnit, VolumeUnit, VesselDimensionUnits, VesselProfile } from '../../types';
import { YachtDatabaseSearch } from './YachtDatabaseSearch';
import type { PolarDatabaseEntry } from '../../data/polarDatabase';
import { Capacitor } from '@capacitor/core';

// ── MetricInput (vessel-specific helper) ─────────────────────
function MetricInput({
    label,
    valInStandard,
    unitType,
    standardUnit,
    unitOptions,
    onChangeValue,
    onChangeUnit,
    placeholder,
    isEstimated,
}: {
    label: string;
    valInStandard: number;
    unitType: string;
    standardUnit: string;
    unitOptions: string[];
    onChangeValue: (v: number) => void;
    onChangeUnit: (u: string) => void;
    placeholder?: string;
    isEstimated?: boolean;
}) {
    const conversions: Record<string, Record<string, (n: number) => number>> = {
        ft: { m: (n) => n * 0.3048, ft: (n) => n },
        m: { ft: (n) => n / 0.3048, m: (n) => n },
        lbs: { kg: (n) => n * 0.453592, tonnes: (n) => n * 0.000453592, lbs: (n) => n },
        kg: { lbs: (n) => n / 0.453592, tonnes: (n) => n / 1000, kg: (n) => n },
        tonnes: { lbs: (n) => n / 0.000453592, kg: (n) => n * 1000, tonnes: (n) => n },
        kts: { mph: (n) => n * 1.15078, kmh: (n) => n * 1.852, kts: (n) => n },
        mph: { kts: (n) => n / 1.15078, kmh: (n) => n * 1.60934, mph: (n) => n },
        kmh: { kts: (n) => n / 1.852, mph: (n) => n / 1.60934, kmh: (n) => n },
        gal: { l: (n) => n * 3.78541, gal: (n) => n },
        l: { gal: (n) => n / 3.78541, l: (n) => n },
    };

    // Convert from standard (stored) unit → display unit
    const toDisplay = conversions[standardUnit]?.[unitType];
    const displayVal = toDisplay ? toDisplay(valInStandard) : valInStandard;

    const [localVal, setLocalVal] = useState(displayVal > 0 ? String(Math.round(displayVal * 100) / 100) : '');

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => setLocalVal(e.target.value);

    const handleBlur = () => {
        const numericVal = parseFloat(localVal);
        if (isNaN(numericVal)) return;
        // Convert from display unit → standard (stored) unit
        const toStandard = conversions[unitType]?.[standardUnit];
        if (toStandard) {
            onChangeValue(Math.round(toStandard(numericVal) * 100) / 100);
        } else {
            onChangeValue(numericVal);
        }
    };

    return (
        <div>
            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                {label}
                {isEstimated && <span className="text-amber-400/70 ml-1 text-[11px]">(est.)</span>}
            </label>
            <div className="flex gap-1.5 min-w-0">
                <input
                    type="number"
                    value={localVal}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    placeholder={placeholder}
                    className={`flex-1 min-w-0 bg-white/5 border rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-none transition-colors ${isEstimated ? 'border-amber-500/30 focus:border-amber-400' : 'border-white/10 focus:border-sky-500'}`}
                />
                <select
                    value={unitType}
                    onChange={(e) => onChangeUnit(e.target.value)}
                    className="bg-white/5 border border-white/10 rounded-xl px-1.5 py-2.5 text-[11px] text-gray-400 font-bold uppercase outline-none focus:border-sky-500 shrink-0"
                >
                    {unitOptions.map((u) => (
                        <option key={u} value={u}>
                            {u}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    );
}

export const VesselTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const [saved, setSaved] = useState(false);
    const isObserver = settings.vessel?.type === 'observer';
    const scrollRef = useRef<HTMLDivElement>(null);
    const [keyboardHeight, setKeyboardHeight] = useState(0);

    // ── Keyboard tracking — same pattern as DiaryPage/OnboardingWizard ──
    useEffect(() => {
        let cleanup: (() => void) | undefined;

        if (Capacitor.isNativePlatform()) {
            import('@capacitor/keyboard')
                .then(({ Keyboard }) => {
                    const showHandle = Keyboard.addListener('keyboardDidShow', (info) => {
                        setKeyboardHeight(info.keyboardHeight > 0 ? info.keyboardHeight : 0);
                        setTimeout(() => {
                            const focused = document.activeElement as HTMLElement;
                            const container = scrollRef.current;
                            if (!focused || !container) return;
                            if (
                                focused.tagName !== 'INPUT' &&
                                focused.tagName !== 'TEXTAREA' &&
                                focused.tagName !== 'SELECT'
                            )
                                return;
                            const focusRect = focused.getBoundingClientRect();
                            const containerRect = container.getBoundingClientRect();
                            const offsetInContainer = focusRect.top - containerRect.top + container.scrollTop;
                            const targetScroll = offsetInContainer - containerRect.height * 0.3;
                            container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
                        }, 100);
                    });
                    const hideHandle = Keyboard.addListener('keyboardWillHide', () => {
                        setKeyboardHeight(0);
                    });
                    cleanup = () => {
                        showHandle.then((h) => h.remove());
                        hideHandle.then((h) => h.remove());
                    };
                })
                .catch(() => {
                    /* Keyboard plugin not available */
                });
        }

        return () => {
            cleanup?.();
            setKeyboardHeight(0);
        };
    }, []);

    const updateVessel = (field: string, value: string | number) => {
        let newEstimatedFields = settings.vessel?.estimatedFields;
        if (newEstimatedFields && newEstimatedFields.includes(field)) {
            newEstimatedFields = newEstimatedFields.filter((f) => f !== field);
        }
        onSave({
            vessel: {
                name: 'My Boat',
                type: 'sail',
                length: 30,
                beam: 10,
                draft: 5,
                displacement: 10000,
                maxWaveHeight: 6,
                cruisingSpeed: 6,
                fuelCapacity: 0,
                waterCapacity: 0,
                ...(settings.vessel || {}),
                estimatedFields: newEstimatedFields,
                [field]: value,
            },
        });
    };

    const handleYachtSelect = (entry: PolarDatabaseEntry) => {
        // Update vessel model + auto-fill LOA
        const currentVessel: Partial<VesselProfile> = settings.vessel || {};
        onSave({
            vessel: {
                name: currentVessel.name || 'My Boat',
                type: currentVessel.type || 'sail',
                beam: currentVessel.beam || Math.round(entry.loa * 0.32),
                draft: currentVessel.draft || Math.round(entry.loa * 0.16),
                displacement: currentVessel.displacement || Math.round(Math.pow(entry.loa, 3) / 2.5),
                maxWaveHeight: currentVessel.maxWaveHeight || Math.round(entry.loa * 0.35),
                cruisingSpeed: currentVessel.cruisingSpeed || Math.round(Math.sqrt(entry.loa) * 1.2 * 10) / 10,
                fuelCapacity: currentVessel.fuelCapacity || 0,
                waterCapacity: currentVessel.waterCapacity || 0,
                ...currentVessel,
                model: entry.model,
                length: entry.loa,
            },
            // Save polar data to settings (persisted via Capacitor Preferences)
            polarData: entry.polar,
            polarBoatModel: entry.model,
            polarSource_type: 'database',
        });
    };

    return (
        <div className="w-full h-full flex flex-col max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
            <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto overscroll-contain"
                style={{ paddingBottom: keyboardHeight > 0 ? `${keyboardHeight + 120}px` : 120 }}
            >
                {/* Observer upgrade banner */}
                {isObserver && (
                    <div className="mx-4 mb-4 bg-sky-500/[0.06] border border-sky-500/15 rounded-2xl p-4 animate-in fade-in slide-in-from-top-2">
                        <div className="flex items-start gap-3">
                            <span className="text-2xl">🔭</span>
                            <div>
                                <h4 className="text-sm font-bold text-sky-300 mb-1">Observer Mode Active</h4>
                                <p className="text-[11px] text-gray-400 leading-relaxed">
                                    You're currently in observer mode — weather only, no vessel features. Select{' '}
                                    <strong className="text-white">Sail</strong> or{' '}
                                    <strong className="text-white">Power</strong> below to unlock Passage Planning,
                                    Polars, and hydrostatics.
                                </p>
                            </div>
                        </div>
                    </div>
                )}

                <Section title="Vessel Configuration">
                    <Row>
                        <div>
                            <label className="text-sm text-white font-medium block">Vessel Type</label>
                        </div>
                        <div className="flex bg-black/40 p-1 rounded-lg border border-white/10">
                            <button
                                onClick={() => updateVessel('type', 'sail')}
                                className={`px-4 py-2 rounded-lg text-xs font-bold uppercase transition-all ${settings.vessel?.type === 'sail' ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                            >
                                Sail
                            </button>
                            <button
                                onClick={() => updateVessel('type', 'power')}
                                className={`px-4 py-2 rounded-lg text-xs font-bold uppercase transition-all ${settings.vessel?.type === 'power' ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                            >
                                Power
                            </button>
                        </div>
                    </Row>
                    <Row>
                        <div className={`w-full ${isObserver ? 'opacity-40' : ''}`}>
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2">
                                Vessel Name
                            </label>
                            <input
                                type="text"
                                value={isObserver ? '' : settings.vessel?.name || ''}
                                onChange={(e) => updateVessel('name', e.target.value)}
                                placeholder={isObserver ? 'Select Sail or Power first' : 'e.g. Black Pearl'}
                                disabled={isObserver}
                                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none text-sm font-medium disabled:cursor-not-allowed"
                            />
                        </div>
                    </Row>
                    <Row>
                        <div className="w-full">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2">
                                Hull Type
                            </label>
                            <div className="flex bg-black/40 p-1 rounded-lg border border-white/10 gap-0.5">
                                {(['monohull', 'catamaran', 'trimaran'] as const).map((ht) => (
                                    <button
                                        key={ht}
                                        onClick={() => updateVessel('hullType', ht)}
                                        className={`flex-1 px-2 py-2 rounded-lg text-xs font-bold uppercase transition-all ${settings.vessel?.hullType === ht ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                                    >
                                        {ht === 'monohull' ? 'Mono' : ht === 'catamaran' ? 'Cat' : 'Tri'}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </Row>
                    <Row>
                        <div className="w-full">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2">
                                Keel Type
                            </label>
                            <div className="grid grid-cols-3 bg-black/40 p-1 rounded-lg border border-white/10 gap-0.5">
                                {(['fin', 'full', 'wing', 'skeg', 'centerboard', 'bilge'] as const).map((kt) => (
                                    <button
                                        key={kt}
                                        onClick={() => updateVessel('keelType', kt)}
                                        className={`px-2 py-2 rounded-lg text-xs font-bold uppercase transition-all ${settings.vessel?.keelType === kt ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                                    >
                                        {kt === 'centerboard' ? 'C/Board' : kt}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </Row>
                </Section>

                {/* Yacht Database Search — replaces the old Make/Model text input */}
                <div className="mx-4 mb-4">
                    <YachtDatabaseSearch
                        selectedModel={settings.polarBoatModel || settings.vessel?.model}
                        onSelect={handleYachtSelect}
                    />
                </div>

                {/* Hull Dimensions */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-sky-500" />
                        <span className="text-[11px] font-bold text-sky-400 uppercase tracking-widest">
                            Hull Dimensions
                        </span>
                    </div>
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                            <MetricInput
                                label="Length"
                                valInStandard={settings.vessel?.length || 0}
                                standardUnit="ft"
                                unitType={settings.vesselUnits?.length || 'ft'}
                                unitOptions={['ft', 'm']}
                                onChangeValue={(v) => updateVessel('length', v)}
                                onChangeUnit={(u) =>
                                    onSave({
                                        vesselUnits: {
                                            ...settings.vesselUnits,
                                            length: u as LengthUnit,
                                        } as VesselDimensionUnits,
                                    })
                                }
                                placeholder="30"
                                isEstimated={settings.vessel?.estimatedFields?.includes('length')}
                            />
                            <MetricInput
                                label="Beam"
                                valInStandard={settings.vessel?.beam || 0}
                                standardUnit="ft"
                                unitType={settings.vesselUnits?.beam || 'ft'}
                                unitOptions={['ft', 'm']}
                                onChangeValue={(v) => updateVessel('beam', v)}
                                onChangeUnit={(u) =>
                                    onSave({
                                        vesselUnits: {
                                            ...settings.vesselUnits,
                                            beam: u as LengthUnit,
                                        } as VesselDimensionUnits,
                                    })
                                }
                                placeholder="10"
                                isEstimated={settings.vessel?.estimatedFields?.includes('beam')}
                            />
                            <MetricInput
                                label="Draft"
                                valInStandard={settings.vessel?.draft || 0}
                                standardUnit="ft"
                                unitType={settings.vesselUnits?.draft || 'ft'}
                                unitOptions={['ft', 'm']}
                                onChangeValue={(v) => updateVessel('draft', v)}
                                onChangeUnit={(u) =>
                                    onSave({
                                        vesselUnits: {
                                            ...settings.vesselUnits,
                                            draft: u as LengthUnit,
                                        } as VesselDimensionUnits,
                                    })
                                }
                                placeholder="5"
                                isEstimated={settings.vessel?.estimatedFields?.includes('draft')}
                            />
                            <MetricInput
                                label="Displacement"
                                valInStandard={settings.vessel?.displacement || 0}
                                standardUnit="lbs"
                                unitType={settings.vesselUnits?.displacement || 'lbs'}
                                unitOptions={['lbs', 'kg', 'tonnes']}
                                onChangeValue={(v) => updateVessel('displacement', v)}
                                onChangeUnit={(u) =>
                                    onSave({
                                        vesselUnits: {
                                            ...settings.vesselUnits,
                                            displacement: u as WeightUnit,
                                        } as VesselDimensionUnits,
                                    })
                                }
                                placeholder="10000"
                                isEstimated={settings.vessel?.estimatedFields?.includes('displacement')}
                            />
                            <MetricInput
                                label="Air Draft"
                                valInStandard={settings.vessel?.airDraft || 0}
                                standardUnit="ft"
                                unitType={settings.vesselUnits?.length || 'ft'}
                                unitOptions={['ft', 'm']}
                                onChangeValue={(v) => updateVessel('airDraft', v)}
                                onChangeUnit={(u) =>
                                    onSave({
                                        vesselUnits: {
                                            ...settings.vesselUnits,
                                            length: u as LengthUnit,
                                        } as VesselDimensionUnits,
                                    })
                                }
                                placeholder="50"
                            />
                        </div>
                    </div>
                </div>

                {/* Performance (auto-calculated — read-only) */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-emerald-500" />
                        <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-widest">
                            Performance (Auto)
                        </span>
                    </div>
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                    Cruising Speed
                                </label>
                                <p className="text-white text-sm font-medium bg-white/5 border border-white/10 rounded-xl px-3 py-2.5">
                                    {Math.round((settings.vessel?.cruisingSpeed || 0) * 10) / 10} kts
                                </p>
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                    Max Wave Height
                                </label>
                                <p className="text-white text-sm font-medium bg-white/5 border border-white/10 rounded-xl px-3 py-2.5">
                                    {Math.round((settings.vessel?.maxWaveHeight || 0) * 10) / 10} ft
                                </p>
                            </div>
                        </div>
                        <p className="text-[11px] text-gray-400 mt-3">
                            Auto-calculated from vessel length and hull type
                        </p>
                    </div>
                </div>

                {/* Comfort Zone — Safety Parameters */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-red-500" />
                        <span className="text-[11px] font-bold text-red-400 uppercase tracking-widest">
                            Comfort Zone
                        </span>
                        <span className="text-[11px] text-gray-400 ml-auto">Passage Safety Limits</span>
                    </div>
                    <div className="bg-red-500/[0.03] border border-red-500/10 rounded-2xl p-4 space-y-5">
                        <p className="text-[11px] text-gray-400 leading-relaxed">
                            Set your crew's comfort thresholds. The passage planner will route around zones that exceed
                            these limits, treating them as obstacles.
                        </p>

                        {/* Max Wind Speed */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                                    Max Wind
                                </label>
                                <span
                                    className={`text-sm font-bold tabular-nums ${(settings.comfortParams?.maxWindKts ?? 60) >= 60 ? 'text-gray-400' : 'text-red-400'}`}
                                >
                                    {(settings.comfortParams?.maxWindKts ?? 60) >= 60
                                        ? 'OFF'
                                        : `${settings.comfortParams?.maxWindKts} kts`}
                                </span>
                            </div>
                            <input
                                type="range"
                                min={10}
                                max={60}
                                step={1}
                                value={settings.comfortParams?.maxWindKts ?? 60}
                                onChange={(e) => {
                                    const v = parseInt(e.target.value);
                                    onSave({
                                        comfortParams: {
                                            ...settings.comfortParams,
                                            maxWindKts: v >= 60 ? undefined : v,
                                        },
                                    });
                                }}
                                className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-red-500"
                                style={{
                                    background: `linear-gradient(to right, #ef4444 0%, #ef4444 ${(((settings.comfortParams?.maxWindKts ?? 60) - 10) / 50) * 100}%, rgba(255,255,255,0.1) ${(((settings.comfortParams?.maxWindKts ?? 60) - 10) / 50) * 100}%)`,
                                }}
                            />
                            <div className="flex justify-between text-[11px] text-gray-600 mt-1">
                                <span>10 kts</span>
                                <span>25</span>
                                <span>40</span>
                                <span>OFF</span>
                            </div>
                        </div>

                        {/* Max Wave Height */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                                    Max Wave Height
                                </label>
                                <span
                                    className={`text-sm font-bold tabular-nums ${(settings.comfortParams?.maxWaveM ?? 8) >= 8 ? 'text-gray-400' : 'text-red-400'}`}
                                >
                                    {(settings.comfortParams?.maxWaveM ?? 8) >= 8
                                        ? 'OFF'
                                        : `${settings.comfortParams?.maxWaveM?.toFixed(1)} m`}
                                </span>
                            </div>
                            <input
                                type="range"
                                min={0.5}
                                max={8}
                                step={0.5}
                                value={settings.comfortParams?.maxWaveM ?? 8}
                                onChange={(e) => {
                                    const v = parseFloat(e.target.value);
                                    onSave({
                                        comfortParams: { ...settings.comfortParams, maxWaveM: v >= 8 ? undefined : v },
                                    });
                                }}
                                className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-red-500"
                                style={{
                                    background: `linear-gradient(to right, #ef4444 0%, #ef4444 ${(((settings.comfortParams?.maxWaveM ?? 8) - 0.5) / 7.5) * 100}%, rgba(255,255,255,0.1) ${(((settings.comfortParams?.maxWaveM ?? 8) - 0.5) / 7.5) * 100}%)`,
                                }}
                            />
                            <div className="flex justify-between text-[11px] text-gray-600 mt-1">
                                <span>0.5 m</span>
                                <span>2.5</span>
                                <span>5.0</span>
                                <span>OFF</span>
                            </div>
                        </div>

                        {/* Max Gust */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                                    Max Gust
                                </label>
                                <span
                                    className={`text-sm font-bold tabular-nums ${(settings.comfortParams?.maxGustKts ?? 80) >= 80 ? 'text-gray-400' : 'text-red-400'}`}
                                >
                                    {(settings.comfortParams?.maxGustKts ?? 80) >= 80
                                        ? 'OFF'
                                        : `${settings.comfortParams?.maxGustKts} kts`}
                                </span>
                            </div>
                            <input
                                type="range"
                                min={15}
                                max={80}
                                step={1}
                                value={settings.comfortParams?.maxGustKts ?? 80}
                                onChange={(e) => {
                                    const v = parseInt(e.target.value);
                                    onSave({
                                        comfortParams: {
                                            ...settings.comfortParams,
                                            maxGustKts: v >= 80 ? undefined : v,
                                        },
                                    });
                                }}
                                className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-red-500"
                                style={{
                                    background: `linear-gradient(to right, #ef4444 0%, #ef4444 ${(((settings.comfortParams?.maxGustKts ?? 80) - 15) / 65) * 100}%, rgba(255,255,255,0.1) ${(((settings.comfortParams?.maxGustKts ?? 80) - 15) / 65) * 100}%)`,
                                }}
                            />
                            <div className="flex justify-between text-[11px] text-gray-600 mt-1">
                                <span>15 kts</span>
                                <span>35</span>
                                <span>55</span>
                                <span>OFF</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Capacity */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-amber-500" />
                        <span className="text-[11px] font-bold text-amber-400 uppercase tracking-widest">Capacity</span>
                    </div>
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                            <MetricInput
                                label="Fuel Cap."
                                valInStandard={settings.vessel?.fuelCapacity || 0}
                                standardUnit="gal"
                                unitType={settings.vesselUnits?.volume || 'gal'}
                                unitOptions={['gal', 'l']}
                                onChangeValue={(v) => updateVessel('fuelCapacity', v)}
                                onChangeUnit={(u) =>
                                    onSave({
                                        vesselUnits: {
                                            ...settings.vesselUnits,
                                            volume: u as VolumeUnit,
                                        } as VesselDimensionUnits,
                                    })
                                }
                                placeholder="0"
                            />
                            <MetricInput
                                label="Water Cap."
                                valInStandard={settings.vessel?.waterCapacity || 0}
                                standardUnit="gal"
                                unitType={settings.vesselUnits?.volume || 'gal'}
                                unitOptions={['gal', 'l']}
                                onChangeValue={(v) => updateVessel('waterCapacity', v)}
                                onChangeUnit={(u) =>
                                    onSave({
                                        vesselUnits: {
                                            ...settings.vesselUnits,
                                            volume: u as VolumeUnit,
                                        } as VesselDimensionUnits,
                                    })
                                }
                                placeholder="0"
                            />
                        </div>
                        <div className="mt-4">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                Crew Aboard (incl. Captain)
                            </label>
                            <input
                                type="number"
                                min="1"
                                max="99"
                                value={settings.vessel?.crewCount || 2}
                                onChange={(e) => updateVessel('crewCount', parseInt(e.target.value) || 2)}
                                placeholder="2"
                                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm font-medium outline-none transition-colors focus:border-sky-500"
                            />
                            <p className="text-[11px] text-gray-400 mt-1">
                                Used for provisioning and watch scheduling in passage plans
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Save CTA — pinned above tab bar */}
            <div
                className="shrink-0 z-20 px-4"
                style={{
                    paddingTop: 8,
                    paddingBottom: 'calc(8px + env(safe-area-inset-bottom))',
                    background: 'linear-gradient(to top, rgba(2, 6, 23, 0.97) 60%, rgba(2, 6, 23, 0) 100%)',
                }}
            >
                <button
                    onClick={() => {
                        setSaved(true);
                        setTimeout(() => setSaved(false), 2000);
                        // Settings are already auto-saved via onSave calls above,
                        // this button is UX reassurance for the user
                    }}
                    className={`w-full py-3.5 rounded-xl text-sm font-black uppercase tracking-[0.15em] transition-all active:scale-[0.97] ${
                        saved
                            ? 'bg-gradient-to-r from-emerald-600 to-emerald-600 text-white shadow-lg shadow-emerald-500/20'
                            : 'bg-gradient-to-r from-sky-600 to-sky-600 text-white shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500'
                    }`}
                >
                    {saved ? '✓ Profile Saved' : 'Save Vessel Profile'}
                </button>
            </div>
        </div>
    );
};
