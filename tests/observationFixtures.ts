/** Generated data only; these stations/locations do not identify a user's boat. */
export const NOW = Date.parse('2026-10-16T12:00:00Z');
export const latestHeader = '#STN LAT LON YYYY MM DD hh mm WDIR WSPD GST PRES ATMP';
export function ndbcLatest(lines: string[]): string {
    return [latestHeader, '#text deg deg yr mo dy hr mn degT m/s m/s hPa degC', ...lines].join('\n');
}
export const metar = (extra: Record<string, unknown> = {}) => ({
    icaoId: 'ZZ01',
    name: 'Synthetic airport',
    lat: 30.01,
    lon: -150,
    metarType: 'METAR',
    obsTime: NOW / 1000 - 1200,
    receiptTime: '2026-10-16 11:41:00.000Z',
    reportTime: '2026-10-16 12:00:00.000Z',
    wspd: 10,
    wgst: 15,
    wdir: 270,
    temp: 20,
    slp: 1007.4,
    altim: 1010.2,
    ...extra,
});
