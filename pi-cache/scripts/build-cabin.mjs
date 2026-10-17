import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCabinAssets } from './cabin-package.mjs';

/** Separate LAN display artifact. It is never imported by the phone entry or copied into its dist. */
export async function buildCabin({ repository, output }) {
    if (!path.isAbsolute(repository) || !path.isAbsolute(output) || fs.existsSync(output))
        throw Error('Use an absolute repository and fresh cabin output');
    for (const phoneDirectory of ['dist', 'public']) {
        const relative = path.relative(path.join(repository, phoneDirectory), output);
        if (
            relative === '' ||
            (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
        )
            throw Error('Cabin display cannot write into the phone artifact');
    }
    const { build } = await import('vite');
    await build({
        root: path.join(repository, 'pi-cache/cabin'),
        configFile: false,
        envDir: false,
        publicDir: false,
        base: '/',
        logLevel: 'warn',
        build: {
            outDir: output,
            emptyOutDir: false,
            copyPublicDir: false,
            target: 'es2022',
            minify: 'esbuild',
            sourcemap: false,
            rollupOptions: { output: { inlineDynamicImports: true } },
        },
    });
    const assets = readCabinAssets(output);
    return { schema: 1, assets: assets.sort((a, b) => a.file.localeCompare(b.file)), phoneBundle: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [repository, output, ...extra] = process.argv.slice(2);
    if (extra.length) throw Error('Unexpected arguments');
    process.stdout.write(JSON.stringify(await buildCabin({ repository, output })) + '\n');
}
