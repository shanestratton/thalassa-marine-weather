/**
 * VesselTab — Vessel configuration: type, name, dimensions, performance, capacity.
 * Extracted from SettingsModal monolith (63 lines → standalone component).
 */
import React, { useState } from 'react';
import { Section, Row, type SettingsTabProps } from './SettingsPrimitives';
import { LengthUnit, WeightUnit, SpeedUnit, VolumeUnit, VesselDimensionUnits } from '../../types';

// ── MetricInput (vessel-specific helper) ─────────────────────
function MetricInput({ label, valInStandard, unitType, unitOptions, onChangeValue, onChangeUnit, placeholder, isEstimated }: {
    label: string; valInStandard: number; unitType: string; unitOptions: string[];
    onChangeValue: (v: number) => void; onChangeUnit: (u: string) => void;
    placeholder?: string; isEstimated?: boolean;
}) {
    const conversions: Record<string, Record<string, (n: number) => number>> = {
        ft: { m: n => n * 0.3048, ft: n => n },
        m: { ft: n => n / 0.3048, m: n => n },
        lbs: { kg: n => n * 0.453592, tonnes: n => n * 0.000453592, lbs: n => n },
        kg: { lbs: n => n / 0.453592, tonnes: n => n / 1000, kg: n => n },
        tonnes: { lbs: n => n / 0.000453592, kg: n => n * 1000, tonnes: n => n },
        kts: { mph: n => n * 1.15078, kmh: n => n * 1.852, kts: n => n },
        mph: { kts: n => n / 1.15078, kmh: n => n * 1.60934, mph: n => n },
        kmh: { kts: n => n / 1.852, mph: n => n / 1.60934, kmh: n => n },
        gal: { l: n => n * 3.78541, gal: n => n },
        l: { gal: n => n / 3.78541, l: n => n },
    };

    const displayVal = conversions[unitType]?.[unitType]
        ? conversions['ft']?.[unitType]?.(valInStandard) ?? valInStandard
        : valInStandard;

    const [localVal, setLocalVal] = useState(displayVal > 0 ? String(Math.round(displayVal * 100) / 100) : '');

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => setLocalVal(e.target.value);

    const handleBlur = () => {
        const numericVal = parseFloat(localVal);
        if (isNaN(numericVal)) return;
        const toStandard = conversions[unitType]?.['ft'] || conversions[unitType]?.['lbs'] || conversions[unitType]?.['kts'] || conversions[unitType]?.['gal'];
        if (toStandard) {
            onChangeValue(Math.round(toStandard(numericVal) * 100) / 100);
        } else {
            onChangeValue(numericVal);
        }
    };

    return (
        <div>
            <label className="text-xs font-bold text-gray-500 uppercase tracking-widest block mb-1.5">
                {label}
                {isEstimated && <span className="text-amber-400/70 ml-1 text-[9px]">(est.)</span>}
            </label>
            <div className="flex gap-2 min-w-0">
                <input
                    type="number"
                    value={localVal}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    placeholder={placeholder}
                    className={`flex-1 min-w-0 bg-white/5 border rounded-xl px-3 py-2.5 text-white text-sm font-medium outline-none transition-colors ${isEstimated ? 'border-amber-500/30 focus:border-amber-400' : 'border-white/10 focus:border-sky-500'}`}
                />
                <select
                    value={unitType}
                    onChange={(e) => onChangeUnit(e.target.value)}
                    className="bg-white/5 border border-white/10 rounded-xl px-2 py-2.5 text-xs text-gray-400 font-bold uppercase outline-none focus:border-sky-500"
                >
                    {unitOptions.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
            </div>
        </div>
    );
}

export const VesselTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const updateVessel = (field: string, value: string | number) => {
        let newEstimatedFields = settings.vessel?.estimatedFields;
        if (newEstimatedFields && newEstimatedFields.includes(field)) {
            newEstimatedFields = newEstimatedFields.filter(f => f !== field);
        }
        onSave({
            vessel: {
                name: 'My Boat', type: 'sail', length: 30, beam: 10, draft: 5, displacement: 10000,
                maxWaveHeight: 6, cruisingSpeed: 6, fuelCapacity: 0, waterCapacity: 0,
                ...(settings.vessel || {}),
                estimatedFields: newEstimatedFields,
                [field]: value
            }
        });
    };

    return (
        <div className="w-full max-w-2xl mx-auto overflow-hidden animate-in fade-in slide-in-from-right-4 duration-300">
            <Section title="Vessel Configuration">
                <Row>
                    <div><label className="text-sm text-white font-medium block">Vessel Type</label></div>
                    <div className="flex bg-black/40 p-1 rounded-lg border border-white/10">
                        <button onClick={() => updateVessel('type', 'sail')} className={`px-4 py-2 rounded-md text-xs font-bold uppercase transition-all ${settings.vessel?.type === 'sail' ? 'bg-sky-600 text-white' : 'text-gray-400'}`}>Sail</button>
                        <button onClick={() => updateVessel('type', 'power')} className={`px-4 py-2 rounded-md text-xs font-bold uppercase transition-all ${settings.vessel?.type === 'power' ? 'bg-sky-600 text-white' : 'text-gray-400'}`}>Power</button>
                    </div>
                </Row>
                <Row>
                    <div className="w-full">
                        <label className="text-xs font-bold text-gray-500 uppercase tracking-widest block mb-2">Vessel Name</label>
                        <input type="text" value={settings.vessel?.name || ''} onChange={(e) => updateVessel('name', e.target.value)} placeholder="e.g. Black Pearl" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none text-sm font-medium" />
                    </div>
                </Row>
                <Row>
                    <div className="w-full">
                        <label className="text-xs font-bold text-gray-500 uppercase tracking-widest block mb-2">Make / Model</label>
                        <input type="text" value={settings.vessel?.model || ''} onChange={(e) => updateVessel('model', e.target.value)} placeholder="e.g. Tayana 55" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none text-sm font-medium" />
                    </div>
                </Row>
            </Section>

            {/* Hull Dimensions */}
            <div className="mx-4 mb-4">
                <div className="flex items-center gap-2 mb-3">
                    <div className="w-1 h-4 rounded-full bg-sky-500" />
                    <span className="text-[10px] font-bold text-sky-400 uppercase tracking-widest">Hull Dimensions</span>
                </div>
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
                    <div className="grid grid-cols-2 gap-x-5 gap-y-4">
                        <MetricInput label="Length" valInStandard={settings.vessel?.length || 0} unitType={settings.vesselUnits?.length || 'ft'} unitOptions={['ft', 'm']} onChangeValue={(v) => updateVessel('length', v)} onChangeUnit={(u) => onSave({ vesselUnits: { ...settings.vesselUnits, length: u as LengthUnit } as VesselDimensionUnits })} placeholder="30" isEstimated={settings.vessel?.estimatedFields?.includes('length')} />
                        <MetricInput label="Beam" valInStandard={settings.vessel?.beam || 0} unitType={settings.vesselUnits?.beam || 'ft'} unitOptions={['ft', 'm']} onChangeValue={(v) => updateVessel('beam', v)} onChangeUnit={(u) => onSave({ vesselUnits: { ...settings.vesselUnits, beam: u as LengthUnit } as VesselDimensionUnits })} placeholder="10" isEstimated={settings.vessel?.estimatedFields?.includes('beam')} />
                        <MetricInput label="Draft" valInStandard={settings.vessel?.draft || 0} unitType={settings.vesselUnits?.draft || 'ft'} unitOptions={['ft', 'm']} onChangeValue={(v) => updateVessel('draft', v)} onChangeUnit={(u) => onSave({ vesselUnits: { ...settings.vesselUnits, draft: u as LengthUnit } as VesselDimensionUnits })} placeholder="5" isEstimated={settings.vessel?.estimatedFields?.includes('draft')} />
                        <MetricInput label="Displacement" valInStandard={settings.vessel?.displacement || 0} unitType={settings.vesselUnits?.displacement || 'lbs'} unitOptions={['lbs', 'kg', 'tonnes']} onChangeValue={(v) => updateVessel('displacement', v)} onChangeUnit={(u) => onSave({ vesselUnits: { ...settings.vesselUnits, displacement: u as WeightUnit } as VesselDimensionUnits })} placeholder="10000" isEstimated={settings.vessel?.estimatedFields?.includes('displacement')} />
                        <MetricInput label="Mast Height" valInStandard={settings.vessel?.mastHeight || 0} unitType={settings.vesselUnits?.length || 'ft'} unitOptions={['ft', 'm']} onChangeValue={(v) => updateVessel('mastHeight', v)} onChangeUnit={(u) => onSave({ vesselUnits: { ...settings.vesselUnits, length: u as LengthUnit } as VesselDimensionUnits })} placeholder="50" />
                    </div>
                </div>
            </div>

            {/* Performance */}
            <div className="mx-4 mb-4">
                <div className="flex items-center gap-2 mb-3">
                    <div className="w-1 h-4 rounded-full bg-emerald-500" />
                    <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest">Performance</span>
                </div>
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
                    <div className="grid grid-cols-2 gap-x-5 gap-y-4">
                        <MetricInput label="Cruising Speed" valInStandard={settings.vessel?.cruisingSpeed || 0} unitType={settings.units.speed || 'kts'} unitOptions={['kts', 'mph', 'kmh']} onChangeValue={(v) => updateVessel('cruisingSpeed', v)} onChangeUnit={(u) => onSave({ units: { ...settings.units, speed: u as SpeedUnit } })} placeholder="6" />
                        <MetricInput label="Max Wave Height" valInStandard={settings.vessel?.maxWaveHeight || 0} unitType={settings.vesselUnits?.length || 'ft'} unitOptions={['ft', 'm']} onChangeValue={(v) => updateVessel('maxWaveHeight', v)} onChangeUnit={(u) => onSave({ vesselUnits: { ...settings.vesselUnits, length: u as LengthUnit } as VesselDimensionUnits })} placeholder="10" />
                    </div>
                </div>
            </div>

            {/* Capacity */}
            <div className="mx-4 mb-4">
                <div className="flex items-center gap-2 mb-3">
                    <div className="w-1 h-4 rounded-full bg-amber-500" />
                    <span className="text-[10px] font-bold text-amber-400 uppercase tracking-widest">Capacity</span>
                </div>
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
                    <div className="grid grid-cols-2 gap-x-5 gap-y-4">
                        <MetricInput label="Fuel Cap." valInStandard={settings.vessel?.fuelCapacity || 0} unitType={settings.vesselUnits?.volume || 'gal'} unitOptions={['gal', 'l']} onChangeValue={(v) => updateVessel('fuelCapacity', v)} onChangeUnit={(u) => onSave({ vesselUnits: { ...settings.vesselUnits, volume: u as VolumeUnit } as VesselDimensionUnits })} placeholder="0" />
                        <MetricInput label="Water Cap." valInStandard={settings.vessel?.waterCapacity || 0} unitType={settings.vesselUnits?.volume || 'gal'} unitOptions={['gal', 'l']} onChangeValue={(v) => updateVessel('waterCapacity', v)} onChangeUnit={(u) => onSave({ vesselUnits: { ...settings.vesselUnits, volume: u as VolumeUnit } as VesselDimensionUnits })} placeholder="0" />
                    </div>
                    <div className="mt-4">
                        <label className="text-xs font-bold text-gray-500 uppercase tracking-widest block mb-1.5">Crew Aboard (incl. Captain)</label>
                        <input type="number" min="1" max="99" value={settings.vessel?.crewCount || 2} onChange={(e) => updateVessel('crewCount', parseInt(e.target.value) || 2)} placeholder="2" className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm font-medium outline-none transition-colors focus:border-sky-500" />
                        <p className="text-[10px] text-gray-500 mt-1">Used for provisioning and watch scheduling in passage plans</p>
                    </div>
                </div>
            </div>
        </div>
    );
};
