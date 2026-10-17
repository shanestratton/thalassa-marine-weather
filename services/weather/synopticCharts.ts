/** Reviewed public official charts. URLs are source-owned, never user input.
 * Coverage boxes are conservative chart-selection hints. DWD is held until
 * its chart-specific reuse terms are confirmed; BOM is not purchased. */
export interface SynopticChart {
    id: string;
    title: string;
    issuer: 'NOAA OPC' | 'NOAA TAFB' | 'NOAA HFO' | 'JMA';
    kind: 'analysis' | 'forecast';
    leadHours?: number;
    sourcePage: string;
    url?: string;
    mime: 'image/gif' | 'image/png';
    /** Only verified CORS sources can be downloaded directly by a browser. */
    direct?: boolean;
    jmaSlot?: 'now' | 'ft24' | 'ft48';
    estimatedKb: number;
}
const opc = 'https://ocean.weather.gov/shtml/';
const tafb = 'https://www.nhc.noaa.gov/tafb_latest/';
const hfo = 'https://www.weather.gov/images/hfo/graphics/';
const jmaPage = 'https://www.jma.go.jp/bosai/weather_map/';
export const JMA_CHART_INDEX = `${jmaPage}data/list.json`;
export const SYNOPTIC_CHARTS: readonly SynopticChart[] = [
    {
        id: 'opc-atl-analysis',
        title: 'Atlantic surface analysis',
        issuer: 'NOAA OPC',
        kind: 'analysis',
        sourcePage: `${opc}A_brief.php`,
        url: `${opc}A_full_00hrsfc.gif`,
        mime: 'image/gif',
        estimatedKb: 180,
    },
    {
        id: 'opc-atl-24',
        title: 'Atlantic surface forecast · 24 h',
        issuer: 'NOAA OPC',
        kind: 'forecast',
        leadHours: 24,
        sourcePage: `${opc}A_brief.php`,
        url: `${opc}A_24hrsfc.gif`,
        mime: 'image/gif',
        estimatedKb: 180,
    },
    {
        id: 'opc-pac-analysis',
        title: 'Pacific surface analysis',
        issuer: 'NOAA OPC',
        kind: 'analysis',
        sourcePage: `${opc}P_brief.php`,
        url: `${opc}P_full_00hrsfc.gif`,
        mime: 'image/gif',
        estimatedKb: 180,
    },
    {
        id: 'opc-pac-24',
        title: 'Pacific surface forecast · 24 h',
        issuer: 'NOAA OPC',
        kind: 'forecast',
        leadHours: 24,
        sourcePage: `${opc}P_brief.php`,
        url: `${opc}P_24hrsfc.gif`,
        mime: 'image/gif',
        estimatedKb: 180,
    },
    {
        id: 'tafb-analysis',
        title: 'Unified surface analysis',
        issuer: 'NOAA TAFB',
        kind: 'analysis',
        sourcePage: 'https://www.nhc.noaa.gov/marine/',
        url: `${tafb}USA_latest.gif`,
        mime: 'image/gif',
        estimatedKb: 390,
    },
    {
        id: 'tafb-atl-24',
        title: 'Tropical Atlantic surface forecast · 24 h',
        issuer: 'NOAA TAFB',
        kind: 'forecast',
        leadHours: 24,
        sourcePage: 'https://www.nhc.noaa.gov/marine/',
        url: `${tafb}atl24_latestBW.gif`,
        mime: 'image/gif',
        estimatedKb: 140,
    },
    {
        id: 'tafb-pac-24',
        title: 'Eastern Pacific surface forecast · 24 h',
        issuer: 'NOAA TAFB',
        kind: 'forecast',
        leadHours: 24,
        sourcePage: 'https://www.nhc.noaa.gov/marine/',
        url: `${tafb}pac24_latestBW.gif`,
        mime: 'image/gif',
        estimatedKb: 140,
    },
    {
        id: 'hfo-analysis',
        title: 'North Pacific surface analysis',
        issuer: 'NOAA HFO',
        kind: 'analysis',
        sourcePage: 'https://www.weather.gov/hfo/analyses',
        url: `${hfo}npac.gif`,
        mime: 'image/gif',
        direct: true,
        estimatedKb: 150,
    },
    {
        id: 'hfo-stream',
        title: 'Tropical streamline analysis',
        issuer: 'NOAA HFO',
        kind: 'analysis',
        sourcePage: 'https://www.weather.gov/hfo/analyses',
        url: `${hfo}stream.gif`,
        mime: 'image/gif',
        direct: true,
        estimatedKb: 95,
    },
    {
        id: 'hfo-24',
        title: 'Pacific surface forecast · 24 h',
        issuer: 'NOAA HFO',
        kind: 'forecast',
        leadHours: 24,
        sourcePage: 'https://www.weather.gov/hfo/analyses',
        url: `${hfo}24hr_sfcprog_00.gif`,
        mime: 'image/gif',
        direct: true,
        estimatedKb: 120,
    },
    {
        id: 'jma-analysis',
        title: 'Asia-Pacific surface analysis',
        issuer: 'JMA',
        kind: 'analysis',
        sourcePage: jmaPage,
        jmaSlot: 'now',
        mime: 'image/png',
        direct: true,
        estimatedKb: 80,
    },
    {
        id: 'jma-24',
        title: 'Asia-Pacific marine forecast · 24 h',
        issuer: 'JMA',
        kind: 'forecast',
        leadHours: 24,
        sourcePage: jmaPage,
        jmaSlot: 'ft24',
        mime: 'image/png',
        direct: true,
        estimatedKb: 80,
    },
    {
        id: 'jma-48',
        title: 'Asia-Pacific marine forecast · 48 h',
        issuer: 'JMA',
        kind: 'forecast',
        leadHours: 48,
        sourcePage: jmaPage,
        jmaSlot: 'ft48',
        mime: 'image/png',
        direct: true,
        estimatedKb: 80,
    },
];
export const synopticChart = (id: string): SynopticChart | undefined =>
    SYNOPTIC_CHARTS.find((chart) => chart.id === id);

export function chartsForPoint(lat: number, lon: number): SynopticChart[] {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || lat < -30)
        return [];
    let ids: string[] = [];
    if (lat >= 20 && lat <= 60 && lon >= 110 && lon <= 170) ids = ['jma-analysis', 'jma-24', 'jma-48'];
    else if (lat >= 30 && lat <= 75 && lon >= -100 && lon <= 20) ids = ['opc-atl-analysis', 'opc-atl-24'];
    else if (lat >= 30 && lat <= 65 && (lon >= 130 || lon <= -100)) ids = ['opc-pac-analysis', 'opc-pac-24'];
    else if (lat >= 0 && lat < 30 && lon >= -100 && lon <= 0) ids = ['tafb-analysis', 'tafb-atl-24'];
    else if (lat >= 0 && lat < 30 && lon >= -140 && lon < -100) ids = ['tafb-analysis', 'tafb-pac-24'];
    else if (lat >= -30 && lat < 30 && (lon >= 130 || lon <= -120))
        ids = [lat >= 0 ? 'hfo-analysis' : 'hfo-stream', 'hfo-24'];
    return ids.map((id) => synopticChart(id)!);
}

/** Only these exact JMA Asia colour slots are accepted, including when the
 * list is served through the proxy. No path, URL or SVG can pass as a file. */
export function jmaChartUrl(index: unknown, slot: 'now' | 'ft24' | 'ft48'): string | null {
    const names = (index as { asia?: Partial<Record<'now' | 'ft24' | 'ft48', unknown>> } | null)?.asia?.[slot];
    if (!Array.isArray(names) || names.length > 100) return null;
    const product = slot === 'now' ? 'asas' : slot === 'ft24' ? 'fsas24' : 'fsas48';
    const pattern = new RegExp(
        `^\\d{14}_0_Z__C_010000_\\d{14}_MET_CHT_JCI${product}_JCP600x512_JRcolor_Tjmahp_image\\.png$`,
    );
    const valid = names.filter((name): name is string => typeof name === 'string' && pattern.test(name)).sort();
    return valid.length ? `${jmaPage}data/png/${valid[valid.length - 1]}` : null;
}

export function chartCredit(chart: SynopticChart): string {
    return chart.issuer === 'JMA'
        ? 'Source: Japan Meteorological Agency website · Public Data License 1.0'
        : `${chart.issuer} · NOAA/NWS public domain`;
}
