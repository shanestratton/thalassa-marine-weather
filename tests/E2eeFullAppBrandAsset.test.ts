// @vitest-environment node
/** Pinned bytes/emission fixtures only; no browser, publicDir copy or native work. */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    createFullAppBrandAssetPlugin,
    inspectFullAppBrandBytes,
    readFullAppBrandAsset,
    FULL_APP_BRAND_ASSET_FILE,
    FULL_APP_BRAND_ASSET_SHA256,
} from '../experiments/scuttlebutt-e2ee/full-app-pilot/brandAsset.mjs';
describe('one pinned full App brand asset', () => {
    it('reads exact tracked canonical PNG identity without changing the original App source', () => {
        const asset = readFullAppBrandAsset();
        expect(asset).toMatchObject({
            sha256: FULL_APP_BRAND_ASSET_SHA256,
            byteLength: 31539,
            width: 256,
            height: 256,
        });
        const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
        expect(app).toContain('src="/thalassa-icon-128.png"');
    });
    it('refuses malformed, truncated and modified bytes with fixed diagnostics', () => {
        const bytes = readFullAppBrandAsset().bytes;
        const changed = Buffer.from(bytes);
        changed[changed.length - 1] ^= 1;
        for (const input of [null, new Uint8Array(bytes), bytes.subarray(1), changed])
            expect(() => inspectFullAppBrandBytes(input)).toThrow('Pinned full App brand asset refused');
    });
    it('emits exactly the one named file and does not install a worker or public-directory copier', () => {
        const emitFile = vi.fn();
        const plugin = createFullAppBrandAssetPlugin();
        plugin.generateBundle.call({ emitFile });
        expect(emitFile).toHaveBeenCalledTimes(1);
        expect(emitFile.mock.calls[0][0]).toMatchObject({ type: 'asset', fileName: FULL_APP_BRAND_ASSET_FILE });
        expect(inspectFullAppBrandBytes(emitFile.mock.calls[0][0].source).sha256).toBe(FULL_APP_BRAND_ASSET_SHA256);
        const config = readFileSync(
            new URL('../experiments/scuttlebutt-e2ee/full-app-pilot/vite.config.mjs', import.meta.url),
            'utf8',
        );
        expect(config).toContain('publicDir: false');
        expect(config).toMatch(
            /worker:\s*\{\s*format:\s*'es',\s*plugins:\s*\(\)\s*=>\s*\[createFullAppGraphIsolation\(\)\]/,
        );
    });
});
