/**
 * Build 133-03. Native regional domains, not seamless aliases that silently
 * append a global model. Docs checked 2026-10-16: open-meteo.com/en/docs/
 * {meteofrance,dwd,ukmo,knmi,dmi,metno,gfs,gem,jma}-api.
 *
 * Boxes are conservative selection hints inside the documented region maps,
 * not a coverage guarantee. Existing domains require finite wind from the
 * commercial proxy; own AROME-OM requires its original sea-cell cohort.
 * Nulls and hours beyond the original run remain missing.
 */
import { AROME_DOMAINS, AROME_HORIZON_HOURS } from './aromeDomains';

export const ECMWF_9KM = 'ecmwf_ifs' as const;
export interface RegionalModel {
    id: string;
    name: string;
    provider: string;
    resolutionKm: number;
    horizonHours: number;
    /** South, north, west, east; conventional longitudes. */
    region: readonly [number, number, number, number];
    displayOnly?: boolean;
    /** Omitted for existing paid-proxy domains. Own IDs never enter &models=. */
    transport?: 'wx-arome';
}
export const REGIONAL_MODELS: readonly RegionalModel[] = [
    ...AROME_DOMAINS.map((domain) => ({
        id: domain.id,
        name: domain.name,
        provider: 'Météo-France',
        resolutionKm: 2.5,
        horizonHours: AROME_HORIZON_HOURS,
        region: domain.region,
        transport: 'wx-arome' as const,
    })),
    {
        id: 'metno_nordic',
        name: 'MET Nordic',
        provider: 'MET Norway',
        resolutionKm: 1,
        horizonHours: 60,
        region: [55, 70, 5, 30],
    },
    {
        id: 'ukmo_uk_deterministic_2km',
        name: 'UKV',
        provider: 'UK Met Office',
        resolutionKm: 2,
        horizonHours: 48,
        region: [50, 60, -10, 2],
        displayOnly: true,
    },
    {
        id: 'knmi_harmonie_arome_netherlands',
        name: 'Harmonie NL',
        provider: 'KNMI',
        resolutionKm: 2,
        horizonHours: 60,
        region: [50, 54, 3, 8],
    },
    { id: 'dwd_icon_d2', name: 'ICON-D2', provider: 'DWD', resolutionKm: 2, horizonHours: 48, region: [46, 55, 2, 17] },
    {
        id: 'meteofrance_arome_france_hd',
        name: 'AROME HD',
        provider: 'Météo-France',
        resolutionKm: 1.5,
        horizonHours: 48,
        region: [41, 50, -5, 9],
    },
    {
        id: 'meteofrance_arome_france',
        name: 'AROME',
        provider: 'Météo-France',
        resolutionKm: 2.5,
        horizonHours: 48,
        region: [39, 51, -7, 12],
    },
    {
        id: 'dmi_harmonie_arome_europe',
        name: 'Harmonie DMI',
        provider: 'DMI',
        resolutionKm: 2,
        horizonHours: 60,
        region: [54, 62, -2, 20],
    },
    {
        id: 'knmi_harmonie_arome_europe',
        name: 'Harmonie Europe',
        provider: 'KNMI',
        resolutionKm: 5.5,
        horizonHours: 60,
        region: [52, 63, -12, 20],
    },
    {
        id: 'ncep_hrrr_conus',
        name: 'HRRR',
        provider: 'NOAA',
        resolutionKm: 3,
        horizonHours: 48,
        region: [25, 49, -124, -67],
    },
    {
        id: 'cmc_gem_hrdps',
        name: 'HRDPS',
        provider: 'Environment and Climate Change Canada',
        resolutionKm: 2.5,
        horizonHours: 48,
        region: [43, 60, -130, -55],
    },
    { id: 'jma_msm', name: 'JMA MSM', provider: 'JMA', resolutionKm: 5, horizonHours: 96, region: [25, 45, 127, 145] },
    {
        id: 'dwd_icon_eu',
        name: 'ICON-EU',
        provider: 'DWD',
        resolutionKm: 7,
        horizonHours: 120,
        region: [36, 65, -12, 40],
    },
];
export function regionalModelFor(lat: number, lon: number): RegionalModel | undefined {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    // Finest documented grid wins an overlap; catalogue order breaks ties.
    // In particular AROME HD, rather than ICON-D2, serves Paris.
    return REGIONAL_MODELS.filter(
        ({ region: [south, north, west, east] }) => lat >= south && lat <= north && lon >= west && lon <= east,
    ).sort((a, b) => a.resolutionKm - b.resolutionKm)[0];
}
export function regionalModelLabel(model: RegionalModel): string {
    return `Local hi-res · ${model.resolutionKm} km`;
}
