/* global AbortSignal -- a Node global (v15+) the lint env does not declare */
/** Manual refresh; no scheduler or boat-location upload. Run before a release.
 * Reject partial/error responses so a bad refresh cannot erase the good copy. */
import { mkdir, writeFile, rename } from 'node:fs/promises';
const source =
    'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Environment/ParksMarineMoorings/FeatureServer/20';
const url = new URL(`${source}/query`);
url.search = new URLSearchParams({
    f: 'geojson',
    where: '1=1',
    outFields: 'objectid,site,site_and_mooring_reference_numb,mooring_class',
    outSR: '4326',
    resultRecordCount: '4000',
}).toString();
const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
if (!res.ok) throw new Error(`QPWS returned HTTP ${res.status}`);
const data = await res.json();
if (
    !Array.isArray(data.features) ||
    data.features.length < 100 ||
    data.exceededTransferLimit ||
    data.properties?.exceededTransferLimit ||
    data.error
)
    throw new Error('Incomplete QPWS data; previous snapshot retained');
const directory = new URL('../../public/anchorages/moorings/', import.meta.url);
await mkdir(directory, { recursive: true });
const snapshot = {
    source,
    attribution: '© State of Queensland (Department of Environment and Science) 2024',
    retrievedAt: new Date().toISOString(),
    data,
};
await writeFile(new URL('qpws.json.tmp', directory), JSON.stringify(snapshot));
await rename(new URL('qpws.json.tmp', directory), new URL('qpws.json', directory));
console.log(`QPWS: ${data.features.length} public moorings. Retrieved ${snapshot.retrievedAt}.`);
