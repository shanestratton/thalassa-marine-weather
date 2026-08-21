/**
 * A Pi passthrough URL cannot be fetched by anything that can't present a pin.
 *
 * The Pi serves HTTPS with a self-signed certificate ("Thalassa Pi calypso").
 * Only the pinned native transport can present it. `fetch()` and CapacitorHttp
 * both fail with NSURLErrorDomain -1202 / errSSLXCertChainInvalid on iOS.
 *
 * passthroughUrl() and passthroughTileUrl() hand back a bare string, and ten
 * call sites did the obvious thing with it. The ones with a fallback merely
 * wasted a round trip per call; the ones without silently lost their Pi hop
 * and returned nothing at all — NDBC buoys, QLD wave buoys and BOM AWS
 * observations returned null for any user whose Pi was reachable, because
 * their `url: piUrl || url` form never tried direct.
 *
 * The fix is passthroughJson / passthroughText / passthroughTileResponse,
 * which do the fetch over the pinned transport and return null on any failure.
 * This test keeps the bare-URL builders locked to the handful of callers that
 * legitimately need a string.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Callers allowed to touch the bare URL builders, and why.
 *
 * Adding a file here is a deliberate act. Before you do: can it use
 * passthroughJson/passthroughText/passthroughTileResponse instead? If it
 * fetches the URL itself with fetch() or CapacitorHttp, the answer is yes and
 * this list is not the fix.
 */
const ALLOWED = new Map<string, string>([
    // Owns them.
    ['services/PiCacheService.ts', 'defines the builders and the safe wrappers'],
    // Hands the URL to Mapbox GL, which fetches it natively. Gated behind
    // canDisplayProxiedTiles() precisely because that fetch cannot present the
    // pin — the call is unreachable today and kept for the day it can.
    ['components/map/useMapInit.ts', 'Mapbox transformRequest, gated on canDisplayProxiedTiles'],
    ['components/map/ThalassaMap.tsx', 'Mapbox transformRequest, gated on canDisplayProxiedTiles'],
    ['components/chat/PinMapViewer.tsx', 'Mapbox transformRequest, gated on canDisplayProxiedTiles'],
]);

const SCAN_DIRS = ['services', 'components', 'hooks', 'stores', 'utils'];
const BARE_BUILDERS = /\.(passthroughUrl|passthroughTileUrl)\s*\(/;

/**
 * Strip comments before scanning. Prose ABOUT these builders is fine and
 * common — the migration notes name them repeatedly — and flagging a comment
 * as a call is the fastest way to get a guard like this disabled.
 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*)/.test(line))
        .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
}

describe('Pi passthrough transport guard', () => {
    it('keeps the bare URL builders to their allowlisted callers', () => {
        const offenders: string[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(dir)) {
                if (ALLOWED.has(file)) continue;
                if (BARE_BUILDERS.test(stripComments(readFileSync(file, 'utf8')))) offenders.push(file);
            }
        }

        expect(
            offenders,
            `These call passthroughUrl()/passthroughTileUrl() and then have to fetch the ` +
                `result themselves — which cannot present the Pi's self-signed certificate. ` +
                `Use piCache.passthroughJson() / passthroughText() / passthroughTileResponse() ` +
                `instead; they carry the pinned transport and return null so you fall through ` +
                `to direct. Offenders:\n  ${offenders.join('\n  ')}`,
        ).toEqual([]);
    });

    it('the allowlisted Mapbox callers are the gated ones, not plain fetchers', () => {
        // Their exemption is conditional on being unreachable. If one ever
        // fetches the URL itself, the exemption is wrong.
        for (const file of [
            'components/map/useMapInit.ts',
            'components/map/ThalassaMap.tsx',
            'components/chat/PinMapViewer.tsx',
        ]) {
            const src = readFileSync(file, 'utf8');
            const at = src.indexOf('passthroughTileUrl(');
            expect(at).toBeGreaterThan(-1);
            expect(src.slice(Math.max(0, at - 500), at)).toContain('canDisplayProxiedTiles()');
            // The URL is returned to Mapbox, never fetched here.
            expect(src.slice(at, at + 200)).not.toMatch(/fetch\s*\(|CapacitorHttp/);
        }
    });

    it('exposes the safe wrappers callers are pointed at', () => {
        const svc = readFileSync('services/PiCacheService.ts', 'utf8');
        expect(svc).toContain('async passthroughText(');
        expect(svc).toContain('async passthroughJson<T = unknown>(');
        expect(svc).toContain('async passthroughTileResponse(');
        // They must go through piRequest — that IS the pinned transport.
        const textBody = svc.slice(svc.indexOf('async passthroughText('), svc.indexOf('async passthroughJson<'));
        expect(textBody).toContain('piRequest(');
        expect(textBody).not.toMatch(/\bfetch\s*\(/);
    });
});
