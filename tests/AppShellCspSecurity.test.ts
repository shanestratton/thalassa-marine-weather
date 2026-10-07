import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const nativeApiBase = readFileSync(resolve(process.cwd(), 'services/native/apiBase.ts'), 'utf8');
const vercel = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8')) as {
    headers: Array<{ headers: Array<{ key: string; value: string }> }>;
};
const deployedCsp = vercel.headers
    .flatMap((entry) => entry.headers)
    .find((header) => header.key.toLowerCase() === 'content-security-policy')?.value;

describe('application shell CSP', () => {
    it('does not permit runtime code generation or a redundant CDN import map', () => {
        expect(indexHtml).not.toContain("'unsafe-eval'");
        expect(indexHtml).not.toContain('type="importmap"');
        expect(indexHtml).not.toContain('https://esm.sh');
        expect(deployedCsp).not.toContain("'unsafe-eval'");
        expect(deployedCsp).not.toContain('https://esm.sh');
    });

    it('does not reconnect the deployed client to server-proxied paid providers', () => {
        expect(deployedCsp).not.toContain('customer-api.open-meteo.com');
        expect(indexHtml).not.toContain('customer-api.open-meteo.com');
        expect(deployedCsp).not.toContain('api.stormglass.io');
        expect(indexHtml).not.toContain('api.stormglass.io');
        expect(deployedCsp).not.toContain('generativelanguage.googleapis.com');
        expect(indexHtml).not.toContain('generativelanguage.googleapis.com');
        expect(deployedCsp).not.toContain('api.spoonacular.com');
        expect(indexHtml).not.toContain('api.spoonacular.com');
        expect(deployedCsp).not.toContain('tile.openweathermap.org');
        expect(indexHtml).not.toContain('tile.openweathermap.org');
        expect(deployedCsp).toContain("object-src 'none'");
    });

    it('allows the native shell to reach the canonical same-app API host explicitly', () => {
        expect(indexHtml).toContain("connect-src 'self' data: http: https://thalassawx.vercel.app");
        expect(nativeApiBase).toContain("const DEFAULT_NATIVE_BASE = 'https://thalassawx.vercel.app/api'");
    });
});

describe('the coastline mirrors are allowed, and only those two', () => {
    // Shane 2026-08-23, seeing red in the console: the shelter lookup calls
    // two public OSM Overpass mirrors, and CSP blocked them on web — while
    // CapacitorHttp bypasses CSP on iOS, so the phone was already making the
    // request. The policy was not protecting anything; it was just
    // inconsistent with the platform that actually goes to sea.
    //
    // Allowed deliberately, on his call, with the trade understood: the query
    // carries the boat's position at ~11 m to a third party. That is why the
    // Russian-operated mirror was REMOVED the same day — the objection was
    // jurisdiction, not Overpass.
    const files = ['index.html', 'vercel.json'];

    it('allows the two mirrors in BOTH policies', () => {
        // Two policies exist and they are not identical: index.html ships in
        // the native bundle, vercel.json serves the web app. A host added to
        // one only is a bug that shows up on exactly one platform.
        for (const f of files) {
            const src = readFileSync(f, 'utf8');
            expect(src).toContain('https://overpass-api.de');
            expect(src).toContain('https://overpass.kumi.systems');
        }
    });

    it('does NOT reinstate the mirror removed for jurisdiction', () => {
        for (const f of files) {
            expect(readFileSync(f, 'utf8')).not.toContain('maps.mail.ru');
        }
        // …and nothing in the app may reach for it either.
        expect(readFileSync('services/SeamarkService.ts', 'utf8')).not.toMatch(/'https:\/\/maps\.mail\.ru/);
        expect(readFileSync('services/weather/shelter/coastlineSource.ts', 'utf8')).not.toMatch(
            /'https:\/\/maps\.mail\.ru/,
        );
    });

    it('keeps the allowance to Overpass — not all of OSM', () => {
        // A wildcard here would quietly admit every OSM-adjacent host anyone
        // ever adds. These are two named endpoints.
        for (const f of files) {
            const src = readFileSync(f, 'utf8');
            expect(src).not.toContain('https://*.openstreetmap.de');
            expect(src).not.toContain('https://*.kumi.systems');
        }
    });
});

describe('offline MBTiles charts can open and draw under both policies (W1-FX)', () => {
    // A chart on the phone runs three loads the CSP decides, measured refused
    // in WebKit and Chromium on 2026-10-08 (browser-tests/mbtiles-csp.spec.ts):
    //  1. sql.js compiles its WebAssembly: script-src needs 'wasm-unsafe-eval'
    //     ("Refused to create a WebAssembly object", every chart open failed);
    //  2. Mapbox fetch()es each tile as the blob: URL useMapInit's
    //     transformRequest hands it: connect-src needs blob: ("Refused to
    //     connect to blob:...");
    //  3. the chart file itself is read same-origin through
    //     Capacitor.convertFileSrc, so connect-src never needs file:.
    const directives = (policy: string): Map<string, string[]> =>
        new Map(
            policy
                .split(';')
                .map((d) => d.trim().split(/\s+/).filter(Boolean))
                .filter((parts) => parts.length > 0)
                .map(([name, ...sources]) => [name, sources]),
        );
    const nativeShell = indexHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? '';
    const policies = [
        ['index.html (native shell)', nativeShell],
        ['vercel.json (web app)', deployedCsp ?? ''],
    ] as const;

    it.each(policies)('%s lets WebAssembly compile, and only WebAssembly', (_name, policy) => {
        const scriptSrc = directives(policy).get('script-src') ?? [];
        expect(scriptSrc).toContain("'wasm-unsafe-eval'");
        // The narrow grant: compiling WebAssembly, never eval() of JavaScript.
        expect(scriptSrc).not.toContain("'unsafe-eval'");
    });

    it.each(policies)('%s lets Mapbox fetch the blob: tiles, and still not file:', (_name, policy) => {
        const connectSrc = directives(policy).get('connect-src') ?? [];
        expect(connectSrc).toContain('blob:');
        expect(connectSrc).not.toContain('file:');
        expect(connectSrc).not.toContain('*');
    });

    it('keeps the beta gate’s pinned connect-src prefix intact', () => {
        expect(indexHtml).toContain("connect-src 'self' data: http: https://thalassawx.vercel.app");
    });

    it('reads the chart file through convertFileSrc, never a raw file:// fetch', () => {
        const service = readFileSync(resolve(process.cwd(), 'services/MBTilesService.ts'), 'utf8');
        expect(service).toContain('Capacitor.convertFileSrc(uri.uri)');
        expect(service).not.toMatch(/fetch\(uri\.uri\)/);
    });
});
