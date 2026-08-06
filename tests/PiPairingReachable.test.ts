import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
const codeOf = (relative: string): string =>
    read(relative)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

/**
 * An UNPAIRED app must still be able to reach the pairing offer.
 *
 * The pinned transport opens exactly one path without a pin,
 * /api/pair/info. checkHealth used to probe /api/admin/status FIRST and only
 * reach the identity gate after that succeeded — which, unpaired, it never
 * could. So:
 *
 *   pairing needs the offer
 *     -> the offer needs passesIdentityGate()
 *       -> which sat behind a request that pairing gates
 *
 * A closed loop. No pairing banner ever appeared, the identity gate kept the
 * Pi unreachable, and the ENC sync silently did nothing — with the Pi sitting
 * there serving 345 cells the whole time.
 *
 * This is a structural property, not a behaviour a unit test would catch: both
 * halves work perfectly in isolation and only deadlock in composition.
 */
describe('unpaired apps can still reach the pairing offer', () => {
    const service = codeOf('services/PiCacheService.ts');
    const checkHealth = (() => {
        const start = service.indexOf('private async checkHealth');
        const next = service.indexOf('private async ', start + 1);
        return next > 0 ? service.slice(start, next) : service.slice(start);
    })();

    it('runs the identity gate BEFORE any pinned request when unpaired', () => {
        const unpairedBranch = checkHealth.indexOf('if (!getPairing())');
        const pinnedProbe = checkHealth.indexOf('pinnedPiRequest');
        expect(unpairedBranch).toBeGreaterThan(-1);
        expect(pinnedProbe).toBeGreaterThan(-1);
        // Order is the whole point: the gate must be reachable without a pin.
        expect(unpairedBranch).toBeLessThan(pinnedProbe);
        expect(checkHealth.slice(unpairedBranch, pinnedProbe)).toContain('passesIdentityGate');
    });

    it('keeps /api/pair/info as the one path the transport opens unpinned', () => {
        // If this widens, the deadlock reasoning above changes and this test
        // should be revisited rather than deleted.
        const plugin = read('ios/App/App/PiTlsPlugin.swift');
        expect(plugin).toContain('private static let unpinnedPath = "/api/pair/info"');
    });

    it('still refuses to auto-connect to a pairable-but-unpaired Pi', () => {
        // Breaking the deadlock must not become "trust anything that answers".
        // The gate returns false for a pairable Pi until the skipper accepts.
        const gate = service.slice(service.indexOf('private async passesIdentityGate'));
        const body = gate.slice(0, gate.indexOf('onPairingEvent'));
        expect(body).toContain('emitPairing');
        expect(body).toMatch(/return false;/);
    });

    it('retains the offer so a later-mounting surface can still show it', () => {
        expect(service).toContain('getPairableCandidate()');
        expect(codeOf('components/PiPairingBanner.tsx')).toContain('piCache.getPairableCandidate()');
    });
});
