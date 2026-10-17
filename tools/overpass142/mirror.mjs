/** Exact pure-contract mirror; never updates runtime environment or devices. */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const source = new URL('../../services/osm/ownedOverpassContract.ts', import.meta.url);
const target = new URL('../../pi-cache/src/ownedOsmContract.ts', import.meta.url);
const bytes = fs.readFileSync(source);
if (process.argv.includes('--check')) {
    if (!fs.existsSync(target) || !bytes.equals(fs.readFileSync(target)))
        throw Error('Owned OSM contract mirror drift');
} else fs.writeFileSync(target, bytes);
console.log(
    JSON.stringify({
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        check: process.argv.includes('--check'),
    }),
);
