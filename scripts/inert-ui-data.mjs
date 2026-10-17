/** Actual packed tuples as inert HTML data. No bootstrap or worker graph change. */
import path from 'node:path';
import { createHash } from 'node:crypto';

const OWNERS = new Map([
    ['\0virtual:thalassa-class-names', 1],
    ['\0virtual:thalassa-ui-strings', 4],
    ['\0virtual:thalassa-svg-paths', 1],
]);
const clean = (id) => id.replaceAll('\\', '/').split('?')[0];
const reader = (root) => clean(path.resolve(root, 'utils/readPackedUiData.ts'));

/** @param {string} root
 * @returns {{ moduleSource(owner: string, packed: { encoded: string, bytes: number, count: number, checksum: number }[]): string, plugin: import('vite').Plugin }} */
export function inertUiData(root) {
    const tables = new Map(),
        documents = new Map();
    const runtime = reader(root);
    let enabled = false;
    const reachable = (start, bundle) => {
        const seen = new Set(),
            queue = start ? [start.fileName] : [];
        while (queue.length) {
            const name = queue.pop();
            if (seen.has(name)) continue;
            seen.add(name);
            const chunk = bundle[name];
            if (chunk?.type === 'chunk') queue.push(...chunk.imports, ...chunk.dynamicImports);
        }
        return [...seen].flatMap((name) => {
            const output = bundle[name];
            return output?.type === 'chunk' ? Object.keys(output.modules) : [];
        });
    };
    const required = (modules) =>
        [...tables]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .filter(([owner]) => modules.includes(owner))
            .flatMap(([, records]) => records);
    return {
        /** Called only by the three reviewed virtual table modules. */
        moduleSource(owner, packed) {
            if (!enabled || !OWNERS.has(owner) || !packed.length || packed.length > OWNERS.get(owner))
                throw Error('Invalid inert UI data owner');
            const records = packed.map((value, index) => {
                const tuple = [value.encoded, value.bytes, value.count, value.checksum];
                if (
                    typeof tuple[0] !== 'string' ||
                    tuple[0].length > 64000 ||
                    !/^[A-Za-z0-9+/]+={0,2}$/.test(tuple[0]) ||
                    !Number.isSafeInteger(tuple[1]) ||
                    tuple[1] < 1 ||
                    tuple[1] > 128000 ||
                    !Number.isSafeInteger(tuple[2]) ||
                    tuple[2] < 0 ||
                    tuple[2] > 4096 ||
                    !Number.isSafeInteger(tuple[3]) ||
                    tuple[3] < 0 ||
                    tuple[3] > 0xffffffff
                )
                    throw Error('Invalid inert UI tuple');
                const text = JSON.stringify(tuple);
                const digest = createHash('sha256')
                    .update(JSON.stringify([owner, index, tuple]))
                    .digest('hex');
                return { id: `thalassa-ui-${digest}`, text, tuple };
            });
            if (tables.has(owner) && JSON.stringify(tables.get(owner)) !== JSON.stringify(records))
                throw Error('Inert UI owner changed during build');
            tables.set(owner, records);
            const calls = records.map(
                ({ id, tuple }) =>
                    `readPackedUiData(${JSON.stringify(id)},${tuple[0].length},${tuple[1]},${tuple[2]},${tuple[3]})`,
            );
            const expression = calls.length === 1 ? calls[0] : `Object.freeze([${calls.map((call) => '...' + call)}])`;
            return `import {readPackedUiData} from ${JSON.stringify(runtime)};export const values=${expression};`;
        },
        plugin: {
            name: 'inert-packed-ui-data',
            apply: 'build',
            enforce: 'post',
            configResolved(config) {
                enabled = config.isProduction;
            },
            buildStart() {
                tables.clear();
                documents.clear();
            },
            transformIndexHtml: {
                order: 'post',
                handler(html, ctx) {
                    if (!enabled || !ctx.bundle) return html;
                    const records = required(reachable(ctx.chunk, ctx.bundle));
                    documents.set(
                        clean(ctx.filename),
                        records.map((record) => record.id),
                    );
                    if (!records.length) return html;
                    if (!/<meta\s+charset\s*=/i.test(html) || !/<body(?:\s[^>]*)?>/i.test(html))
                        throw Error('Inert UI data requires a charset and body');
                    const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
                    const modules = scripts.filter(([, attrs]) => /\btype\s*=\s*["']module["']/i.test(attrs));
                    if (!modules.length || modules.some(([, attrs]) => /(?:^|\s)async(?:\s|=|$)/i.test(attrs)))
                        throw Error('Inert UI data requires deferred document modules');
                    if (html.includes('id="thalassa-ui-') || html.includes("id='thalassa-ui-"))
                        throw Error('Unexpected existing inert UI data');
                    return {
                        html,
                        tags: records.map(({ id, text }) => ({
                            tag: 'script',
                            attrs: { type: 'application/json', id },
                            children: text,
                            injectTo: 'body-prepend',
                        })),
                    };
                },
            },
            generateBundle: {
                order: 'post',
                handler(_options, bundle) {
                    if (!enabled) return;
                    for (const chunk of Object.values(bundle)) {
                        if (chunk.type !== 'chunk' || !chunk.isEntry) continue;
                        const modules = reachable(chunk, bundle),
                            records = required(modules);
                        if (!records.length && !modules.map(clean).includes(runtime)) continue;
                        const document = chunk.facadeModuleId && documents.get(clean(chunk.facadeModuleId));
                        if (!document || records.some((record) => !document.includes(record.id)))
                            this.error(
                                'Packed UI data requires a supported HTML document entry; no worker/JS fallback.',
                            );
                    }
                },
            },
        },
    };
}

/** Independent worker builds must never acquire a document-only reader.
 * @param {string} root
 * @returns {import('vite').Plugin} */
export function inertUiDataWorkerFence(root) {
    const runtime = reader(root);
    return {
        name: 'inert-ui-data-worker-fence',
        async resolveId(source, importer, options) {
            if (OWNERS.has('\0' + source)) this.error('A worker cannot import inert UI data.');
            if (!source.includes('readPackedUiData')) return null;
            if (clean(source) === runtime) this.error('A worker cannot import the inert UI DOM reader.');
            const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
            if (resolved && clean(resolved.id) === runtime)
                this.error('A worker cannot import the inert UI DOM reader.');
            return null;
        },
        load(id) {
            if (clean(id) === runtime) this.error('A worker cannot import the inert UI DOM reader.');
            return null;
        },
    };
}
