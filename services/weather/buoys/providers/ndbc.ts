/**
 * NDBC — one file, every station (build 123, W1-11).
 *
 * https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt is ~100 KB, refreshed
 * every 5 min, with the newest row of ~900 stations; ~185 carried a wave height
 * on 2026-10-07. That covers the US coasts, the Gulf and Great Lakes, the
 * Caribbean, Hawaii and the Pacific islands, Korea (KMA) and the North Sea and
 * English Channel (UK Met Office and offshore platforms).
 *
 * TWO MEASURED TRAPS:
 *  - NDBC's own buoys alternate met-only rows (:00/:30, no waves) with wave
 *    rows (:10/:20/:40/:50). latest_obs holds only the newest row, so at most
 *    moments 46026, 41010, 41043 and ~90 others show WVHT `MM` there. For the
 *    nearest such station only, the 5-day spectral summary (~17 KB) supplies
 *    the newest wave row (fetchWaves).
 *  - Many stations in the file belong to partners, not NDBC. The owner table
 *    below is NDBC's own station_table.txt (owner codes decoded through
 *    station_owners.txt), cut to the buoys and platforms seen in latest_obs on
 *    2026-10-07. A station not in it gets no invented owner.
 *
 * Public domain (US Government); partner stations are credited by owner.
 * No CORS header: the native app only (see ../net.ts).
 */
import { getBuoyText } from '../net';
import { reading } from '../qc';
import type { BuoyObs, BuoyProvider } from '../types';

export const NDBC_LATEST_OBS_URL = 'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt';

export const ndbcSpecUrl = (stationId: string): string =>
    `https://www.ndbc.noaa.gov/data/5day2/${encodeURIComponent(stationId)}_5day.spec`;

/** [owner shown in the app, station ids]. Regenerate from station_table.txt. */
const OWNERS: ReadonlyArray<readonly [string, string]> = [
    [
        'NDBC',
        '41004 41008 41009 41010 41013 41025 41040 41041 41043 41044 41046 41047 41048 41049 42001 42002 42012 42035 42036 42039 42055 42056 42057 42058 42060 44007 44008 44009 44011 44013 44014 44020 44025 44027 44065 45001 45002 45004 45005 45006 45012 46001 46002 46005 46006 46011 46012 46013 46014 46015 46022 46025 46026 46027 46028 46029 46035 46041 46042 46047 46050 46054 46059 46060 46061 46066 46069 46070 46071 46072 46073 46075 46076 46077 46078 46080 46081 46082 46083 46084 46085 46086 46087 46088 46089 51000 51001 51002 51003 51004 51101',
    ],
    [
        'Scripps CDIP',
        '41112 41113 41114 41120 41122 42084 42099 42354 44084 44088 44097 44099 44100 45210 45211 45215 46211 46213 46214 46215 46218 46219 46221 46222 46224 46225 46229 46232 46236 46237 46239 46243 46244 46248 46251 46253 46254 46256 46258 46267 46268 46274 46275 46277 46278 46285 LJPC1',
    ],
    [
        'Environment Canada',
        '44137 44139 44150 44258 44488 44489 45132 45135 45136 45137 45139 45140 45142 45143 45145 45147 45148 45149 45151 45152 45154 45159 46004 46036 46131 46132 46145 46146 46147 46181 46183 46184 46185 46204 46205 46206 46207 46208 46303 46304',
    ],
    [
        'UK offshore platform',
        '62114 62121 62124 62127 62130 62144 62145 62146 62148 62149 62164 62165 63110 63112 63115',
    ],
    ['CORMP', '41024 41029 41033 41037 41038 41064 41065 41066 41067 41068 41070 41076 41110 41159'],
    ['PacIOOS', '51201 51202 51205 51206 51209 51211 51212 51214 52201 52212 52213 52214 52216'],
    ['UK Met Office', '62029 62030 62050 62081 62105 62107 62163 62170 62304 62442 64045 64046'],
    ['FAA', 'KATP KBQX KGBK KGHB KGRY KGVW KIKT KSPR KVAF KVOA'],
    ['Cleveland Water Alliance', '45200 45201 45202 45203 45204 45205 45206 45207 45208'],
    ['Korea Met. Administration', '22101 22102 22103 22104 22105 22106 22107 22108'],
    ['LimnoTech', '45026 45029 45164 45165 45168 45176 45196 45197'],
    ['Michigan Tech', '45023 45025 45175 45194 45212 45213 45214 45216'],
    ['CBIBS', '44042 44058 44062 44063 44072 44080'],
    ['US Army Corps of Engineers', '41117 42095 44056 44091 46259 46266'],
    ['NERACOOS', '44029 44030 44032 44033 44034 44037'],
    ['COMPS (USF)', '42013 42022 42023 42026 42027 42028'],
    ['NSF OOI', '41082 41083 44079 46097 46099'],
    ['Univ. of Minnesota Duluth', '45027 45028 45217 45219'],
    ['CariCOOS', '41053 41056 41121 42085'],
    ['Univ. of Washington', '46120 46121 46123 46125'],
    ['NANOOS', '46118 46119 46128'],
    ['UW-Milwaukee', '45013 45014'],
    ['Woods Hole Group/NERACOOS', '44085 44090'],
    ['IISG/Purdue', '45170 45198'],
    ['UNC Coastal Studies Institute', '44086 44095'],
    ['U. Michigan CILER', '45022 45024'],
    ['Univ. of New Hampshire', '44074 44098'],
    ['U. of Illinois', '45186 45187'],
    ['SUNY Buffalo State', '45220'],
    ['NLR', '46286'],
    ['SUNY Plattsburgh', '45190'],
    ['AOOS', '46108'],
    ['National Park Service', '45183'],
    ['Illinois-Indiana Sea Grant', '45174'],
    ['MBARI', '46092'],
    ['APL-UW', '46246'],
    ['WHOI', '51WH0'],
    ['Bay Mills Indian Community', '4403587'],
    ['Flower Garden Banks NMS', '42358'],
    ['NOAA GLERL', '45161'],
    ['Texas A&M-CC CBI', '42092'],
    ['NOAA NOS', 'PHCT2'],
    ['Stony Brook University', '44069'],
    ['Great Lakes Water Authority', '45209'],
    ['Tampa Bay PORTS', '42098'],
    ['US Navy', '44087'],
    ['Salmon Unlimited Wisconsin', '45199'],
];

let ownerById: Map<string, string> | null = null;

/** Owners whose stations NDBC lists but which never measure waves (oil-platform airport weather). */
const NO_WAVES = new Set(['FAA']);

/** Who owns an NDBC-distributed station, or null when NDBC's table does not list it. */
export function ndbcOwner(stationId: string): string | null {
    if (!ownerById) {
        ownerById = new Map();
        for (const [owner, ids] of OWNERS) for (const id of ids.split(' ')) ownerById.set(id, owner);
    }
    return ownerById.get(stationId.toUpperCase()) ?? null;
}

/** A period of 0 (KMA sends DPD 0 on every row) is no period. */
const period = (raw: unknown): number | null => {
    const value = reading(raw);
    return value !== null && value > 0 ? value : null;
};

const coord = (raw: unknown): number => (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);

/** Header columns by name (NDBC has reordered columns before). */
function table(text: string): { cols: Map<string, number>; rows: string[][] } {
    const lines = text.split(/\r?\n/);
    const header = lines.find((line) => line.startsWith('#')) ?? '';
    const cols = new Map(
        header
            .replace(/^#/, '')
            .trim()
            .split(/\s+/)
            .map((name, i) => [name, i] as const),
    );
    const rows = lines
        .filter((line) => line.trim() !== '' && !line.startsWith('#'))
        .map((line) => line.trim().split(/\s+/));
    return { cols, rows };
}

function utc(cell: (name: string) => string | undefined, yearCol: string): number {
    let year = Number(cell(yearCol));
    if (year < 100) year += 2000;
    return Date.UTC(year, Number(cell('MM')) - 1, Number(cell('DD')), Number(cell('hh')), Number(cell('mm')));
}

/** Every station row in latest_obs.txt; hsM is null on a met-only row. */
export function parseNdbcLatestObs(text: string): BuoyObs[] {
    const { cols, rows } = table(text);
    if (!cols.has('STN') || !cols.has('WVHT')) return [];
    const out: BuoyObs[] = [];
    for (const row of rows) {
        const cell = (name: string): string | undefined => row[cols.get(name) ?? -1];
        const id = cell('STN');
        if (!id) continue;
        out.push({
            key: `ndbc:${id}`,
            network: 'ndbc',
            label: `NDBC ${id}`,
            owner: ndbcOwner(id),
            lat: coord(cell('LAT')),
            lon: coord(cell('LON')),
            time: utc(cell, 'YYYY'),
            hsM: reading(cell('WVHT')),
            periodS: period(cell('DPD')),
            fromDeg: reading(cell('MWD')),
            sstC: reading(cell('WTMP')),
        });
    }
    return out;
}

/**
 * The newest wave row of a 5-day spectral summary, placed at the station.
 * The period is the dominant partition's peak — the one carrying more energy,
 * which is how NDBC's own DPD falls (46026 on 2026-10-07: SwP 12.9 s vs DPD 13).
 */
export function parseNdbcSpecSummary(text: string, station: BuoyObs): BuoyObs | null {
    const { cols, rows } = table(text);
    for (const row of rows) {
        const cell = (name: string): string | undefined => row[cols.get(name) ?? -1];
        const hsM = reading(cell('WVHT'));
        if (hsM === null) continue;
        const swellM = reading(cell('SwH'));
        const windSeaM = reading(cell('WWH'));
        const swellLeads = swellM !== null && (windSeaM === null || swellM >= windSeaM);
        return {
            ...station,
            time: utc(cell, 'YY'),
            hsM,
            periodS: swellLeads ? period(cell('SwP')) : (period(cell('WWP')) ?? period(cell('SwP'))),
            fromDeg: reading(cell('MWD')),
        };
    }
    return null;
}

/** Only buoys and platforms NDBC lists can have a wave file: never a tide gauge, C-MAN light or airport. */
function mayHaveWaveFile(station: BuoyObs): boolean {
    const owner = ndbcOwner(station.key.slice('ndbc:'.length));
    return owner !== null && !NO_WAVES.has(owner);
}

export const ndbcProvider: BuoyProvider = {
    id: 'ndbc',
    name: 'NDBC',
    nativeOnly: true,
    // Every owner-table station sits inside a box (checked against
    // station_table.txt 2026-10-07; tests/buoyFeed.test.ts pins the outliers).
    coverage: [
        [5, -180, 72, -50], // North America, the Gulf, the Great Lakes, the Caribbean, Hawaii
        [5, -50, 25, -40], // tropical Atlantic (41041, 890 NM east of Martinique)
        [-20, -180, 30, -140], // central Pacific (American Samoa)
        [-20, 120, 30, 180], // western Pacific (Palau, Micronesia, Guam, Marshalls)
        [49, 170, 58, 180], // western Aleutians and the Bering Sea, west of the antimeridian
        [30, 120, 42, 135], // Korea
        [47, -18, 62, 5], // UK waters, the North Sea, the Celtic Sea and western Approaches
    ],
    async fetchLatest() {
        return parseNdbcLatestObs(await getBuoyText(NDBC_LATEST_OBS_URL, 'ndbc-latest-obs'));
    },
    canLookAgain: mayHaveWaveFile,
    async fetchWaves(station) {
        if (!mayHaveWaveFile(station)) return null;
        const id = station.key.slice('ndbc:'.length);
        try {
            return parseNdbcSpecSummary(await getBuoyText(ndbcSpecUrl(id), 'ndbc-spec'), station);
        } catch {
            // No spectral file (many partners have none): the nearest buoy WITH waves answers instead.
            return null;
        }
    },
};
