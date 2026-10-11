/**
 * The app's side of the marine publication contract.
 *
 * Until 2026-10 these checks ran in Python inside every publisher run
 * (scripts/publisher-tests/test_source_gates.py). The publishers moved to the
 * public data repository shanestratton/thalassa-ocean-data, which pins its own
 * side; the checks on app files live here, with the files.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARINE_RELEASE_REPOSITORY } from '../services/weather/api/marineManifestContract';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('marine release source gates (app side)', () => {
    it('reads every slot and asset from the public data repository, named once', () => {
        expect(MARINE_RELEASE_REPOSITORY).toBe('shanestratton/thalassa-ocean-data');
        const helper = read('api/_releaseAssetProxy.ts');
        expect(helper).toContain('const OWNER_REPO = MARINE_RELEASE_REPOSITORY;');
        expect(helper).not.toContain('shanestratton/thalassa-marine-weather');
    });

    it('only exposes manifests or immutable generation names through the API', () => {
        const helper = read('api/_releaseAssetProxy.ts');
        for (const needle of [
            'CMEMS_ASSET_PATTERN',
            'MPA_ASSET_PATTERN',
            'MANIFEST_MAX_BYTES = 256 * 1024',
            'maxAssetBytes: 16 * 1024 * 1024',
            'max-age=31536000',
            "'cache-control': isManifest",
            "? 'no-store'",
            'content-digest',
            'x-thalassa-generation',
            'access-control-allow-origin',
            'assetShardTag',
            'new ReadableStream',
            'manifest-v2-a.json',
            'manifest-v2-b.json',
            'THALASSA_CMEMS_V1_BRIDGE_ENABLED',
            '2026-08-20T00:00:00Z',
            'x-thalassa-valid-manifest-slots',
            'Legacy marine publication path is retired',
        ])
            expect(helper, needle).toContain(needle);
        expect(helper).not.toContain("'content-length': String(body.byteLength)");

        const cmemsClient = read('services/weather/api/cmemsGridTrust.ts');
        const mpaClient = read('services/weather/api/mpaDataset.ts');
        expect(cmemsClient).toContain('/${dataset}/manifest-v2.json');
        expect(cmemsClient).not.toContain('/${dataset}/manifest.json');
        expect(mpaClient).toContain('/mpa/manifest-v2.json');
        expect(mpaClient).not.toContain('/mpa/manifest.json');

        for (const directory of ['currents', 'waves', 'sst', 'chl', 'seaice', 'mld', 'mpa']) {
            expect(read(`api/${directory}/[file].ts`)).toBe(
                "import { proxyReleaseAsset } from '../_releaseAssetProxy';\n\n" +
                    "export const config = { runtime: 'edge' };\n\n" +
                    `export default (request: Request): Promise<Response> => proxyReleaseAsset(request, '${directory}');\n`,
            );
        }
    });

    it('keeps the SPA rewrite from capturing dotted release assets', () => {
        const config = JSON.parse(read('vercel.json'));
        expect(config).not.toHaveProperty('routes');
        expect(config).not.toHaveProperty('functions');
        const last = config.rewrites.at(-1);
        expect(last).toEqual({ source: '/((?!api/)(?!.*\\..*).*)', destination: '/index.html' });
        // Python's re.fullmatch: the whole path must match for the SPA to capture it.
        const spa = new RegExp(`^(?:${last.source})$`);
        for (const [dataset, filename] of [
            ['currents', 'manifest.json'],
            ['currents', 'g-20260805T000000Z-0123456789ab-h000.bin'],
            ['mpa', 'g-20260805T000000Z-0123456789ab-mpa.geojson'],
        ])
            expect(spa.test(`/api/${dataset}/${filename}`)).toBe(false);
        // The same pattern still serves the app's own routes.
        expect(spa.test('/map')).toBe(true);
    });
});
