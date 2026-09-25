#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SERVICE_LAYER =
    'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Location/QldPlaceNames/MapServer/1';
const QUERY_ENDPOINT = `${SERVICE_LAYER}/query`;
const DATASET_METADATA = 'https://www.data.qld.gov.au/api/3/action/package_show?id=place-names-gazetteer-queensland';
const OUTPUT_PATH = fileURLToPath(new URL('../data/marine-place-names-qld.json', import.meta.url));

const SOURCE_TYPES = ['IS', 'BAY', 'COVE', 'HBR', 'ANCH'];
const KIND_BY_SOURCE_TYPE = {
    IS: 'island',
    BAY: 'bay',
    COVE: 'cove',
    HBR: 'harbour',
    ANCH: 'anchorage',
};
const PAGE_SIZE = 500;
const MAX_EXPECTED_RECORDS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_METADATA_BYTES = 2_000_000;
const MAX_QUERY_BYTES = 5_000_000;
const WHERE = `status = 'Y' AND currency = 'Y' AND type IN (${SOURCE_TYPES.map((type) => `'${type}'`).join(',')})`;

function queryUrl(params) {
    const url = new URL(QUERY_ENDPOINT);
    for (const [key, value] of Object.entries({ f: 'json', where: WHERE, ...params })) {
        url.searchParams.set(key, String(value));
    }
    return url;
}

async function fetchJson(url, label, maxBytes) {
    const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error(`${label}: declared response is ${declaredLength} bytes (limit ${maxBytes})`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
        throw new Error(`${label}: response is ${bytes.byteLength} bytes (limit ${maxBytes})`);
    }

    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (payload?.error) {
        throw new Error(
            `${label}: ArcGIS ${payload.error.code ?? 'error'}: ${payload.error.message ?? 'unknown error'}`,
        );
    }
    return payload;
}

function requireFields(layer) {
    const actual = new Set((layer.fields ?? []).map((field) => field.name));
    const required = [
        'ref_no',
        'place_name',
        'type',
        'description',
        'status',
        'currency',
        'longitude_dd',
        'latitude_dd',
        'objectid',
    ];
    const missing = required.filter((field) => !actual.has(field));
    if (missing.length > 0) throw new Error(`Layer is missing required fields: ${missing.join(', ')}`);
}

function toRow(feature) {
    const attributes = feature?.attributes ?? {};
    const sourceRef = attributes.ref_no;
    const name = typeof attributes.place_name === 'string' ? attributes.place_name.trim() : '';
    const kind = KIND_BY_SOURCE_TYPE[attributes.type];
    const lat = feature?.geometry?.y;
    const lon = feature?.geometry?.x;

    if (!Number.isInteger(sourceRef) || sourceRef <= 0) throw new Error(`Invalid ref_no: ${sourceRef}`);
    if (!name) throw new Error(`Empty place_name for ref_no ${sourceRef}`);
    if (!kind) throw new Error(`Unexpected type ${attributes.type} for ref_no ${sourceRef}`);
    if (attributes.status !== 'Y' || attributes.currency !== 'Y') {
        throw new Error(`Non-current place passed the query filter: ref_no ${sourceRef}`);
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
        throw new Error(`Invalid EPSG:4326 geometry for ref_no ${sourceRef}`);
    }

    return {
        id: `qld-place-name:${sourceRef}`,
        name,
        kind,
        lat: Number(lat.toFixed(7)),
        lon: Number(lon.toFixed(7)),
    };
}

async function loadRows() {
    const [layer, licence] = await Promise.all([
        fetchJson(`${SERVICE_LAYER}?f=pjson`, 'layer metadata', MAX_METADATA_BYTES),
        fetchJson(DATASET_METADATA, 'Queensland Open Data metadata', MAX_METADATA_BYTES),
    ]);

    requireFields(layer);
    if (layer.geometryType !== 'esriGeometryPoint') throw new Error(`Unexpected geometry type: ${layer.geometryType}`);
    if (layer.sourceSpatialReference?.latestWkid !== 7844) {
        throw new Error(`Expected GDA2020 (EPSG:7844), got ${layer.sourceSpatialReference?.latestWkid ?? 'unknown'}`);
    }
    if (layer.advancedQueryCapabilities?.supportsPagination !== true) {
        throw new Error('Layer no longer advertises pagination support');
    }
    if (!Number.isInteger(layer.maxRecordCount) || layer.maxRecordCount < PAGE_SIZE) {
        throw new Error(`Layer maxRecordCount ${layer.maxRecordCount ?? 'unknown'} is below page size ${PAGE_SIZE}`);
    }
    if (
        licence?.success !== true ||
        licence?.result?.license_id !== 'CC-BY-4.0' ||
        licence?.result?.license_title !== 'Creative Commons Attribution 4.0'
    ) {
        throw new Error(
            `Expected Queensland Open Data CC BY 4.0 licence, got ${licence?.result?.license_id ?? 'unknown'}`,
        );
    }

    const [countPayload, idsPayload] = await Promise.all([
        fetchJson(queryUrl({ returnCountOnly: true }), 'eligible record count', MAX_QUERY_BYTES),
        fetchJson(queryUrl({ returnIdsOnly: true }), 'eligible object IDs', MAX_QUERY_BYTES),
    ]);
    const expectedCount = countPayload.count;
    const expectedObjectIds = idsPayload.objectIds;
    if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > MAX_EXPECTED_RECORDS) {
        throw new Error(`Eligible count ${expectedCount} is outside the reviewed range 1-${MAX_EXPECTED_RECORDS}`);
    }
    if (!Array.isArray(expectedObjectIds) || expectedObjectIds.length !== expectedCount) {
        throw new Error(
            `Object ID count ${expectedObjectIds?.length ?? 'invalid'} does not match count ${expectedCount}`,
        );
    }
    if (new Set(expectedObjectIds).size !== expectedObjectIds.length) {
        throw new Error('Object ID query returned duplicates');
    }

    const features = [];
    for (let offset = 0; offset < expectedCount; offset += PAGE_SIZE) {
        const page = await fetchJson(
            queryUrl({
                outFields: 'ref_no,place_name,type,status,currency,objectid',
                returnGeometry: true,
                outSR: 4326,
                geometryPrecision: 7,
                orderByFields: 'objectid ASC',
                resultOffset: offset,
                resultRecordCount: PAGE_SIZE,
            }),
            `records ${offset + 1}-${Math.min(offset + PAGE_SIZE, expectedCount)}`,
            MAX_QUERY_BYTES,
        );
        if (page.spatialReference?.latestWkid !== 4326 && page.spatialReference?.wkid !== 4326) {
            throw new Error(`Page at offset ${offset} was not returned in EPSG:4326`);
        }
        if (!Array.isArray(page.features) || page.features.length === 0 || page.features.length > PAGE_SIZE) {
            throw new Error(`Invalid page length ${page.features?.length ?? 'unknown'} at offset ${offset}`);
        }
        features.push(...page.features);
    }

    if (features.length !== expectedCount) {
        throw new Error(`Fetched ${features.length} records, expected ${expectedCount}`);
    }
    const fetchedObjectIds = features.map((feature) => feature.attributes?.objectid);
    if (new Set(fetchedObjectIds).size !== fetchedObjectIds.length) {
        throw new Error('Paginated query returned duplicate object IDs');
    }
    const expectedIdSet = new Set(expectedObjectIds);
    const fetchedIdSet = new Set(fetchedObjectIds);
    const missingObjectIds = expectedObjectIds.filter((id) => !fetchedIdSet.has(id));
    const unexpectedObjectIds = fetchedObjectIds.filter((id) => !expectedIdSet.has(id));
    if (missingObjectIds.length > 0 || unexpectedObjectIds.length > 0) {
        throw new Error(
            `Pagination mismatch: missing=${missingObjectIds.slice(0, 10).join(',') || 'none'}; ` +
                `unexpected=${unexpectedObjectIds.slice(0, 10).join(',') || 'none'}`,
        );
    }

    // The live layer contains a handful of output-identical point rows with
    // different object IDs but the same stable ref_no. Collapse only exact
    // place duplicates; a reused ref_no with a different name, kind or
    // coordinate is a source ambiguity and must stop the refresh for review.
    const rowsById = new Map();
    for (const feature of features) {
        const row = toRow(feature);
        const previous = rowsById.get(row.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(row)) {
            throw new Error(`Source ref ${row.id} identifies different place rows`);
        }
        rowsById.set(row.id, row);
    }
    const rows = [...rowsById.values()].sort((a, b) => Number(a.id.split(':')[1]) - Number(b.id.split(':')[1]));
    return { rows, sourceRecordCount: expectedCount };
}

const args = new Set(process.argv.slice(2));
const unknownArgs = [...args].filter((arg) => arg !== '--check');
if (unknownArgs.length > 0) throw new Error(`Unknown argument(s): ${unknownArgs.join(', ')}`);

const { rows, sourceRecordCount } = await loadRows();
const serialized = `${JSON.stringify(rows, null, 4)}\n`;
if (args.has('--check')) {
    const current = await readFile(OUTPUT_PATH, 'utf8');
    if (current !== serialized) throw new Error('Bundled gazetteer is stale; run this script without --check');
} else {
    await writeFile(OUTPUT_PATH, serialized, 'utf8');
}

const counts = Object.fromEntries(Object.values(KIND_BY_SOURCE_TYPE).map((kind) => [kind, 0]));
for (const row of rows) counts[row.kind] += 1;
console.log(
    `${args.has('--check') ? 'Verified' : 'Wrote'} ${rows.length} current marine place names ` +
        `from ${sourceRecordCount} complete source records: ` +
        Object.entries(counts)
            .map(([kind, count]) => `${kind}=${count}`)
            .join(', '),
);
