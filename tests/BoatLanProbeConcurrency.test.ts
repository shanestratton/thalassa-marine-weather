import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

/**
 * These files explain at length what they deliberately do NOT do ("not
 * Promise.any", "no serial loop"). Asserting absence against raw text matches
 * that prose and fails for the wrong reason, so strip comments first and
 * assert against code.
 */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Boat-LAN probing must stay CONCURRENT.
 *
 * These sweeps were serial while Pi integration was development-only, so their
 * cost was never felt. Shipping the Pi made them run on every device, and the
 * failure path — a phone that simply is not on the boat's network — is the
 * common one:
 *
 *   PiCacheService.discover   7 hosts x 2.5 s deadline   = ~18 s   (measured)
 *   AvNavService probe        2 hosts x 7 ports x 4 endpoints x 5 s = ~280 s worst case
 *
 * That was the "app is slow and unresponsive" regression. Racing them bounds
 * each sweep by its slowest single probe instead of the sum. The tests below
 * pin the concurrency and the backoff, because a well-meaning refactor back to
 * a `for` loop would reintroduce a multi-second stall that no unit test would
 * otherwise catch.
 */
describe('boat-LAN probing stays concurrent', () => {
    const piCache = read('services/PiCacheService.ts');
    const avNav = read('services/AvNavService.ts');

    it('races Pi discovery candidates rather than awaiting them in turn', () => {
        expect(piCache).toContain('await Promise.any(candidates.map(probeHost))');
        // The old shape: `for (const host of candidates) { await ... }`.
        expect(piCache).not.toMatch(/for \(const host of candidates\)/);
    });

    it('backs off Pi health checks when nothing is found', () => {
        // Without this, a phone ashore pays a full sweep every 30 s forever.
        expect(piCache).toContain('this.failedSweeps += 1');
        expect(piCache).toContain('this.failedSweeps = 0');
        expect(piCache).toMatch(/Math\.min\(30_000 \* 2 \*\* Math\.min\(this\.failedSweeps, 4\), 300_000\)/);
        // A fixed interval cannot back off — the period must be recomputed per
        // tick, which is what the self-rearming timeout provides.
        expect(piCache).not.toContain('setInterval(() => this.checkHealth()');
    });

    it('races AvNav endpoints and ports, and keeps probe timeouts LAN-sized', () => {
        expect(avNav).toContain('await Promise.any(endpoints.map(probe))');
        expect(avNav).not.toMatch(/for \(const port of portsToProbe\)/);

        // Scoped to the REACHABILITY probe only. Other call sites in this file
        // legitimately keep 5 s — verifying a chart tile or health-checking an
        // already-connected server is real work on a live connection, not a
        // guess at whether anything is there. Asserting across the whole file
        // would ban those too.
        const probeBody = avNav.slice(
            avNav.indexOf('private async probeAvNavWithImage'),
            avNav.indexOf('private async tryFetchChartsFromBase'),
        );
        expect(probeBody).toContain('connectTimeout: 2000, readTimeout: 2000');
        expect(probeBody).not.toMatch(/connectTimeout: 5000/);
    });

    it('probes Signal K versions concurrently WITHOUT losing the v2 preference', () => {
        const body = avNav.slice(
            avNav.indexOf('private async detectApiVersion'),
            avNav.indexOf('private async detectAvNav'),
        );
        expect(body).toContain('await Promise.allSettled([');
        // Precedence is applied to the results, not to arrival order: racing
        // would pick v1 on a server offering both, purely because it replied
        // first — which is why this one is deliberately not raced.
        expect(stripComments(body)).not.toContain('Promise.any');
        expect(body.indexOf("if (ok(v2)) return 'v2'")).toBeLessThan(body.indexOf("if (ok(v1)) return 'v1'"));
        expect(body).not.toMatch(/for \(const \{ path, ver \} of versions\)/);
    });

    it('keeps the supersede guard so a stale sweep cannot clobber a newer one', () => {
        // Racing changed the loop shape; the generation check must survive it.
        expect(avNav).toContain('if (gen !== this._connGen)');
    });
});
