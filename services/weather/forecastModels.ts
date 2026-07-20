/**
 * forecastModels — the catalogue behind the Glass page's model picker and
 * the multi-model convergence chart.
 *
 * These model-domain ids are accepted VERBATIM by both the self-hosted wx
 * server (Shane's tailnet Open-Meteo instance) and the public/commercial
 * Open-Meteo APIs — verified against both hosts on 2026-07-20 — so a single
 * list serves the picker, the point fetch, and the spread chart regardless
 * of which host answers.
 *
 * Source data is CC-BY-4.0. Anything user-visible that shows these models'
 * numbers must carry attribution — use MODEL_ATTRIBUTION_LINE.
 */
import type { WeatherModel } from '../../types';

export interface ForecastModelInfo {
    id: WeatherModel;
    /** Short label for the pill + picker rows. */
    label: string;
    /** Issuing agency, for the picker's helper text and attribution. */
    provider: string;
    /** One-line description for the picker row. */
    blurb: string;
    /** Line colour in the convergence chart. */
    hex: string;
}

/** Sentinel meaning "no pinned model" — the legacy WeatherKit-primary blend. */
export const AUTO_MODEL: WeatherModel = 'best_match';

/** Concrete models offered in the Glass model picker, in display order. */
export const SELECTABLE_MODELS: ForecastModelInfo[] = [
    {
        id: 'dwd_icon',
        label: 'ICON',
        provider: 'DWD',
        blurb: 'German global model — strong on convection',
        hex: '#a78bfa',
    },
    {
        id: 'ecmwf_ifs025',
        label: 'ECMWF',
        provider: 'ECMWF',
        blurb: 'The classic European physics model',
        hex: '#38bdf8',
    },
    {
        id: 'ecmwf_aifs025_single',
        label: 'AIFS',
        provider: 'ECMWF',
        blurb: 'ECMWF AI model — often the best single choice',
        hex: '#34d399',
    },
    {
        id: 'ukmo_global_deterministic_10km',
        label: 'UKMO',
        provider: 'UK Met Office',
        blurb: 'Finest grid of the set (10 km)',
        hex: '#f472b6',
    },
    {
        id: 'jma_gsm',
        label: 'JMA',
        provider: 'JMA',
        blurb: 'Japan — good over the western Pacific',
        hex: '#fb923c',
    },
    {
        id: 'ncep_gfs025',
        label: 'GFS',
        provider: 'NOAA',
        blurb: 'The American workhorse',
        hex: '#fbbf24',
    },
];

/** Wave models for the spread chart's WAVE/PER. params. The marine endpoint
 *  has its own model set — atmospheric ids are meaningless there. Same ids
 *  on the wx server and the public/commercial marine APIs. */
export const WAVE_SPREAD_MODELS: { id: string; label: string; provider: string; hex: string }[] = [
    { id: 'ecmwf_wam025', label: 'ECMWF WAM', provider: 'ECMWF', hex: '#38bdf8' },
    { id: 'dwd_gwam', label: 'GWAM', provider: 'DWD', hex: '#a78bfa' },
    { id: 'meteofrance_wave', label: 'MFWAM', provider: 'Météo-France', hex: '#34d399' },
    { id: 'ncep_gfswave025', label: 'GFS Wave', provider: 'NOAA', hex: '#fbbf24' },
];

/** CC-BY-4.0 licence condition — shown wherever model output is displayed. */
export const MODEL_ATTRIBUTION_LINE = 'Forecast data: ECMWF, DWD, UKMO, JMA, Météo-France, NOAA (CC-BY-4.0)';

export function isConcreteModel(m: WeatherModel | undefined | null): m is WeatherModel {
    return !!m && m !== AUTO_MODEL && SELECTABLE_MODELS.some((s) => s.id === m);
}

export function getForecastModelInfo(m: WeatherModel | undefined | null): ForecastModelInfo | null {
    return SELECTABLE_MODELS.find((s) => s.id === m) ?? null;
}

/** The effective model for the Glass fetch: the persisted choice when it's a
 *  known concrete model, otherwise the Auto sentinel. Guards against stale
 *  cloud blobs holding ids this build no longer knows. */
export function resolveForecastModel(stored: WeatherModel | undefined): WeatherModel {
    return isConcreteModel(stored) ? stored : stored === AUTO_MODEL ? AUTO_MODEL : 'dwd_icon';
}
