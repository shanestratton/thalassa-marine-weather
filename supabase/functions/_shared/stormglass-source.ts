/** Documented StormGlass weather selectors (GFS is named `noaa` upstream).
 * Legacy clients sent app model IDs. ICON has no matching SG selector;
 * those requests retain the automatic SG fallback, never masquerade as ICON.
 * Updated clients fetch ICON atmosphere separately from DWD/Open-Meteo.
 */
const SOURCES: ReadonlySet<string> = new Set(['sg', 'ecmwf', 'noaa']);

export function normalizeStormGlassSources(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 24) return null;
    const parts = value.split(',');
    if (parts.length < 1 || parts.length > 2) return null;
    const sources = parts.map((part) => (part === 'gfs' ? 'noaa' : part === 'icon' ? 'sg' : part));
    if (sources.some((source) => !SOURCES.has(source)) || new Set(sources).size !== sources.length) return null;
    return sources.join(',');
}
