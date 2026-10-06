#!/usr/bin/env node
/**
 * build-context — the Thalassa Ocean context layer: historical public records
 * of a handful of flagship species, from OBIS, aggregated to coarse cells by
 * month, licence-clean only (CC0 1.0 or CC BY 4.0). The rules are in
 * contextCore.mjs; this file fetches, applies them and writes one JSON file.
 *
 *   node scripts/ocean/build-context.mjs --built 2026-10-06 [--cache <dir>] [--out <file>]
 *
 * --built is the date stamped into the file (passed, not read from the clock,
 * so the same inputs always give the same bytes). --cache keeps raw OBIS
 * responses between runs (a scratch directory, never the repo).
 *
 * Output: public/ocean-data/context/au-east.v1.json, served same-origin by the
 * page. When the layer goes global (many MB) it moves to
 * https://tiles.thalassatiles.com/ocean/v1/context/<region>.json (bucket
 * thalassa-relief, prefix ocean/), uploaded by hand, and the page follows
 * VITE_OCEAN_DATA_BASE. This script never uploads anything.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    aggregateSpecies,
    cellDegFor,
    cleanCitation,
    dropReason,
    EXCLUDED_DATASETS,
    fillCitation,
    isExcludedDataset,
    KEPT_BASIS,
    keepRecord,
    LICENCE_URLS,
    licenceOf,
    MIN_RECORDS,
    MODIFICATION,
} from './contextCore.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = 'https://api.obis.org/v3';
const UA = 'ThalassaOcean/1 (+https://ocean.thalassawx.app)';

/**
 * The region this file covers. More regions are more files; nothing here is
 * Queensland-only. Its notes (what is missing here, and why) travel in the
 * file, so the page never hard-codes one region's caveats.
 */
const REGION = {
    id: 'au-east',
    name: 'East coast of Australia',
    wkt: 'POLYGON((140 -44,165 -44,165 -9,140 -9,140 -44))',
    notes: [
        'Most licence-clean whale and dolphin records here come from New South Wales and Victoria. Queensland’s WildNet, Happywhale and iNaturalist records are licensed non-commercial, so they are not shown.',
    ],
};

/**
 * Flagship candidates. A species ships only if licence-clean data clears
 * MIN_RECORDS; the rest are listed as dropped, with the reason.
 */
const CANDIDATES = [
    'Megaptera novaeangliae',
    'Orcinus orca',
    'Balaenoptera acutorostrata',
    'Tursiops aduncus',
    'Tursiops truncatus',
    'Sousa sahulensis',
    'Orcaella heinsohni',
    'Dugong dugon',
    'Chelonia mydas',
    'Caretta caretta',
    'Eretmochelys imbricata',
    'Natator depressus',
    'Mobula alfredi',
    'Mobula birostris',
    'Rhincodon typus',
    'Galeocerdo cuvier',
    'Carcharias taurus',
    'Sula leucogaster',
    'Ardenna pacifica',
    'Fregata minor',
];

function args(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i];
        if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
        out[key.slice(2)] = argv[i + 1];
        i += 1;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.built ?? '')) throw new Error('--built YYYY-MM-DD is required');
    return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** GET JSON, sequentially, with backoff; cached by name when --cache is set. */
async function getJson(url, cacheDir, cacheName) {
    const cached = cacheDir && cacheName ? path.join(cacheDir, cacheName) : null;
    if (cached && existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
            const response = await fetch(url, {
                headers: { 'user-agent': UA, accept: 'application/json' },
                signal: globalThis.AbortSignal.timeout(120_000),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
            const body = await response.json();
            if (cached) writeFileSync(cached, JSON.stringify(body));
            return body;
        } catch (error) {
            lastError = error;
            await sleep(3000 * (attempt + 1));
        }
    }
    throw lastError;
}

async function taxonId(name, cacheDir) {
    const body = await getJson(
        `${API}/taxon/${encodeURIComponent(name)}`,
        cacheDir,
        `taxon_${name.replace(/\W+/g, '_')}.json`,
    );
    const hit = (body.results ?? []).find((t) => t.scientificName === name && /^species$/i.test(t.taxonRank ?? ''));
    if (!hit) throw new Error(`OBIS has no species-rank taxon named ${name}`);
    return hit.taxonID;
}

async function datasetsFor(taxon, cacheDir) {
    const q = new URLSearchParams({ taxonid: String(taxon), geometry: REGION.wkt });
    const body = await getJson(`${API}/dataset?${q}`, cacheDir, `datasets_${taxon}.json`);
    const results = body.results ?? [];
    if (typeof body.total === 'number' && body.total !== results.length) {
        throw new Error(`dataset listing for ${taxon} is paged (${results.length} of ${body.total}); add paging`);
    }
    return results;
}

async function occurrences(taxon, datasetId, cacheDir) {
    const cached = cacheDir ? path.join(cacheDir, `${taxon}_${datasetId}.json`) : null;
    if (cached && existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
    const rows = [];
    let after = null;
    for (;;) {
        const q = new URLSearchParams({
            taxonid: String(taxon),
            datasetid: datasetId,
            geometry: REGION.wkt,
            size: '10000',
            fields: 'id,decimalLatitude,decimalLongitude,date_start,date_end,basisOfRecord,absence',
        });
        if (after) q.set('after', after);
        const body = await getJson(`${API}/occurrence?${q}`, null, null);
        const page = body.results ?? [];
        rows.push(...page);
        if (page.length < 10000) break;
        after = page[page.length - 1].id;
    }
    if (cached) writeFileSync(cached, JSON.stringify(rows));
    return rows;
}

function catalogue() {
    const file = path.join(ROOT, 'data', 'sightings', 'species-qld-gbr.v1.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return new Map(data.species.map((s) => [s.scientificName, s]));
}

async function main() {
    const opts = args(process.argv.slice(2));
    const cacheDir = opts.cache ? path.resolve(opts.cache) : null;
    if (cacheDir) mkdirSync(cacheDir, { recursive: true });
    const outFile = path.resolve(
        opts.out ?? path.join(ROOT, 'public', 'ocean-data', 'context', `${REGION.id}.v1.json`),
    );
    const known = catalogue();

    const species = [];
    const dropped = [];
    const datasetMeta = new Map();
    const datasetUse = new Map();

    for (const sci of CANDIDATES) {
        const entry = known.get(sci);
        const aphiaId = await taxonId(sci, cacheDir);
        const listing = await datasetsFor(aphiaId, cacheDir);
        const items = [];
        let seen = 0;
        for (const ds of listing) {
            const licence = licenceOf(ds.intellectualrights);
            if (!licence || isExcludedDataset(ds.id)) continue;
            const rows = await occurrences(aphiaId, ds.id, cacheDir);
            seen += rows.length;
            for (const record of rows) items.push({ datasetId: ds.id, record });
            datasetMeta.set(ds.id, { ...ds, licence });
        }
        const deg = cellDegFor(entry);
        const agg = aggregateSpecies(items, deg);
        const name = entry?.vernacularName ?? sci;
        const reason = dropReason(agg.records, seen);
        if (reason) {
            dropped.push({ sci, name, records: agg.records, reason });
            console.log(`drop ${sci}: ${reason}`);
            continue;
        }
        for (const { datasetId, record } of items) {
            if (!keepRecord(record)) continue;
            const use = datasetUse.get(datasetId) ?? { records: 0, species: new Set() };
            use.records += 1;
            use.species.add(sci);
            datasetUse.set(datasetId, use);
        }
        species.push({
            sci,
            name,
            group: entry?.group ?? 'other',
            aphiaId,
            sensitive: entry ? entry.sensitive !== false : true,
            cellDeg: deg,
            records: agg.records,
            recordDays: agg.recordDays,
            years: agg.years,
            months: agg.months,
            cells: agg.cells,
        });
        console.log(`keep ${sci}: ${agg.records} records, ${agg.recordDays} record-days, ${agg.cells.length} cells`);
    }

    const datasets = [...datasetUse.entries()]
        .map(([id, use]) => {
            const ds = datasetMeta.get(id);
            const institutes = (ds.institutes ?? []).map((i) => i?.name).filter(Boolean);
            const title = cleanCitation(ds.title) || id;
            const citation = fillCitation(
                cleanCitation(ds.citation) || `${title}. ${institutes.join(', ')}. ${ds.url ?? ''}`.trim(),
                ds.published,
            );
            if (/\[[^\]]*\]/.test(citation)) console.warn(`check the citation of ${id}: ${citation}`);
            return {
                id,
                title,
                institutes,
                licence: ds.licence,
                licenceUrl: LICENCE_URLS[ds.licence],
                citation,
                url: `https://obis.org/dataset/${id}`,
                records: use.records,
                species: [...use.species].sort(),
            };
        })
        .sort((a, b) => a.id.localeCompare(b.id));

    const { notes, ...region } = REGION;
    const out = {
        schema: 'thalassa-ocean-context',
        v: 1,
        region,
        notes,
        built: opts.built,
        source: 'OBIS https://api.obis.org/v3',
        licencePolicy: 'CC0 1.0 or CC BY 4.0 only; NC/ND/SA/unlicensed excluded',
        modification: `Records ${MODIFICATION}`,
        keptBasisOfRecord: [...KEPT_BASIS],
        excluded: {
            absence: true,
            undated: true,
            datasets: [...EXCLUDED_DATASETS],
        },
        measure: 'record-days (distinct dataset x day per cell)',
        minRecords: MIN_RECORDS,
        species: species.sort((a, b) => a.sci.localeCompare(b.sci)),
        dropped: dropped.sort((a, b) => a.sci.localeCompare(b.sci)),
        datasets,
        citation:
            'OBIS (2026) Ocean Biodiversity Information System. Intergovernmental Oceanographic Commission of UNESCO. https://obis.org',
    };
    mkdirSync(path.dirname(outFile), { recursive: true });
    // One species, dropped species or dataset per line: small, diffable, and
    // still plain JSON.
    const lines = JSON.stringify({ ...out, species: [], dropped: [], datasets: [] }).replace(
        /"species":\[\],"dropped":\[\],"datasets":\[\]/,
        () =>
            ['species', 'dropped', 'datasets']
                .map((key) => `"${key}":[\n${out[key].map((x) => JSON.stringify(x)).join(',\n')}\n]`)
                .join(',\n'),
    );
    writeFileSync(outFile, `${lines}\n`);
    console.log(
        `wrote ${path.relative(ROOT, outFile)}: ${species.length} species, ${dropped.length} dropped, ${datasets.length} datasets`,
    );
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
