/**
 * VesselDetailsStep — Onboarding Step 5: Vessel config form.
 * Collects hull type, keel, rigging, dimensions, tankage, crew.
 */
import React from 'react';
import { SearchIcon, GearIcon, DropletIcon, AnchorIcon } from '../Icons';
import { YachtDatabaseSearch } from '../settings/YachtDatabaseSearch';
import type { VesselProfile, LengthUnit, WeightUnit, VolumeUnit } from '../../types';
import type { PolarDatabaseEntry } from '../../data/polarDatabase';

interface VesselDetailsStepProps {
    vesselType: 'sail' | 'power' | 'observer';
    // Vessel identity
    name: string;
    onNameChange: (v: string) => void;
    // Hull / keel / rigging
    hullType: 'monohull' | 'catamaran' | 'trimaran';
    onHullTypeChange: (v: 'monohull' | 'catamaran' | 'trimaran') => void;
    keelType: 'fin' | 'full' | 'wing' | 'skeg' | 'centerboard' | 'bilge';
    onKeelTypeChange: (v: 'fin' | 'full' | 'wing' | 'skeg' | 'centerboard' | 'bilge') => void;
    riggingType: VesselProfile['riggingType'] & string;
    onRiggingTypeChange: (v: VesselProfile['riggingType'] & string) => void;
    // Dimensions
    length: string;
    onLengthChange: (v: string) => void;
    lengthUnit: LengthUnit;
    onToggleLengthUnit: () => void;
    beam: string;
    onBeamChange: (v: string) => void;
    beamUnit: LengthUnit;
    onToggleBeamUnit: () => void;
    draft: string;
    onDraftChange: (v: string) => void;
    draftUnit: LengthUnit;
    onToggleDraftUnit: () => void;
    displacement: string;
    onDisplacementChange: (v: string) => void;
    dispUnit: WeightUnit;
    onToggleDispUnit: () => void;
    airDraft: string;
    onAirDraftChange: (v: string) => void;
    airDraftUnit: LengthUnit;
    onToggleAirDraftUnit: () => void;
    // Tankage
    fuel: string;
    onFuelChange: (v: string) => void;
    water: string;
    onWaterChange: (v: string) => void;
    volUnit: VolumeUnit;
    onToggleVolUnit: () => void;
    crewCount: string;
    onCrewCountChange: (v: string) => void;
    // Polar / yacht DB
    selectedPolarModel?: string;
    onYachtSelect: (entry: PolarDatabaseEntry) => void;
    // Keyboard
    keyboardHeight: number;
    // Navigation
    onNext: () => void;
}

const INPUT_CLASS =
    'w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none font-mono placeholder-gray-500';

const UnitToggle: React.FC<{ value: string; onClick: () => void }> = ({ value, onClick }) => (
    <button aria-label="Click" onClick={onClick} className="text-sky-400 hover:text-white uppercase">
        {value}
    </button>
);

export const VesselDetailsStep: React.FC<VesselDetailsStepProps> = React.memo(
    ({
        vesselType,
        name,
        onNameChange,
        hullType,
        onHullTypeChange,
        keelType,
        onKeelTypeChange,
        riggingType,
        onRiggingTypeChange,
        length,
        onLengthChange,
        lengthUnit,
        onToggleLengthUnit,
        beam,
        onBeamChange,
        beamUnit,
        onToggleBeamUnit,
        draft,
        onDraftChange,
        draftUnit,
        onToggleDraftUnit,
        displacement,
        onDisplacementChange,
        dispUnit,
        onToggleDispUnit,
        airDraft,
        onAirDraftChange,
        airDraftUnit,
        onToggleAirDraftUnit,
        fuel,
        onFuelChange,
        water,
        onWaterChange,
        volUnit,
        onToggleVolUnit,
        crewCount,
        onCrewCountChange,
        selectedPolarModel,
        onYachtSelect,
        keyboardHeight,
        onNext,
    }) => (
        <div
            className="animate-in fade-in slide-in-from-right-8 duration-500 max-h-[calc(100dvh-10rem)] overflow-y-auto no-scrollbar"
            style={{ paddingBottom: keyboardHeight > 0 ? `${keyboardHeight}px` : undefined }}
        >
            {vesselType === 'observer' ? (
                <div className="text-center py-10">
                    <SearchIcon className="w-16 h-16 text-gray-400 mx-auto mb-4" />
                    <h2 className="text-xl font-bold text-white mb-2">Just Watching?</h2>
                    <p className="text-gray-400 mb-8">
                        Observers skip vessel setup. We&apos;ll optimize the display for general sea state conditions.
                    </p>
                    <button
                        aria-label="Next"
                        onClick={onNext}
                        className="w-full bg-sky-500 hover:bg-sky-400 text-white font-bold py-4 rounded-xl transition-all"
                    >
                        Continue to Preferences
                    </button>
                </div>
            ) : (
                <>
                    <h2 className="text-2xl font-bold text-white mb-2 text-center">Tell us about your boat</h2>
                    <p className="text-sm text-gray-400 text-center mb-6">
                        Search our database or enter details manually.
                    </p>

                    {/* Yacht Database Search */}
                    <div className="mb-6">
                        <YachtDatabaseSearch selectedModel={selectedPolarModel} onSelect={onYachtSelect} compact />
                    </div>

                    <div className="space-y-6">
                        <div>
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2">
                                Vessel Name
                            </label>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => onNameChange(e.target.value)}
                                placeholder="e.g. Black Pearl"
                                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none text-lg font-medium"
                            />
                        </div>

                        {/* Hull Type */}
                        <div>
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2">
                                Hull Type
                            </label>
                            <div className="flex bg-white/5 p-1 rounded-xl border border-white/10 gap-1">
                                {(['monohull', 'catamaran', 'trimaran'] as const).map((ht) => (
                                    <button
                                        aria-label="Hull Type Change"
                                        key={ht}
                                        onClick={() => onHullTypeChange(ht)}
                                        className={`flex-1 py-2.5 rounded-lg text-xs font-bold uppercase transition-all ${hullType === ht ? 'bg-sky-500 text-white' : 'text-gray-400'}`}
                                    >
                                        {ht === 'monohull' ? 'Mono' : ht === 'catamaran' ? 'Cat' : 'Tri'}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Keel Type */}
                        <div>
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2">
                                Keel Type
                            </label>
                            <div className="grid grid-cols-3 bg-white/5 p-1 rounded-xl border border-white/10 gap-1">
                                {(['fin', 'full', 'wing', 'skeg', 'centerboard', 'bilge'] as const).map((kt) => (
                                    <button
                                        aria-label="Keel Type Change"
                                        key={kt}
                                        onClick={() => onKeelTypeChange(kt)}
                                        className={`py-2.5 rounded-lg text-xs font-bold uppercase transition-all ${keelType === kt ? 'bg-sky-500 text-white' : 'text-gray-400'}`}
                                    >
                                        {kt === 'centerboard' ? 'C/Board' : kt}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {vesselType === 'sail' && (
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2">
                                    Rigging Type
                                </label>
                                <select
                                    value={riggingType}
                                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                                        onRiggingTypeChange(e.target.value as VesselProfile['riggingType'] & string)
                                    }
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none appearance-none"
                                >
                                    {['Sloop', 'Cutter', 'Ketch', 'Yawl', 'Schooner', 'Catboat', 'Solent', 'Other'].map(
                                        (r) => (
                                            <option key={r} value={r} className="bg-slate-900">
                                                {r}
                                            </option>
                                        ),
                                    )}
                                </select>
                            </div>
                        )}

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2 flex justify-between">
                                    Length <UnitToggle value={lengthUnit} onClick={onToggleLengthUnit} />
                                </label>
                                <input
                                    type="number"
                                    value={length}
                                    onChange={(e) => onLengthChange(e.target.value)}
                                    placeholder="0"
                                    className={INPUT_CLASS}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2 flex justify-between">
                                    Beam <UnitToggle value={beamUnit} onClick={onToggleBeamUnit} />
                                </label>
                                <input
                                    type="number"
                                    value={beam}
                                    onChange={(e) => onBeamChange(e.target.value)}
                                    placeholder="Auto"
                                    className={INPUT_CLASS}
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2 flex justify-between">
                                    Draft <UnitToggle value={draftUnit} onClick={onToggleDraftUnit} />
                                </label>
                                <input
                                    type="number"
                                    value={draft}
                                    onChange={(e) => onDraftChange(e.target.value)}
                                    placeholder="Auto"
                                    className={INPUT_CLASS}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2 flex justify-between">
                                    Displacement <UnitToggle value={dispUnit} onClick={onToggleDispUnit} />
                                </label>
                                <input
                                    type="number"
                                    value={displacement}
                                    onChange={(e) => onDisplacementChange(e.target.value)}
                                    placeholder="Auto"
                                    className={INPUT_CLASS}
                                />
                            </div>
                        </div>

                        {/* Air Draft */}
                        <div>
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2 flex justify-between">
                                Air Draft <UnitToggle value={airDraftUnit} onClick={onToggleAirDraftUnit} />
                            </label>
                            <input
                                type="number"
                                value={airDraft}
                                onChange={(e) => onAirDraftChange(e.target.value)}
                                placeholder="Height above waterline"
                                className={INPUT_CLASS}
                            />
                            <p className="text-[11px] text-gray-400 mt-1">Used for bridge clearance on routes</p>
                        </div>

                        {/* Tankage */}
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2 flex justify-between gap-1 items-center">
                                    <span className="flex items-center gap-1">
                                        <GearIcon className="w-3 h-3 text-amber-400" /> Fuel
                                    </span>{' '}
                                    <UnitToggle value={volUnit} onClick={onToggleVolUnit} />
                                </label>
                                <input
                                    type="number"
                                    value={fuel}
                                    onChange={(e) => onFuelChange(e.target.value)}
                                    placeholder="0"
                                    className={INPUT_CLASS}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2 flex justify-between gap-1 items-center">
                                    <span className="flex items-center gap-1">
                                        <DropletIcon className="w-3 h-3 text-sky-400" /> Water
                                    </span>{' '}
                                    <UnitToggle value={volUnit} onClick={onToggleVolUnit} />
                                </label>
                                <input
                                    type="number"
                                    value={water}
                                    onChange={(e) => onWaterChange(e.target.value)}
                                    placeholder="0"
                                    className={INPUT_CLASS}
                                />
                            </div>
                        </div>

                        {/* Crew */}
                        <div>
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2 flex items-center gap-1">
                                <AnchorIcon className="w-3 h-3 text-sky-400" /> Crew Aboard (incl. Captain)
                            </label>
                            <input
                                type="number"
                                min="1"
                                max="99"
                                value={crewCount}
                                onChange={(e) => onCrewCountChange(e.target.value)}
                                placeholder="2"
                                className={INPUT_CLASS}
                            />
                            <p className="text-[11px] text-gray-400 mt-1">Used for provisioning and watch schedules</p>
                        </div>
                    </div>
                    <button
                        aria-label="Next"
                        onClick={onNext}
                        className="w-full mt-8 bg-sky-500 hover:bg-sky-400 text-white font-bold py-4 rounded-xl transition-all"
                    >
                        Next
                    </button>
                </>
            )}
        </div>
    ),
);

VesselDetailsStep.displayName = 'VesselDetailsStep';
