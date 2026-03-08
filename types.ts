/**
 * types.ts — Backward-compatible barrel re-export
 *
 * The types have been split into domain modules under /types/:
 *   - types/units.ts      — Unit types (LengthUnit, SpeedUnit, etc.)
 *   - types/weather.ts    — Weather metrics, forecasts, observations, GRIB
 *   - types/navigation.ts — Ship log, voyage plans, polars, NMEA
 *   - types/vessel.ts     — Vessel profile, inventory, maintenance, equipment
 *   - types/settings.ts   — UserSettings
 *   - types/api.ts        — Third-party API response shapes
 *
 * All existing imports from '../types' continue to work unchanged.
 * New code should import from the specific domain module for clarity.
 */

export * from './types/index';
