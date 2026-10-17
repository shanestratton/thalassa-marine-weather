/** Two reviewed local inventories only. Preserve every metadata field, row,
 * field and ordering; use the existing bounded pure decoder in counted JS. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { packClassNames } from './share-class-names.mjs';

export const RELIEF_ROW_SOURCES = Object.freeze({
    'au250-v2.json': 'dd66f32ef5981ac8297a3a90627820c3f2ddb1cd5394a8f9afab28309e903727',
    'nz-v2.json': 'edf5227268b360cf5f195d4b477e0779faf42da9001ce9bd7fd254effdb2f08b',
});
const metadata = ['schema', 'region', 'version', 'minzoom', 'maxzoom', 'tilePairs'];
/** @param {string} raw @param {string} name */
export function packReliefRows(raw, name) {
    const source = Object.entries(RELIEF_ROW_SOURCES).find(([file]) => file === name);
    if (!source || createHash('sha256').update(raw.replace(/\r\n/g, '\n')).digest('hex') !== source[1])
        throw Error('Unreviewed canonical relief row source');
    const value = JSON.parse(raw);
    if (
        JSON.stringify(Object.keys(value)) !== JSON.stringify([...metadata, 'rows']) ||
        !Array.isArray(value.rows) ||
        value.rows.length > 4096 ||
        value.rows.some((row) => !Array.isArray(row) || row.length !== 4 || row.some((n) => !Number.isSafeInteger(n)))
    )
        throw Error('Unreviewed canonical relief row structure');
    const packed = packClassNames(value.rows.map((row) => row.join(',')));
    const declarations = metadata.map((key) => `export const ${key}=${JSON.stringify(value[key])};`).join('');
    return {
        ...packed,
        code:
            `import {decodeClassNames} from 'virtual:thalassa-class-data-decoder';${declarations}` +
            `export const rows=decodeClassNames(${JSON.stringify(packed.encoded)},${packed.bytes},${packed.count},${packed.checksum}).map(row=>row.split(',').map(Number));` +
            `export default {${metadata.join(',')},rows};`,
    };
}

/** Run before JSON loading so the normal bundler hashes the final module.
 * Asset/query imports and all unrelated JSON retain Vite's original path.
 * @param {string} root
 * @returns {import('vite').Plugin} */
export function packReliefInventories(root) {
    const entries = new Map(
        Object.keys(RELIEF_ROW_SOURCES).map((name) => [
            path.resolve(root, 'data/relief', name).replaceAll('\\', '/'),
            { name, id: '\0thalassa:relief-rows:' + name.replace('.json', '') },
        ]),
    );
    let enabled = false;
    return {
        name: 'pack-reviewed-relief-rows',
        apply: 'build',
        enforce: 'pre',
        configResolved(config) {
            enabled = config.isProduction && !config.isWorker;
        },
        async resolveId(source, importer, options) {
            if (!enabled || !importer || !source.endsWith('.json') || source.includes('?')) return null;
            const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
            return resolved ? (entries.get(resolved.id.replaceAll('\\', '/'))?.id ?? null) : null;
        },
        load(id) {
            if (!enabled) return null;
            for (const [file, entry] of entries)
                if (entry.id === id) return packReliefRows(fs.readFileSync(file, 'utf8'), entry.name).code;
            return null;
        },
    };
}
