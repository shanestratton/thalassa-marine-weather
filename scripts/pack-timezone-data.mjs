/** Lossless representation change only. The original lookup function's code
 * stays byte-for-byte identical except its two private data initializers. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import MagicString from 'magic-string';

export const TZ_SOURCE_SHA256 = '906852259d2157fa80d44eaa8c170ab731ae6497a0a0a066452b79a43125c8d4';
export const TZ_GRID_SHA256 = '623da86083ac6d0de9bea26218a597091177ed016c6f74171273755e141b7799';
export const TZ_ZONES_SHA256 = '2f051ef999e6a2727ea57354c24e8f6180d4fab1d73dc63c1ad4216b8549d18b';
const MODULE = 'virtual:thalassa-timezone-data';
const RESOLVED = '\0' + MODULE;
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** @param {string} source @param {(code:string)=>any} parse */
export function packTimezoneSource(source, parse) {
    if (hash(source) !== TZ_SOURCE_SHA256) throw Error('Unreviewed tz-lookup source');
    const ast = parse(source),
        fn = ast.body[0];
    if (
        ast.body.length !== 2 ||
        fn.type !== 'FunctionDeclaration' ||
        fn.id.name !== 'tzlookup' ||
        ast.body[1].type !== 'ExpressionStatement'
    )
        throw Error('Unreviewed timezone function/export shape');
    const declarations = fn.body.body.flatMap((statement) =>
        statement.type === 'VariableDeclaration' ? statement.declarations : [],
    );
    const u = declarations.filter((item) => item.id.name === 'U'),
        t = declarations.filter((item) => item.id.name === 'T');
    if (
        u.length !== 1 ||
        t.length !== 1 ||
        u[0].init.type !== 'Literal' ||
        typeof u[0].init.value !== 'string' ||
        t[0].init.type !== 'ArrayExpression' ||
        t[0].init.elements.some((item) => item?.type !== 'Literal' || typeof item.value !== 'string')
    )
        throw Error('Unreviewed timezone data initializers');
    const grid = u[0].init.value,
        zones = t[0].init.elements.map((item) => item.value);
    if (hash(grid) !== TZ_GRID_SHA256 || hash(JSON.stringify(zones)) !== TZ_ZONES_SHA256)
        throw Error('Unreviewed timezone table contents');
    const payload = Buffer.from(JSON.stringify([grid, zones]));
    const compressed = deflateSync(payload, { level: 6, memLevel: 5 });
    const output = new MagicString(source);
    output.overwrite(u[0].init.start, u[0].init.end, '__tzTable[0]');
    output.overwrite(t[0].init.start, t[0].init.end, '__tzTable[1]');
    output.remove(ast.body[1].start, ast.body[1].end);
    output.prepend(
        `import {decodeTimezoneData} from '${MODULE}';const __tzTable=decodeTimezoneData(${JSON.stringify(compressed.toString('base64'))},${payload.length},${grid.length},${zones.length},${compressed.readUInt32BE(compressed.length - 4)});\n`,
    );
    output.append('\nexport default tzlookup;\n');
    return {
        code: output.toString(),
        map: output.generateMap({ source: 'tz.js', includeContent: true, hires: true }),
        grid,
        zones,
        payloadBytes: payload.length,
        compressedBytes: compressed.length,
        encoded: compressed.toString('base64'),
        checksum: compressed.readUInt32BE(compressed.length - 4),
    };
}

/** @param {string} root @returns {import('vite').Plugin} */
export function packTimezoneData(root) {
    const source = path.resolve(root, 'node_modules/tz-lookup/tz.js');
    let enabled = false;
    return {
        name: 'pack-timezone-data',
        apply: 'build',
        enforce: 'pre',
        configResolved(config) {
            enabled = config.isProduction;
            if (
                enabled &&
                JSON.parse(fs.readFileSync(path.resolve(source, '../package.json'), 'utf8')).version !== '6.1.25'
            )
                throw Error('Unreviewed tz-lookup package');
        },
        resolveId(id) {
            if (!enabled) return null;
            if (id === 'tz-lookup') return source;
            if (id === MODULE) return RESOLVED;
            return null;
        },
        load(id) {
            if (enabled && id === RESOLVED)
                return `export {decodeTimezoneData} from ${JSON.stringify(path.resolve(root, 'utils/decodeTimezoneData.ts'))};`;
            return null;
        },
        transform(code, id) {
            if (!enabled || path.resolve(id.split('?')[0]) !== source) return null;
            const result = packTimezoneSource(code, (value) => this.parse(value));
            return { code: result.code, map: result.map };
        },
    };
}
