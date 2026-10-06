/**
 * contextCore — the pure rules behind the Thalassa Ocean context layer
 * (historical public records from OBIS, shown muted under the fleet's own
 * sightings). build-context.mjs does the fetching; everything that decides
 * what may be shown lives here, so tests/ocean/OceanContextCore.test.ts can
 * pin it without a network.
 *
 * THE RULES (2026-10-06):
 *  - LICENCE: a dataset is used only when its OBIS intellectualrights text is
 *    exactly one of the known CC BY 4.0 or CC0 1.0 forms. Non-commercial,
 *    no-derivatives, share-alike, unlicensed and any wording we have not seen
 *    are all refused (fail closed: a new wording is excluded until a person
 *    reads it and adds it here).
 *  - RECORDS: only HumanObservation, PreservedSpecimen and Occurrence rows
 *    are kept (compared without case), so MachineObservation (acoustic
 *    receivers and satellite tags: one tagged animal would paint a whole bay)
 *    and eDNA material samples never appear. Absence records are dropped,
 *    and so is any dataset on the exclusion list: the QLD/NT turtle nesting
 *    census (nests on land, not animals at sea, and it would light up
 *    rookeries against our blur-the-nesting-beaches principle), and tracking
 *    datasets whose human rows are tag releases, not sightings. Undated
 *    records are dropped too: a record-day needs a day.
 *  - ATTRIBUTION: each dataset carries its licence deed, and a citation's
 *    "[month, year]" placeholder is filled from the dataset's published
 *    date (the Victorian Biodiversity Atlas requires the date).
 *  - MEASURE: record-days, distinct (dataset, UTC day) per cell, so a colony
 *    census of 60,000 rows on one day counts once, not 60,000 times.
 *  - MONTHS: a record counts toward a month only when its date span is at most
 *    31 days; a "1990-2000" record still counts toward the all-year total.
 *  - CELLS: 0.25 deg for most species, 0.5 deg for threatened ones (the
 *    sightings catalogue's sensitive flag; a species it doesn't know fails
 *    closed to 0.5). Cells are aligned to 0 deg, so none straddles the
 *    antimeridian, and 180 E is written as 180 W.
 *  - A species ships only with at least 50 clean records; otherwise it is
 *    listed as dropped, with the reason, on the page.
 */

export const MIN_RECORDS = 50;
export const CELL_DEG = 0.25;
export const SENSITIVE_CELL_DEG = 0.5;
export const MONTH_SPAN_MAX_MS = 31 * 86_400_000;

/**
 * The licence texts OBIS publishes for CC BY 4.0 and CC0 1.0, whitespace
 * collapsed. Measured 2026-10-06 across 149 east-coast datasets: these three
 * forms, plus the non-commercial ones (refused), plus one blank (refused).
 */
export const ALLOWED_LICENCE_TEXTS = Object.freeze({
    'This work is licensed under a Creative Commons Attribution (CC-BY) 4.0 License': 'CC BY 4.0',
    'This work is licensed under a Creative Commons Attribution (CC-BY 4.0) License': 'CC BY 4.0',
    'To the extent possible under law, the publisher has waived all rights to these data and has dedicated them to the Public Domain (CC0 1.0)':
        'CC0 1.0',
});

const collapse = (s) =>
    String(s ?? '')
        .replace(/\s+/g, ' ')
        .trim();

/** 'CC BY 4.0', 'CC0 1.0', or null (refused). */
export function licenceOf(intellectualRights) {
    return ALLOWED_LICENCE_TEXTS[collapse(intellectualRights)] ?? null;
}

/** The licence deeds, linked beside every credit (CC BY 4.0 3(a)(1)(C)). */
export const LICENCE_URLS = Object.freeze({
    'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0/',
    'CC0 1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
});

/** How the layer changes the originals, said on the page (CC BY 4.0 3(a)(1)(B)). */
export const MODIFICATION =
    'aggregated by Thalassa into 0.25 and 0.5 degree record-day cells by month, with absence, undated, machine-recorded, tracking and eDNA records removed; changed from the original records.';

const MONTH_NAMES = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
];

/** Fill a citation's "[month, year]" placeholder from the dataset's published date (UTC). */
export function fillCitation(text, published) {
    const t = Date.parse(String(published ?? ''));
    if (!Number.isFinite(t)) return text;
    const d = new Date(t);
    return String(text).replace(
        /\[\s*month\s*,\s*year\s*\]/gi,
        `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
    );
}

/** Datasets never used, whatever their licence. */
export const EXCLUDED_DATASETS = Object.freeze([
    {
        id: '6a2c5c17-40cf-444f-8fda-c78fa257116f',
        reason: 'land nesting census, not at-sea records',
    },
    {
        id: '0820b10a-5710-4e90-b9ed-a2ad7c7ec742',
        reason: 'acoustic tracking: its human rows are tag releases, not sightings',
    },
    {
        id: '48cb8624-a221-47ed-9a6d-b99b0bb394e0',
        reason: 'satellite tracking: its human rows are tag deployments, not sightings',
    },
    {
        id: 'e4dacf5c-6bfa-493e-8699-d65c31435107',
        reason: 'tag-based movement study, not sightings',
    },
    {
        id: 'b508f7bc-8708-43d5-b940-e44f2765d1af',
        reason: 'eDNA samples, not sightings',
    },
]);
const EXCLUDED_IDS = new Set(EXCLUDED_DATASETS.map((d) => d.id));
/** The only kinds of record kept (a whitelist, compared without case). */
export const KEPT_BASIS = Object.freeze(['HumanObservation', 'PreservedSpecimen', 'Occurrence']);
const KEPT_BASIS_LOWER = new Set(KEPT_BASIS.map((b) => b.toLowerCase()));

export function isExcludedDataset(id) {
    return EXCLUDED_IDS.has(String(id ?? '').toLowerCase());
}

/** Keep a raw OBIS occurrence? */
export function keepRecord(record) {
    if (!record || typeof record !== 'object') return false;
    if (!KEPT_BASIS_LOWER.has(String(record.basisOfRecord ?? '').toLowerCase())) return false;
    if (record.absence === true || String(record.absence).toLowerCase() === 'true') return false;
    const lat = Number(record.decimalLatitude);
    const lon = Number(record.decimalLongitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
    return Number.isFinite(Number(record.date_start));
}

/** The UTC day number of a record's start. */
export const dayOf = (record) => Math.floor(Number(record.date_start) / 86_400_000);

/** 1..12 when the record's date span is at most 31 days, else null. */
export function monthOf(record) {
    const start = Number(record.date_start);
    const end = Number.isFinite(Number(record.date_end)) ? Number(record.date_end) : start;
    if (!Number.isFinite(start) || end - start > MONTH_SPAN_MAX_MS || end < start) return null;
    return new Date(start).getUTCMonth() + 1;
}

export const yearOf = (record) => new Date(Number(record.date_start)).getUTCFullYear();

const round = (v) => Math.round(v * 1e6) / 1e6;

/**
 * The centre of the cell a coordinate falls in, on a grid aligned to 0 deg.
 * Longitude 180 is written as -180 first, so every cell centre is inside
 * (-180, 180) and none straddles the antimeridian.
 */
export function cellCentre(value, deg, isLongitude = false) {
    let v = Number(value);
    if (isLongitude && v >= 180) v -= 360;
    // A hair of slack so a value exactly on an edge (in binary) lands in the
    // same cell every time.
    const index = Math.floor(round(v / deg) + 1e-9);
    return round((index + 0.5) * deg);
}

/** The cell size for a species: threatened (or unknown) species get the coarse grid. */
export function cellDegFor(catalogueEntry) {
    if (!catalogueEntry) return SENSITIVE_CELL_DEG;
    return catalogueEntry.sensitive === false ? CELL_DEG : SENSITIVE_CELL_DEG;
}

/**
 * Aggregate one species' kept records ({datasetId, record}) into cells of
 * record-days. Returns { records, recordDays, years, months, cells } with
 * cells as [lat, lon, days] or [lat, lon, days, [m1..m12]] (months only when
 * a cell has any month-dated record), sorted by lat then lon.
 */
export function aggregateSpecies(items, deg) {
    const cells = new Map();
    const allDays = new Set();
    const monthDays = Array.from({ length: 12 }, () => new Set());
    let minYear = Infinity;
    let maxYear = -Infinity;
    let records = 0;
    for (const { datasetId, record } of items) {
        if (!keepRecord(record)) continue;
        records += 1;
        const lat = cellCentre(record.decimalLatitude, deg);
        const lon = cellCentre(record.decimalLongitude, deg, true);
        const key = `${lat},${lon}`;
        let cell = cells.get(key);
        if (!cell) {
            cell = { lat, lon, days: new Set(), months: Array.from({ length: 12 }, () => new Set()) };
            cells.set(key, cell);
        }
        const recordDay = `${datasetId}|${dayOf(record)}`;
        cell.days.add(recordDay);
        allDays.add(`${key}|${recordDay}`);
        const month = monthOf(record);
        if (month) {
            cell.months[month - 1].add(recordDay);
            monthDays[month - 1].add(`${key}|${recordDay}`);
        }
        const year = yearOf(record);
        if (year < minYear) minYear = year;
        if (year > maxYear) maxYear = year;
    }
    const out = [...cells.values()]
        .sort((a, b) => a.lat - b.lat || a.lon - b.lon)
        .map((cell) => {
            const months = cell.months.map((s) => s.size);
            return months.some((m) => m > 0)
                ? [cell.lat, cell.lon, cell.days.size, months]
                : [cell.lat, cell.lon, cell.days.size];
        });
    return {
        records,
        recordDays: allDays.size,
        years: records > 0 ? [minYear, maxYear] : null,
        months: monthDays.map((s) => s.size),
        cells: out,
    };
}

/** Decode the few HTML entities OBIS citations carry (an encoding artifact, not content). */
export function cleanCitation(text) {
    return collapse(
        String(text ?? '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'"),
    );
}

/** Why a species is dropped, or null when it ships. */
export function dropReason(records, totalSeen) {
    if (records >= MIN_RECORDS) return null;
    if (totalSeen === 0) return 'no CC0 or CC BY records in this region';
    return `only ${records} licence-clean at-sea record${records === 1 ? '' : 's'} (needs ${MIN_RECORDS})`;
}
