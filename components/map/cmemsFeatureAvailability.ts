import type { WeatherLayer } from './mapConstants';
import { isParkedLayer } from './mapConstants';
import type { CmemsLayerId } from './CmemsAttribution';

const flag = (value: unknown): boolean => String(value ?? 'false').toLowerCase() === 'true';

const CMEMS_FEATURE_FLAGS: Record<CmemsLayerId, boolean> = {
    currents: flag(import.meta.env.VITE_CMEMS_CURRENTS_ENABLED),
    waves: flag(import.meta.env.VITE_CMEMS_WAVES_ENABLED),
    sst: flag(import.meta.env.VITE_CMEMS_SST_ENABLED),
    chl: flag(import.meta.env.VITE_CMEMS_CHL_ENABLED),
    seaice: flag(import.meta.env.VITE_CMEMS_SEAICE_ENABLED),
    mld: flag(import.meta.env.VITE_CMEMS_MLD_ENABLED),
};

export function isCmemsProductLayer(layer: WeatherLayer): layer is CmemsLayerId {
    return Object.prototype.hasOwnProperty.call(CMEMS_FEATURE_FLAGS, layer);
}

/** The exact build flag for one product; no generic CMEMS fallback exists. */
export function isCmemsFeatureEnabled(layer: CmemsLayerId): boolean {
    return CMEMS_FEATURE_FLAGS[layer];
}

/** Public picker availability also honours Shane's explicitly parked layers. */
export function isCmemsLayerAvailable(layer: CmemsLayerId): boolean {
    return isCmemsFeatureEnabled(layer) && !isParkedLayer(layer);
}

export function isWeatherLayerAvailable(layer: WeatherLayer): boolean {
    return !isCmemsProductLayer(layer) || isCmemsLayerAvailable(layer);
}
