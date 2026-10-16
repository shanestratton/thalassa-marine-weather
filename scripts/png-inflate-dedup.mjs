import path from 'node:path';

/** Keep fast-png's decoder/parser unchanged, sharing the PDF's existing
 * fflate codec. Its unused encoder module is a side-effect-free class; if
 * encoding is ever actually imported, Rollup still retains it and real Pako.
 * All other consumers keep their original Pako implementation.
 * @param {string} root
 * @returns {import('vite').Plugin}
 */
export function pngInflateDedup(root) {
    let production = false;
    return {
        name: 'png-inflate-dedup',
        enforce: 'pre',
        configResolved(config) {
            production = config.isProduction;
        },
        async resolveId(source, importer, options) {
            if (!production || !importer) return null;
            const file = importer.replaceAll('\\', '/').split('?')[0];
            if (source === 'pako' && file.endsWith('/node_modules/fast-png/lib-esm/PngDecoder.js'))
                return path.resolve(root, 'utils/pngInflate.ts');
            if (source === './PngEncoder' && file.endsWith('/node_modules/fast-png/lib-esm/index.js')) {
                const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
                if (
                    resolved &&
                    resolved.id.replaceAll('\\', '/').endsWith('/node_modules/fast-png/lib-esm/PngEncoder.js')
                )
                    return { ...resolved, moduleSideEffects: false };
            }
            return null;
        },
    };
}
