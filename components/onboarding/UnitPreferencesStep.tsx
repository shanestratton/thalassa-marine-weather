/**
 * UnitPreferencesStep — Onboarding Step 6: measurement unit selection.
 */
import React from 'react';
import type { SpeedUnit, TempUnit, DistanceUnit, LengthUnit } from '../../types';

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
    onNext: () => void;
}

const UnitRow: React.FC<{ label: string; options: string[]; current: string; onChange: (v: string) => void }> = ({
    label,
    options,
    current,
    onChange,
}) => (
    <div className="bg-white/5 rounded-xl p-4 flex justify-between items-center">
        <span className="text-gray-300 font-medium">{label}</span>
        <div className="flex bg-black/20 rounded-lg p-1">
            {options.map((u) => (
                <button
                    aria-label="Change"
                    key={u}
                    onClick={() => onChange(u)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase transition-all ${current === u ? 'bg-sky-500 text-white' : 'text-gray-400'}`}
                >
                    {u}
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
        onNext,
    }) => (
        <div className="animate-in fade-in slide-in-from-right-8 duration-500">
            <h2 className="text-2xl font-bold text-white mb-6 text-center">Unit Preferences</h2>

            <div className="space-y-4 mb-8">
                <UnitRow
                    label="Wind Speed"
                    options={['kts', 'mph', 'kmh']}
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
                    label="Tide Height / Length"
                    options={['m', 'ft']}
                    current={prefLength}
                    onChange={(v) => onLengthChange(v as LengthUnit)}
                />
                <UnitRow
                    label="Temperature"
                    options={['C', 'F']}
                    current={prefTemp}
                    onChange={(v) => onTempChange(v as TempUnit)}
                />
                <UnitRow
                    label="Distance"
                    options={['nm', 'mi', 'km']}
                    current={prefDist}
                    onChange={(v) => onDistChange(v as DistanceUnit)}
                />
            </div>

            <button
                aria-label="Next"
                onClick={onNext}
                className="w-full bg-sky-500 hover:bg-sky-400 text-white font-bold py-4 rounded-xl transition-all"
            >
                Next
            </button>
        </div>
    ),
);

UnitPreferencesStep.displayName = 'UnitPreferencesStep';
