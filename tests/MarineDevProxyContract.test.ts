import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const viteConfig = readFileSync('vite.config.ts', 'utf8');
const proxyStart = viteConfig.indexOf('export const MARINE_PROXY_DATASETS');
const proxyEnd = viteConfig.indexOf('function releasePublicBetaFeatureManifest');
const marineProxyBoundary = viteConfig.slice(proxyStart, proxyEnd);

describe('local marine publisher proxy', () => {
    it('preserves every API path through the canonical shard-aware production boundary', () => {
        expect(marineProxyBoundary).toContain("['currents', 'waves', 'sst', 'chl', 'seaice', 'mld', 'mpa'] as const");
        expect(marineProxyBoundary).toContain('`/api/${dataset}`');
        expect(marineProxyBoundary).toContain("target: 'https://thalassawx.vercel.app'");
        expect(marineProxyBoundary).toContain('changeOrigin: true');
        expect(marineProxyBoundary).not.toContain('rewrite');
        expect(marineProxyBoundary).not.toContain('github.com');
        expect(viteConfig).toContain('...canonicalMarineDevProxy');
    });
});
