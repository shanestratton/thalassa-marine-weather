/**
 * A reachable Pi and a USABLE Pi are different facts, and conflating them
 * blanked the rain radar (Shane, 2026-08-22).
 *
 * The Pi serves its cache over HTTPS with a self-signed certificate
 * (`s: Thalassa Pi calypso i: Thalassa Pi calypso`). Only the pinned native
 * transport can present that pin. Map engines — Mapbox GL and Leaflet — fetch
 * tiles THEMSELVES, natively, and have no way to use it, so every proxied tile
 * dies with NSURLErrorDomain -1202 / errSSLXCertChainInvalid.
 *
 * PI_TILE_PROXY_USABLE was set false for exactly this reason, and
 * leafletTileTemplate was gated on it. The two Mapbox transformRequest call
 * sites were missed and kept gating on isAvailable(), so whenever the boat Pi
 * answered a health check, Mapbox routed rain radar, OpenSeaMap seamarks, Esri
 * imagery and the GIBS cloud layer into a lane that could only fail — while
 * every log line said the Pi was healthy.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { piCache } from '../services/PiCacheService';

const read = (p: string) => readFileSync(p, 'utf8');

describe('Pi tile proxy display gate', () => {
    it('never claims proxied tiles are displayable while the proxy is disabled', () => {
        // PI_TILE_PROXY_USABLE is false, so this is false regardless of
        // reachability. If someone flips the flag, they must first make tiles
        // travel over a transport that can present the pin.
        expect(piCache.canDisplayProxiedTiles()).toBe(false);
    });

    it('hands back the untouched template rather than a Pi URL', () => {
        const original = 'https://tilecache.rainviewer.com/v2/radar/abc/512/{z}/{x}/{y}/4/1_1.png';
        // Not merely "not a Pi URL" — byte-identical. A rewritten template that
        // happens to avoid the Pi would still be a silent behaviour change.
        expect(piCache.leafletTileTemplate(original)).toBe(original);
    });

    it('routes Mapbox tiles on displayability, not reachability', () => {
        // The defect was precisely a correct-looking isAvailable() check at a
        // call site that needed the stronger question, so the call site is the
        // thing worth pinning.
        // ThalassaMap was missed on the first pass because the grep that
        // found the call sites was truncated. Every Mapbox transformRequest
        // that talks to the Pi belongs in this list.
        for (const file of [
            'components/map/useMapInit.ts',
            'components/chat/PinMapViewer.tsx',
            'components/map/ThalassaMap.tsx',
        ]) {
            const src = read(file);
            // Anchor on the Pi passthrough itself — useMapInit has three
            // separate `resourceType === 'Tile'` branches (MBTiles, local
            // tiles, then this one) and only this one talks to the Pi.
            const call = src.indexOf('piCache.passthroughTileUrl(url)');
            expect(call).toBeGreaterThan(-1);
            const branch = src.slice(Math.max(0, call - 500), call);
            expect(branch).toContain('canDisplayProxiedTiles()');
            expect(branch).not.toContain('piCache.isAvailable()');
        }
    });

    it('keeps the fetch-path callers alone — they control their own transport', () => {
        // passthroughTileUrl itself must NOT be gated. MapOfflineService
        // computes `usePi` separately and uses it to decide whether to persist
        // locally; making the URL null there would fetch direct and then skip
        // the persist branch, reporting tiles cached that were never stored.
        const svc = read('services/PiCacheService.ts');
        const body = svc.slice(
            svc.indexOf('passthroughTileUrl(originalUrl'),
            svc.indexOf('passthroughTileUrl(originalUrl') + 400,
        );
        expect(body).toContain('if (!this.isAvailable()) return null;');
        expect(body).not.toContain('canDisplayProxiedTiles');
    });
});
