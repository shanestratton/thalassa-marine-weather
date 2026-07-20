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
    /**
     * Metrics this model does not publish AT ALL — absent from the upstream
     * open-data mirror, so no amount of syncing will produce them. Declared
     * here so the UI can say "ICON doesn't publish this" instead of leaving
     * the user to wonder whether the fetch failed.
     *
     * Deliberately NOT gap-filled from another model, unlike UV/visibility:
     * a gust factor belongs to its own model's boundary layer, so pairing
     * AIFS wind with ICON gust would put two models' physics in one line and
     * present it as one forecast. A gust is a safety number; better blank.
     */
    missing?: ('gust' | 'visibility' | 'uv')[];
}

/** Sentinel meaning "no pinned model" — the legacy WeatherKit-primary blend. */
export const AUTO_MODEL: WeatherModel = 'best_match';

/**
 * Concrete models offered in the Glass model picker, in display order.
 *
 * Availability verified field-by-field against the upstream open-data mirror
 * on 2026-07-21 — a model id returning HTTP 200 is NOT proof it carries the
 * data (see the GFS note below, which is exactly how that mistake was made).
 */
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
        blurb: 'ECMWF AI model — no gust field',
        hex: '#34d399',
        missing: ['gust'],
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
        blurb: 'Japan — western Pacific, no gust field',
        hex: '#fb923c',
        missing: ['gust'],
    },
    // ── GFS removed 2026-07-21 ──
    // `ncep_gfs025` carries NO 10 m wind in the open-data mirror — not on the
    // wx server and not on the public API either. Open-Meteo splits GFS across
    // domains: gusts/pressure/visibility/cape in ncep_gfs025, the 10 m wind and
    // temperature in ncep_gfs013. A single-domain request therefore yields a
    // model with no wind — the Glass's headline metric — so it must not be
    // offered. It shipped because the original check only confirmed the
    // request returned 200, never that values came back.
    // To restore: sync ncep_gfs013 as well and switch this entry to
    // `gfs_seamless`, which the API already accepts and resolves to the 0.13°
    // grid; verify wind_speed_10m is non-null BEFORE re-listing it here.
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

/** Sentinel for the SPITFIRE consensus. Not an Open-Meteo model id — it must
 *  never reach a `&models=` parameter; see services/weather/spitfire.ts. */
export const SPITFIRE_MODEL = 'spitfire' as WeatherModel;

export function isSpitfire(m: WeatherModel | undefined | null): boolean {
    return m === SPITFIRE_MODEL;
}

export function isConcreteModel(m: WeatherModel | undefined | null): m is WeatherModel {
    return !!m && m !== AUTO_MODEL && SELECTABLE_MODELS.some((s) => s.id === m);
}

/** True when this model simply does not publish the metric (so the UI should
 *  say so rather than imply a fetch failure). */
export function modelLacks(m: WeatherModel | undefined | null, metric: 'gust' | 'visibility' | 'uv'): boolean {
    return !!getForecastModelInfo(m)?.missing?.includes(metric);
}

export function getForecastModelInfo(m: WeatherModel | undefined | null): ForecastModelInfo | null {
    return SELECTABLE_MODELS.find((s) => s.id === m) ?? null;
}

/** The effective model for the Glass fetch: the persisted choice when it's a
 *  known concrete model, otherwise the Auto sentinel. Guards against stale
 *  cloud blobs holding ids this build no longer knows — which now includes
 *  anyone whose settings still say `ncep_gfs025`; they fall back to ICON
 *  rather than to a model with no wind. */
export function resolveForecastModel(stored: WeatherModel | undefined): WeatherModel {
    if (isSpitfire(stored)) return SPITFIRE_MODEL;
    return isConcreteModel(stored) ? stored : stored === AUTO_MODEL ? AUTO_MODEL : 'dwd_icon';
}
