/**
 * UnitPreferencesStep — Onboarding Step 4: measurement unit selection.
 *
 * Moved ahead of Vessel Details 2026-04-23 so the length/beam/draft/
 * fuel/water fields in Vessel Details default to the user's chosen
 * units rather than the locale guess.
 */
import React from 'react';
import type { SpeedUnit, TempUnit, DistanceUnit, LengthUnit, VolumeUnit } from '../../types';

interface UnitPreferencesStepProps {
    prefSpeed: SpeedUnit;
    onSpeedChange: (v: SpeedUnit) => void;
    prefWaveHeight: LengthUnit;
    onWaveHeightChange: (v: LengthUnit) => void;
    prefLength: LengthUnit;
    onLengthChange: (v: LengthUnit) => void;
    prefTemp: TempUnit;
    onTempChange: (v: TempUnit) => void;
    prefDist: DistanceUnit;
    onDistChange: (v: DistanceUnit) => void;
    prefVolume: VolumeUnit;
    onVolumeChange: (v: VolumeUnit) => void;
    onNext: () => void;
}

const UnitRow: React.FC<{
    label: string;
    options: string[];
    current: string;
    onChange: (v: string) => void;
    /** Display text per option value — the stored value is always the option itself. */
    labels?: Record<string, string>;
}> = ({ label, options, current, onChange, labels }) => (
    <div className="bg-white/5 rounded-xl p-4 flex justify-between items-center">
        <span className="text-gray-300 font-medium">{label}</span>
        {/* The visible unit is the button's name, so no aria-label; the group
            names it so 'kts' is announced inside 'Wind Speed'. */}
        <div role="group" aria-label={label} className="flex bg-black/20 rounded-lg p-1">
            {options.map((u) => (
                <button
                    key={u}
                    type="button"
                    aria-pressed={current === u}
                    onClick={() => onChange(u)}
                    className={`min-h-11 px-3 flex items-center justify-center rounded-lg text-xs font-bold uppercase transition-all ${current === u ? 'bg-sky-500 text-white' : 'text-gray-400'}`}
                >
                    {labels?.[u] ?? u}
                </button>
            ))}
        </div>
    </div>
);

export const UnitPreferencesStep: React.FC<UnitPreferencesStepProps> = React.memo(
    ({
        prefSpeed,
        onSpeedChange,
        prefWaveHeight,
        onWaveHeightChange,
        prefLength,
        onLengthChange,
        prefTemp,
        onTempChange,
        prefDist,
        onDistChange,
        prefVolume,
        onVolumeChange,
        onNext,
    }) => (
        <div className="animate-in fade-in slide-in-from-right-8 duration-500 pt-8">
            <h2 className="text-2xl font-bold text-white mb-2 text-center">Unit Preferences</h2>
            <p className="text-xs text-gray-400 text-center mb-6">Defaults from your phone locale — change anytime.</p>

            <div className="space-y-4 mb-8">
                <UnitRow
                    label="Wind Speed"
                    options={['kts', 'mph', 'kmh']}
                    labels={{ kmh: 'km/h' }}
                    current={prefSpeed}
                    onChange={(v) => onSpeedChange(v as SpeedUnit)}
                />
                <UnitRow
                    label="Seas (Wave Height)"
                    options={['m', 'ft']}
                    current={prefWaveHeight}
                    onChange={(v) => onWaveHeightChange(v as LengthUnit)}
                />
                <UnitRow
                    label="Tide Height / Boat Length"
                    options={['m', 'ft']}
                    current={prefLength}
                    onChange={(v) => onLengthChange(v as LengthUnit)}
                />
                <UnitRow
                    label="Temperature"
                    options={['C', 'F']}
                    labels={{ C: '°C', F: '°F' }}
                    current={prefTemp}
                    onChange={(v) => onTempChange(v as TempUnit)}
                />
                <UnitRow
                    label="Distance"
                    options={['nm', 'mi', 'km']}
                    current={prefDist}
                    onChange={(v) => onDistChange(v as DistanceUnit)}
                />
                <UnitRow
                    label="Fuel / Water"
                    options={['l', 'gal']}
                    current={prefVolume}
                    onChange={(v) => onVolumeChange(v as VolumeUnit)}
                />
            </div>

            <button
                aria-label="Continue after choosing units"
                onClick={onNext}
                className="w-full bg-sky-500 hover:bg-sky-400 text-white font-bold py-4 rounded-xl transition-all"
            >
                Next
            </button>
        </div>
    ),
);

UnitPreferencesStep.displayName = 'UnitPreferencesStep';
