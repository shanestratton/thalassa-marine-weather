import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function edgeSource(name: string): string {
    return readFileSync(resolve(process.cwd(), `supabase/functions/${name}/index.ts`), 'utf8');
}

describe('paid weather upstream boundaries', () => {
    it('never uses unbounded JSON or binary response buffering', () => {
        for (const name of ['proxy-stormglass', 'proxy-tides', 'proxy-rainbow']) {
            const source = edgeSource(name);
            expect(source, name).not.toMatch(/\b(?:res|response|upstream)\.json\s*\(/);
            expect(source, name).not.toMatch(/\b(?:res|response|upstream)\.arrayBuffer\s*\(/);
            expect(source, name).toContain('readResponse');
            expect(source, name).toContain('await res.body?.cancel().catch(() => undefined)');
        }
    });

    it('locks StormGlass paths to their own keys, metrics, dates, sources, and response caps', () => {
        const source = edgeSource('proxy-stormglass');
        expect(source).toContain('const PATH_RULES');
        expect(source).toContain("'weather/point'");
        expect(source).toContain("'tide/extremes/point'");
        expect(source).toContain("allowedKeys: new Set<string>(['lat', 'lng', 'start', 'end'])");
        expect(source).toContain('WEATHER_PARAMETERS');
        expect(source).toContain("'secondarySwellHeight'");
        expect(source).toContain("new Set(['sg', 'ecmwf', 'gfs', 'icon'])");
        expect(source).toContain('end - start > maxWindowMs');
        expect(source).toContain('MAX_UPSTREAM_BYTES = 3_000_000');
        expect(source).toContain('isValidStormGlassResponse(');
        expect(source).not.toContain('String(value)');
    });

    it('accepts only bounded WorldTides station or high/low response schemas', () => {
        const source = edgeSource('proxy-tides');
        expect(source).toContain('MAX_UPSTREAM_BYTES = 512_000');
        expect(source).toContain('MAX_STATIONS = 500');
        expect(source).toContain('value.status !== 200');
        expect(source).toContain('value.stations.every(isValidStation)');
        expect(source).toContain('value.extremes.every(isValidExtreme)');
        expect(source).toContain('const maxExtremes = days * 8 + 16');
        expect(source).toContain("upstreamUrl.searchParams.set('key', key)");
    });

    it('requires Rainbow response schemas and MIME-matched PNG/WebP signatures', () => {
        const source = edgeSource('proxy-rainbow');
        expect(source).toContain('MAX_JSON_BYTES = 512_000');
        expect(source).toContain('MAX_TILE_BYTES = 2_000_000');
        expect(source).toContain('MAX_FORECAST_ITEMS = 300');
        expect(source).toContain("const TILE_COLORS = new Set(['', '6', 'dbz_u8'])");
        expect(source).toContain("parseBoundedInteger(url.searchParams.get('forecast'), 0, 14_400)");
        expect(source).toContain('hasPngSignature(body)');
        expect(source).toContain('hasWebpSignature(body)');
        expect(source).toContain('parseTileContentType(');
        expect(source).toContain('isValidNowcastResponse(');
        expect(source).not.toMatch(/error:\s*`(?:Rainbow|Nowcast)[^`]*\\?\\$\\{/);
    });

    it('keeps provider failures generic and exception values out of logs', () => {
        for (const name of ['proxy-stormglass', 'proxy-tides', 'proxy-rainbow']) {
            const source = edgeSource(name);
            expect(source, name).not.toMatch(/console\.error\([^)]*,\s*(?:e|err|error)\b/);
            expect(source, name).not.toMatch(/console\.error\([^)]*\b(?:url|body|key)\b/i);
            expect(source, name).not.toMatch(/JSON\.stringify\(\{\s*error:\s*`[^`]*\\?\\$\\{/);
        }
    });
});
