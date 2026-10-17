/** Météo-France AROME-OM regular grids, technical description 2024-06-25.
 * These are our ingest IDs, never Open-Meteo model aliases. Boxes only select
 * a candidate; a current original cohort and its sea mask must admit a point.
 */
export const AROME_DOMAINS = [
    {
        id: 'thalassa_arome_om_ncaled_025',
        domain: 'NCALED',
        name: 'AROME New Caledonia / Vanuatu',
        region: [-30, -10, 156, 174],
        width: 721,
        height: 801,
    },
    {
        id: 'thalassa_arome_om_polyn_025',
        domain: 'POLYN',
        name: 'AROME French Polynesia',
        region: [-25.25, -12.6, -157.5, -144.5],
        width: 521,
        height: 507,
    },
    {
        id: 'thalassa_arome_om_caraib_025',
        // The documented grid is CARAIB; the current official object key is ANTIL.
        domain: 'ANTIL',
        name: 'AROME Antilles',
        region: [9.7, 22.9, -75.3, -51.7],
        width: 945,
        height: 529,
    },
] as const;

export type AromeModelId = (typeof AROME_DOMAINS)[number]['id'];
export type AromeDomain = (typeof AROME_DOMAINS)[number];
export const AROME_STEP_DEGREES = 0.025;
export const AROME_HORIZON_HOURS = 48;
export const AROME_MAX_SOURCE_AGE_MS = 18 * 3_600_000;

export function aromeDomain(model: string): AromeDomain | undefined {
    return AROME_DOMAINS.find((domain) => domain.id === model);
}

export function isAromeModel(model: string): model is AromeModelId {
    return aromeDomain(model) !== undefined;
}
