/** Lossless representation change for the public model catalogue only. The
 * polar generator/factory/search code stays untouched. Unknown source bytes
 * or argument shapes require a fresh review instead of an approximate table. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import MagicString from 'magic-string';
import { packClassNames } from './share-class-names.mjs';

export const POLAR_SOURCE_SHA = 'bb5ceb29ca4bcb6d96be8c7fd4ccdffbf49933d9fdf4236a9c5f8b2bec7f6a1c';
export const POLAR_ARGUMENTS_SHA = 'f337c2e36b60c7cf64f57fb7a36d04cb99313932d4efa79846f3bb43cf87912d';
const MODULE = 'virtual:thalassa-polar-arguments';
const RESOLVED = '\0' + MODULE;
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** @param {string} code @param {string} file */
export function packPolarSource(code, file = 'data/polarDatabase.ts') {
    if (hash(code.replace(/\r\n/g, '\n')) !== POLAR_SOURCE_SHA) throw Error('Unreviewed public polar source');
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations = [];
    const visit = (node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'POLAR_DATABASE') declarations.push(node);
        ts.forEachChild(node, visit);
    };
    visit(source);
    const initializer = declarations[0]?.initializer;
    if (declarations.length !== 1 || !initializer || !ts.isArrayLiteralExpression(initializer))
        throw Error('Unreviewed public polar declaration');
    const rows = initializer.elements.map((node) => {
        if (!ts.isCallExpression(node) || node.expression.getText(source) !== 'e' || node.arguments.length !== 4)
            throw Error('Unreviewed public polar factory call');
        return node.arguments.map((arg) => {
            if (ts.isStringLiteral(arg)) return arg.text;
            if (ts.isNumericLiteral(arg)) return Number(arg.text);
            throw Error('Nonliteral public polar argument');
        });
    });
    if (rows.length !== 321 || hash(JSON.stringify(rows)) !== POLAR_ARGUMENTS_SHA)
        throw Error('Unreviewed public polar arguments');
    const packed = packClassNames(rows.map((row) => JSON.stringify(row)));
    if (packed.code.length + 1800 >= JSON.stringify(rows).length) return null;
    let binding = '__thalassaRestorePolars';
    while (code.includes(binding)) binding += '_';
    const output = new MagicString(code);
    output.overwrite(initializer.getStart(source), initializer.end, `${binding}(e)`);
    output.prepend(`import {restore as ${binding}} from '${MODULE}';\n`);
    return {
        code: output.toString(),
        map: output.generateMap({ source: file, includeContent: true, hires: true }),
        rows,
        packed,
        initializer: code.slice(initializer.getStart(source), initializer.end),
        binding,
    };
}

/** @param {string} root @returns {import('vite').Plugin} */
export function packPolarArguments(root) {
    let enabled = false,
        packed = null;
    const target = path.resolve(root, 'data/polarDatabase.ts');
    return {
        name: 'pack-public-polar-arguments',
        apply: 'build',
        enforce: 'pre',
        configResolved(config) {
            enabled = config.isProduction;
        },
        buildStart() {
            if (enabled) packed = packPolarSource(fs.readFileSync(target, 'utf8'), target)?.packed ?? null;
        },
        resolveId(id) {
            return id === MODULE ? RESOLVED : null;
        },
        load(id) {
            if (id !== RESOLVED || !packed) return null;
            return `import {restorePolarEntries} from ${JSON.stringify(path.resolve(root, 'utils/restorePolarEntries.ts'))};export function restore(factory){return restorePolarEntries(${JSON.stringify(packed.encoded)},${packed.bytes},${packed.count},${packed.checksum},factory);}`;
        },
        transform(code, id) {
            if (!enabled || path.resolve(id.split('?')[0]) !== target) return null;
            const result = packPolarSource(code, target);
            if (!result) return null;
            this.info(`packed ${result.rows.length} exact public polar argument rows`);
            return { code: result.code, map: result.map };
        },
    };
}
