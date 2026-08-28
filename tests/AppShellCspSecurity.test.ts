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
