/** Fixed NOAA text products; regional selection is only a discovery aid.
 * Exact forecast area and validity remain in the original bulletin. */
const raw = (file: string) => 'https://tgftp.nws.noaa.gov/data/raw/fz/' + file;
export const MARINE_BULLETIN_SOURCES = [
    {
        id: 'noaa-hsf-at1',
        title: 'NOAA · North Atlantic high seas (METAREA IV)',
        file: raw('fznt01.kwbc.hsf.at1.txt'),
        area: (lat: number, lon: number) => lat >= 7 && lat <= 70 && lon >= -100 && lon <= -35,
    },
    {
        id: 'noaa-hsf-at2',
        title: 'NOAA · Tropical Atlantic high seas',
        file: raw('fznt02.knhc.hsf.at2.txt'),
        area: (lat: number, lon: number) => lat >= 7 && lat <= 31 && lon >= -100 && lon <= -35,
    },
    {
        id: 'noaa-hsf-ep1',
        title: 'NOAA · North Pacific high seas',
        file: raw('fzpn01.kwbc.hsf.ep1.txt'),
        area: (lat: number, lon: number) => lat >= 30 && lat <= 67 && (lon >= 160 || lon <= -100),
    },
    {
        id: 'noaa-hsf-ep2',
        title: 'NOAA · Eastern tropical Pacific high seas',
        file: raw('fzpn03.knhc.hsf.ep2.txt'),
        area: (lat: number, lon: number) => lat >= 0 && lat < 30 && lon >= -140 && lon <= -80,
    },
    {
        id: 'noaa-hsf-np',
        title: 'NOAA · North central Pacific high seas',
        file: raw('fzpn40.phfo.hsf.np.txt'),
        area: (lat: number, lon: number) => lat >= 0 && lat < 30 && (lon >= 160 || lon <= -140),
    },
    {
        id: 'noaa-amz650',
        title: 'NOAA · Jupiter Inlet to Deerfield Beach coastal waters',
        file: 'https://tgftp.nws.noaa.gov/data/forecasts/marine/coastal/am/amz650.txt',
        area: (lat: number, lon: number) => lat >= 26.3 && lat <= 27.1 && lon >= -80.4 && lon <= -79,
    },
    {
        id: 'noaa-amz651',
        title: 'NOAA · Deerfield Beach to Ocean Reef coastal waters',
        file: 'https://tgftp.nws.noaa.gov/data/forecasts/marine/coastal/am/amz651.txt',
        area: (lat: number, lon: number) => lat >= 25 && lat < 26.3 && lon >= -80.6 && lon <= -79,
    },
] as const;
