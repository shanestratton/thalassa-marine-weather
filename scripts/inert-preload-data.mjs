/** Exact per-chunk Vite preload arrays as lazy, bounded inert HTML records. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import MagicString from 'magic-string';
import { fileURLToPath } from 'node:url';

const MARKER = '__VITE_PRELOAD__';
const SELF = fileURLToPath(import.meta.url);
const VERSION = createHash('sha256').update(fs.readFileSync(SELF, 'utf8').replaceAll('\r\n', '\n')).digest('hex');
const clean = (value) => value.replaceAll('\\', '/').split('?')[0];
const forbidden = (name) => /(?:^|\/)(?:router-engine|engine-leaf|routeWorker|sw)(?:[-.]|$)/.test(name);
const walk = (root, visit) => {
    const queue = [[root, null]];
    while (queue.length) {
        const [node, parent] = queue.pop();
        visit(node, parent);
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
                for (const child of value) if (child && typeof child.type === 'string') queue.push([child, node]);
            } else if (value && typeof value.type === 'string') queue.push([value, node]);
        }
    }
};
export function preloadChecksum(text) {
    let a = 1,
        b = 0;
    for (let i = 0; i < text.length; i++) {
        a = (a + text.charCodeAt(i)) % 65521;
        b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
}
export function preloadRecord(fileName, paths) {
    if (
        !Array.isArray(paths) ||
        !paths.length ||
        paths.length > 1024 ||
        paths.some(
            (value) =>
                typeof value !== 'string' ||
                value.length > 160 ||
                !/^assets\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(value) ||
                value.includes('..'),
        )
    )
        throw Error('Invalid local preload paths');
    const text = JSON.stringify(paths);
    if (text.length > 32768) throw Error('Local preload record exceeds reviewed bound');
    const digest = createHash('sha256')
        .update(JSON.stringify([fileName, paths]))
        .digest('hex');
    return { id: `thalassa-preload-${digest}`, text, count: paths.length, checksum: preloadChecksum(text) };
}

export function rewritePreloadHelper(code, fileName, parse, sourcemap) {
    if (!code.startsWith('const __vite__mapDeps=')) return null;
    if (forbidden(fileName)) throw Error('A worker/router cannot use document preload data');
    const end = code.indexOf('\n');
    if (end < 0) throw Error('Unfamiliar Vite preload prefix');
    const helper = code.slice(0, end),
        start = helper.indexOf('['),
        stop = helper.indexOf(']', start);
    let paths;
    try {
        paths = JSON.parse(helper.slice(start, stop + 1));
    } catch {
        throw Error('Unfamiliar Vite preload array');
    }
    if (
        helper !==
        `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=${JSON.stringify(paths)})))=>i.map(i=>d[i]);`
    )
        throw Error('Unfamiliar Vite preload helper grammar');
    if (sourcemap && sourcemap.mappings.split(';')[0] !== '') throw Error('Vite preload prefix unexpectedly mapped');
    const record = preloadRecord(fileName, paths),
        aliases = new Set(),
        imports = new Set();
    const ast = parse(code);
    for (const statement of ast.body)
        if (
            statement.type === 'ImportDeclaration' &&
            /^\.\/preload-data-[A-Za-z0-9_-]+\.js$/.test(statement.source.value)
        )
            for (const spec of statement.specifiers) if (spec.type === 'ImportSpecifier') imports.add(spec.local.name);
    let calls = 0,
        identifiers = 0;
    walk(ast, (node, parent) => {
        if (node.type === 'Identifier' && node.name === '__vite__mapDeps') identifiers++;
        if (
            node.type !== 'CallExpression' ||
            node.callee.type !== 'Identifier' ||
            node.callee.name !== '__vite__mapDeps'
        )
            return;
        if (
            node.arguments.length !== 1 ||
            node.arguments[0].type !== 'ArrayExpression' ||
            node.arguments[0].elements.some(
                (value) =>
                    value?.type !== 'Literal' ||
                    !Number.isInteger(value.value) ||
                    value.value < 0 ||
                    value.value >= paths.length,
            )
        )
            throw Error('Nonstatic Vite preload indices');
        if (
            parent?.type !== 'CallExpression' ||
            parent.arguments.length !== 1 ||
            parent.arguments[0] !== node ||
            parent.callee.type !== 'Identifier' ||
            !imports.has(parent.callee.name)
        )
            throw Error('Preload reader must be a normal hashed import');
        aliases.add(parent.callee.name);
        calls++;
    });
    if (!calls || identifiers !== calls + 2 || aliases.size !== 1)
        throw Error('Unfamiliar or escaped Vite preload helper');
    const alias = [...aliases][0];
    // The minifier may assign the imported reader one of Vite's helper
    // parameter names. Keep that import free inside default initializers;
    // otherwise i calls the indices array, m calls the helper itself, or d
    // reads its own uninitialised parameter. Parsed names also cover escapes.
    const [indices, cache, dependencies] = ['i', 'm', 'd'].map((name) => (name === alias ? `${name}_` : name));
    const next = `const __vite__mapDeps=(${indices},${cache}=__vite__mapDeps,${dependencies}=(${cache}.f||(${cache}.f=${alias}(${JSON.stringify(record.id)},${record.text.length},${record.count},${record.checksum}))))=>${indices}.map(${indices}=>${dependencies}[${indices}]);`;
    return { code: next + code.slice(end), record, saved: Buffer.byteLength(helper) - Buffer.byteLength(next), calls };
}

/** @param {string} root @returns {import('vite').Plugin} */
export function inertPreloadData(root) {
    const runtime = clean(path.resolve(root, 'utils/readPreloadData.ts'));
    let enabled = false;
    const wrapped = new Set(),
        documents = new Map();
    const reachable = (fileName, bundle) => {
        const seen = new Set(),
            queue = [fileName];
        while (queue.length) {
            const name = queue.pop();
            if (seen.has(name)) continue;
            seen.add(name);
            const output = bundle[name];
            if (output?.type === 'chunk') queue.push(...output.imports, ...output.dynamicImports);
        }
        return seen;
    };
    return {
        name: 'inert-local-preload-data',
        apply: 'build',
        enforce: 'post',
        configResolved(config) {
            enabled = config.isProduction && !config.isWorker;
        },
        buildStart() {
            wrapped.clear();
            documents.clear();
        },
        transform: {
            order: 'post',
            handler(code, id) {
                if (!enabled || !code.includes(MARKER) || clean(id) === runtime) return null;
                const edits = new MagicString(code),
                    positions = [];
                walk(this.parse(code), (node) => {
                    if (node.type === 'Identifier' && node.name === MARKER) positions.push(node);
                });
                if (!positions.length) return null;
                let alias = '__thalassaPreloadReader';
                while (code.includes(alias)) alias += '_';
                for (const node of positions) edits.overwrite(node.start, node.end, `${alias}(${MARKER})`);
                edits.prepend(`import {readPreloadData as ${alias}} from ${JSON.stringify(runtime)};\n`);
                wrapped.add(clean(id));
                return {
                    code: edits.toString(),
                    map: edits.generateMap({ source: id, includeContent: true, hires: true }),
                };
            },
        },
        augmentChunkHash(chunk) {
            return Object.keys(chunk.modules).some((id) => wrapped.has(clean(id))) ? VERSION : undefined;
        },
        transformIndexHtml: {
            order: 'post',
            handler(html, context) {
                if (enabled && context.bundle && context.chunk)
                    documents.set(path.relative(root, context.filename).replaceAll('\\', '/'), context.chunk.fileName);
                return html;
            },
        },
        generateBundle: {
            order: 'post',
            handler(_options, bundle) {
                if (!enabled) return;
                const records = new Map();
                let bytes = 0,
                    saved = 0;
                for (const output of Object.values(bundle)) {
                    if (output.type !== 'chunk') continue;
                    if (forbidden(output.fileName) && Object.keys(output.modules).some((id) => clean(id) === runtime))
                        this.error('A worker/router cannot import the preload DOM reader');
                    const result = rewritePreloadHelper(
                        output.code,
                        output.fileName,
                        (code) => this.parse(code),
                        output.map,
                    );
                    // Small arrays stay verbatim. Their ordinary identity calls
                    // retain the reader dependency without creating any record.
                    if (!result || result.saved <= 0) continue;
                    records.set(output.fileName, result.record);
                    bytes += result.record.text.length;
                    saved += result.saved;
                    if (records.size > 256 || bytes > 524288)
                        this.error('Preload data exceeds reviewed aggregate bounds');
                    output.code = result.code;
                }
                for (const output of Object.values(bundle)) {
                    if (output.type !== 'chunk' || !output.isEntry) continue;
                    const needsData = [...reachable(output.fileName, bundle)].some(
                        (name) =>
                            records.has(name) ||
                            Object.keys(bundle[name]?.type === 'chunk' ? bundle[name].modules : {}).some(
                                (id) => clean(id) === runtime,
                            ),
                    );
                    if (needsData && ![...documents.values()].includes(output.fileName))
                        this.error('Preload data requires a document; no worker or JS entry fallback');
                }
                for (const [htmlName, entry] of documents) {
                    const html = bundle[htmlName];
                    const wanted = [...reachable(entry, bundle)]
                        .filter((name) => records.has(name))
                        .sort()
                        .map((name) => records.get(name));
                    if (!wanted.length) continue;
                    if (
                        html?.type !== 'asset' ||
                        typeof html.source !== 'string' ||
                        !/<meta\s+charset\s*=/i.test(html.source) ||
                        !/<body(?:\s[^>]*)?>/i.test(html.source) ||
                        html.source.includes('thalassa-preload-')
                    )
                        this.error('Unsupported preload HTML document');
                    const scripts = [...html.source.matchAll(/<script\b([^>]*)>/gi)].filter(([, attrs]) =>
                        /\btype\s*=\s*["']module["']/i.test(attrs),
                    );
                    if (!scripts.length || scripts.some(([, attrs]) => /(?:^|\s)async(?:\s|=|$)/i.test(attrs)))
                        this.error('Preload data requires deferred document modules');
                    const data = wanted
                        .map((record) => `<script type="application/json" id="${record.id}">${record.text}</script>`)
                        .join('');
                    html.source = html.source.replace(/<body(?:\s[^>]*)?>/i, (match) => match + data);
                }
                if (records.size)
                    this.info(
                        `Local preload data: ${records.size} records, ${bytes} inert bytes, ${saved} fewer JS bytes before reader/import overhead.`,
                    );
            },
        },
    };
}
