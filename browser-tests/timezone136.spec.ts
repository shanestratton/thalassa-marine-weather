import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { parseAst } from 'rollup/parseAst';
import { expect, test } from '@playwright/test';
import { packTimezoneSource } from '../scripts/pack-timezone-data.mjs';

test('embedded timezone table decodes offline with exact worldwide and boundary results', async ({ page }) => {
    const root = process.cwd();
    const source = fs.readFileSync(path.join(root, 'node_modules/tz-lookup/tz.js'), 'utf8');
    const packed = packTimezoneSource(source, parseAst);
    const bundle = await build({
        stdin: { contents: packed.code, resolveDir: root, loader: 'js' },
        bundle: true,
        platform: 'browser',
        format: 'iife',
        globalName: '__tzPacked',
        write: false,
        plugins: [
            {
                name: 'reviewed-table-decoder',
                setup(builder) {
                    builder.onResolve({ filter: /^virtual:thalassa-timezone-data$/ }, () => ({
                        path: path.join(root, 'utils/decodeTimezoneData.ts'),
                    }));
                },
            },
        ],
    });
    const requests: string[] = [],
        errors: string[] = [];
    page.on('request', (request) => {
        if (/^https?:/.test(request.url())) requests.push(request.url());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent('<!doctype html><html><body>Offline timezone table proof</body></html>');
    await page.addScriptTag({ content: source + '\nwindow.__tzOriginal=tzlookup;' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(() => {
        const runtime = window as unknown as {
            __tzOriginal: (lat: number, lon: number) => string;
            __tzPacked: { default: (lat: number, lon: number) => string };
        };
        let checked = 0,
            mismatches = 0;
        const check = (lat: number, lon: number) => {
            checked++;
            if (runtime.__tzOriginal(lat, lon) !== runtime.__tzPacked.default(lat, lon)) mismatches++;
        };
        for (let lat = -90; lat <= 90; lat += 3) for (let lon = -180; lon <= 180; lon += 3) check(lat, lon);
        for (let lat = -90; lat <= 90; lat += 7.5)
            for (let lon = -180; lon <= 180; lon += 7.5)
                for (const epsilon of [-1e-9, 0, 1e-9])
                    check(Math.max(-90, Math.min(90, lat + epsilon)), Math.max(-180, Math.min(180, lon + epsilon)));
        return { checked, mismatches };
    });
    expect(result.checked).toBe(11056);
    expect(result.mismatches).toBe(0);
    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
});
