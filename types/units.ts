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
/** 'auto': light/dark at sunrise and sunset. 'auto-night' (131-03): the same,
 *  plus the red Night from nautical dusk to dawn — the default for new installs. */
export type DisplayMode = 'light' | 'dark' | 'night' | 'auto' | 'auto-night';
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
