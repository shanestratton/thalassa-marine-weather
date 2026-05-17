import { readFile } from 'node:fs/promises';
import { parseSenc, SencFeature } from './featureParser.js';

async function main() {
    const file = process.argv[2];
    if (!file) {
        console.error('usage: extract <senc-file> [--filter ACRONYM,...] [--sample N]');
        process.exit(1);
    }
    const filterArg = process.argv.find((a) => a.startsWith('--filter='));
    const filters = filterArg ? new Set(filterArg.split('=')[1].split(',')) : null;
    const sampleArg = process.argv.find((a) => a.startsWith('--sample='));
    const sample = sampleArg ? Number(sampleArg.split('=')[1]) : 5;

    const buf = await readFile(file);
    const { header, features, stats } = parseSenc(buf);

    console.log('=== Header ===');
    console.log(JSON.stringify(header, null, 2));
    console.log();

    console.log('=== Stats ===');
    console.log(`Total records walked: ${stats.totalRecords}`);
    console.log(`Total features collected: ${features.length}`);
    console.log('Geometries by primitive:', stats.geometriesByPrimitive);
    console.log();
    console.log('Features by class (top 15):');
    const rows = [...stats.featuresByClass.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [acronym, count] of rows) {
        console.log(`  ${acronym.padEnd(10)} ${String(count).padStart(6)}`);
    }
    if (stats.unknownAttrCodes.size > 0) {
        console.log();
        console.log(`Unknown attr codes encountered: ${[...stats.unknownAttrCodes].sort((a, b) => a - b).join(', ')}`);
    }
    if (stats.triPrimitiveTypes.size > 0) {
        const tris = [...stats.triPrimitiveTypes.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([t, c]) => `${t}:${c}`)
            .join(' ');
        console.log(`Triangle primitive types seen: ${tris}  (GL_TRIANGLES=4 STRIP=5 FAN=6)`);
    }
    if (stats.linesResolved !== undefined || stats.linesUnresolvable !== undefined) {
        console.log(`Lines resolved: ${stats.linesResolved ?? 0}  unresolvable: ${stats.linesUnresolvable ?? 0}`);
    }
    if (stats.areasResolved !== undefined || stats.areasUnresolvable !== undefined) {
        console.log(`Areas resolved: ${stats.areasResolved ?? 0}  unresolvable: ${stats.areasUnresolvable ?? 0}`);
    }

    const wanted = filters ? features.filter((f) => filters.has(f.acronym)) : features;

    console.log();
    console.log(`=== Sample ${sample} features (filter=${filters ? [...filters].join(',') : 'ALL'}) ===`);
    for (const f of wanted.slice(0, sample)) {
        console.log(formatFeature(f));
        console.log();
    }
}

function formatFeature(f: SencFeature): string {
    const geom = f.geometry ? geomSummary(f.geometry) : '(no geometry)';
    const attrs =
        Object.keys(f.attributes).length === 0
            ? '(no attrs)'
            : Object.entries(f.attributes)
                  .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                  .join(', ');
    return `${f.acronym} RCID=${f.rcid} prim=${f.primitive}\n  geom: ${geom}\n  attrs: ${attrs}`;
}

function geomSummary(g: NonNullable<SencFeature['geometry']>): string {
    switch (g.type) {
        case 'Point':
            return `Point [${g.coordinates[0].toFixed(6)}, ${g.coordinates[1].toFixed(6)}]`;
        case 'MultiPoint': {
            const first = g.coordinates[0];
            const firstStr = first
                ? ` first=[${first[0].toFixed(5)}, ${first[1].toFixed(5)}, d=${first[2].toFixed(1)}m]`
                : '';
            return `MultiPoint count=${g.coordinates.length}${firstStr}`;
        }
        case 'Area': {
            const totalPts = g.rings.reduce((acc, r) => acc + r.length, 0);
            const first = g.rings[0]?.[0];
            const firstStr = first ? ` v0=[${first[0].toFixed(5)}, ${first[1].toFixed(5)}]` : '';
            return `Area rings=${g.rings.length} pts=${totalPts}${firstStr} bbox=[${g.extent.wLon.toFixed(4)}, ${g.extent.sLat.toFixed(4)}, ${g.extent.eLon.toFixed(4)}, ${g.extent.nLat.toFixed(4)}]`;
        }
        case 'AreaRaw':
            return `AreaRaw contours=${g.contourCount} edges=${g.edgeVectorCount} (UNRESOLVED) bbox=[${g.extent.wLon.toFixed(4)}, ${g.extent.sLat.toFixed(4)}, ${g.extent.eLon.toFixed(4)}, ${g.extent.nLat.toFixed(4)}]`;
        case 'Line': {
            const first = g.coordinates[0];
            const firstStr = first ? ` first=[${first[0].toFixed(5)}, ${first[1].toFixed(5)}]` : '';
            return `Line points=${g.coordinates.length}${firstStr} bbox=[${g.extent.wLon.toFixed(4)}, ${g.extent.sLat.toFixed(4)}, ${g.extent.eLon.toFixed(4)}, ${g.extent.nLat.toFixed(4)}]`;
        }
        case 'LineRaw':
            return `LineRaw edges=${g.edgeVectorCount} (UNRESOLVED) bbox=[${g.extent.wLon.toFixed(4)}, ${g.extent.sLat.toFixed(4)}, ${g.extent.eLon.toFixed(4)}, ${g.extent.nLat.toFixed(4)}]`;
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
