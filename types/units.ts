/**
 * types/units.ts — Unit system types
 *
 * All measurement unit types and UI preferences.
 */

export type LengthUnit = 'ft' | 'm';
export type WeightUnit = 'lbs' | 'kg' | 'tonnes';
export type SpeedUnit = 'kts' | 'mph' | 'kmh' | 'mps';
export type TempUnit = 'C' | 'F';
export type DistanceUnit = 'nm' | 'mi' | 'km';
export type VisibilityUnit = 'nm' | 'mi' | 'km';
export type VolumeUnit = 'gal' | 'l';
export type DisplayMode = 'light' | 'dark' | 'night' | 'auto';
export type DashboardMode = 'essential' | 'full';
export type ScreenOrientationType = 'auto' | 'portrait' | 'landscape';

export interface UnitPreferences {
    speed: SpeedUnit;
    length: LengthUnit;
    waveHeight: LengthUnit;
    tideHeight?: LengthUnit;
    temp: TempUnit;
    distance: DistanceUnit;
    visibility?: VisibilityUnit;
    volume?: VolumeUnit;
}
