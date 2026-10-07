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
 * Source data is CC BY 4.0, except the UK Met Office's, which is CC BY-SA 4.0
 * (share-alike: showing it with credit is fine; keep it out of any blend we
 * redistribute), NOAA's (a US Government work: public domain) and ECCC's (its
 * own Data Services End-use Licence). Anything user-visible that shows these
 * models' numbers must carry attribution — use MODEL_ATTRIBUTION_LINE, or
 * forecastDataCredit() for the providers actually on screen.
 */
import type { OffshoreModel, WeatherModel } from '../../types';

/** Offshore sources supported by the marine forecast pipeline. These are source
 * keys, NOT Open-Meteo atmospheric model-domain ids. Keep the two preferences
 * separate so returning inshore restores the skipper's atmospheric choice. */
export const OFFSHORE_MODELS: { id: OffshoreModel; label: string; provider: string; blurb: string; hex: string }[] = [
    {
        id: 'sg',
        // 'Auto', not the internal 'SG BLEND': Preferences led with an
        // abbreviation while the Glass's own picker says 'Auto' for the source
        // the app picks (UX scorecard run 10). Not 'Auto blend': at 85 px its
        // capitals overran the 128 px model pill.
        label: 'Auto',
        provider: 'StormGlass',
        blurb: 'Automatic offshore source selection',
        hex: '#34d399',
    },
    {
        id: 'ecmwf',
        label: 'ECMWF',
        provider: 'ECMWF',
        blurb: 'European offshore forecast via StormGlass',
        hex: '#38bdf8',
    },
    { id: 'gfs', label: 'GFS', provider: 'NOAA', blurb: 'Global offshore forecast via StormGlass', hex: '#fbbf24' },
    {
        id: 'icon',
        label: 'ICON',
        provider: 'DWD',
        blurb: 'German global forecast with marine enrichment',
        hex: '#a78bfa',
    },
];

export function resolveOffshoreModel(stored: unknown): OffshoreModel {
    return OFFSHORE_MODELS.find((model) => model.id === stored)?.id ?? 'sg';
}

export function getOffshoreModelInfo(model: OffshoreModel) {
    return OFFSHORE_MODELS.find((entry) => entry.id === model)!;
}

export interface ForecastModelInfo {
    id: WeatherModel;
    /** Short label for the pill + picker rows. */
    label: string;
    /** Issuing agency, for the picker's helper text and attribution. */
    provider: string;
    /** One-line description for the picker row, in a skipper's words (the
     *  picker and PassageModelModal both show it). */
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
        blurb: 'German global model — good with thunderstorms and squalls',
        hex: '#a78bfa',
    },
    {
        id: 'ecmwf_ifs025',
        label: 'ECMWF',
        provider: 'ECMWF',
        // No claim the app cannot back ('a trusted all-rounder', 'finest grid
        // of the set'): every consumer reads these words (UX scorecard run 9).
        blurb: 'The main European global model',
        hex: '#38bdf8',
    },
    {
        id: 'ecmwf_aifs025_single',
        label: 'AIFS',
        provider: 'ECMWF',
        blurb: 'ECMWF AI model — no gust forecast',
        hex: '#34d399',
        missing: ['gust'],
    },
    {
        id: 'ukmo_global_deterministic_10km',
        label: 'UKMO',
        provider: 'UK Met Office',
        blurb: 'UK Met Office — 10 km grid',
        hex: '#f472b6',
    },
    {
        id: 'jma_gsm',
        label: 'JMA',
        provider: 'JMA',
        blurb: 'Japan — western Pacific, no gust forecast',
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
    // (The comparison sheet already shows GFS: see SPREAD_EXTRA_MODELS.)
];

/** A member of the model comparison. Comparison-only ids (GEM) are not
 *  WeatherModel values: the Glass can't be pinned to them. */
export type CompareModelInfo = Pick<ForecastModelInfo, 'label' | 'provider' | 'hex' | 'missing'> & { id: string };

/**
 * The two models the comparison adds to the picker's five, so it keeps at
 * least five members to day 9.5 (ICON stops near day 7, UKMO near 6.5).
 * Through the commercial proxy only: the tailnet wx server has no wind for
 * either. Measured through proxy-openmeteo at Fiji on 2026-10-07, non-null
 * 10 m wind hours of 240: GFS 240, GEM 227. Not offered in the picker, so the
 * Glass and the model-check card keep their five.
 *
 * "Seamless" means not purely global: Open-Meteo serves gfs_seamless from
 * NOAA's 3 km HRRR over the contiguous US (and nearby Canada) for the first
 * 18–48 h, and gem_seamless from ECCC's HRDPS/RDPS over Canada and North
 * America, before each hands over to its global run. The sheet therefore
 * says "7 models", never "7 global models". The providers, and so the
 * credits, are the same either way.
 *
 * Like IFS, AIFS and JMA, the late hours arrive 3- or 6-hourly upstream and
 * Open-Meteo interpolates them to hourly; the app itself never fills a gap.
 */
export const SPREAD_EXTRA_MODELS: CompareModelInfo[] = [
    { id: 'gfs_seamless', label: 'GFS', provider: 'NOAA', hex: '#fbbf24' },
    { id: 'gem_seamless', label: 'GEM', provider: 'Environment and Climate Change Canada', hex: '#a3e635' },
];

/** The seven models in the ten-day comparison, in legend order. */
export const COMPARE_MODELS: CompareModelInfo[] = [...SELECTABLE_MODELS, ...SPREAD_EXTRA_MODELS];

/** Wave models for the spread chart's WAVE/PER. params. The marine endpoint
 *  has its own model set — atmospheric ids are meaningless there. Same ids
 *  on the wx server and the public/commercial marine APIs. */
export const WAVE_SPREAD_MODELS: { id: string; label: string; provider: string; hex: string }[] = [
    { id: 'ecmwf_wam025', label: 'ECMWF WAM', provider: 'ECMWF', hex: '#38bdf8' },
    { id: 'dwd_gwam', label: 'GWAM', provider: 'DWD', hex: '#a78bfa' },
    { id: 'meteofrance_wave', label: 'MFWAM', provider: 'Météo-France', hex: '#34d399' },
    { id: 'ncep_gfswave025', label: 'GFS Wave', provider: 'NOAA', hex: '#fbbf24' },
];

/** ECCC's licence, by its own name (v2.1.1, August 2026), and where it lives:
 *  it asks for the statement "Data Source: Environment and Climate Change
 *  Canada" and, where possible, a link to the licence. */
export const ECCC_LICENCE = 'ECCC Data Services End-use Licence';
export const ECCC_LICENCE_URL = 'https://eccc-msc.github.io/open-data/licence/readme_en/';
const ECCC_STATEMENT = 'Data Source: Environment and Climate Change Canada';

const LICENCES = ['CC BY 4.0', 'CC BY-SA 4.0', 'public domain', ECCC_LICENCE] as const;
export type ForecastDataLicence = (typeof LICENCES)[number];

/** Providers whose data is not CC BY 4.0, under each name the app uses:
 *  - UK Met Office open data is share-alike.
 *  - NOAA's is a US Government work, public domain (weather.gov/disclaimer).
 *  - ECCC's comes under its own end-use licence (ECCC_LICENCE above). */
const OTHER_LICENCES: Record<string, ForecastDataLicence> = {
    'UK Met Office': 'CC BY-SA 4.0',
    UKMO: 'CC BY-SA 4.0',
    NOAA: 'public domain',
    'Environment and Climate Change Canada': ECCC_LICENCE,
    ECCC: ECCC_LICENCE,
};

/** The licence a provider's open model data carries. */
export function providerLicence(provider: string): ForecastDataLicence {
    return OTHER_LICENCES[provider.trim()] ?? 'CC BY 4.0';
}

/**
 * The one credit format for model output: each provider once, in the order
 * given, grouped under its licence — "Forecast data: DWD, ECMWF (CC BY 4.0);
 * UK Met Office (CC BY-SA 4.0); NOAA (public domain)". ECCC is credited in
 * the words its licence specifies, "Data Source: Environment and Climate
 * Change Canada (ECCC Data Services End-use Licence)", whichever name the
 * caller used. `lead` replaces "Forecast data" where the line must also name
 * the distributor ("Data via Open-Meteo"). Null when there is nobody to
 * credit.
 */
export function forecastDataCredit(providers: readonly string[], lead = 'Forecast data'): string | null {
    const groups = new Map<ForecastDataLicence, string[]>();
    for (const raw of providers) {
        const p = raw.trim();
        if (!p) continue;
        const licence = providerLicence(p);
        const names = groups.get(licence) ?? [];
        if (!names.includes(p)) names.push(p);
        groups.set(licence, names);
    }
    const parts = LICENCES.filter((licence) => groups.has(licence)).map(
        (licence) => `${licence === ECCC_LICENCE ? ECCC_STATEMENT : groups.get(licence)!.join(', ')} (${licence})`,
    );
    return parts.length ? `${lead}: ${parts.join('; ')}` : null;
}

/** The licence condition — shown wherever model output is displayed. */
export const MODEL_ATTRIBUTION_LINE = forecastDataCredit(['ECMWF', 'DWD', 'UKMO', 'JMA', 'Météo-France', 'NOAA'])!;

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
