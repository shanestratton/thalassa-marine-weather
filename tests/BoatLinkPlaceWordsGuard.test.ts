/**
 * One owner for "Aboard" and "Away".
 *
 * Shane 2026-10-07, at home with the boat 900 km away and reading her over a
 * Tailscale subnet route: the gateway page said "Aboard", the Instrument Panel
 * "Live · Pi — on the boat network", the Vessel row "Aboard", and Remote
 * Access told him to turn Tailscale off "while you're aboard". Each screen
 * had turned the lane that answered (`remote.via === 'lan'`, the Pi cache's
 * host ladder) into a place. Where the phone is is decided once, by position,
 * in services/boatLink; this sweep fails if a screen starts deciding it again.
 *
 * It walks the source rather than a list of the files that were fixed — a
 * guard against "someone added another one" cannot be a list of the ones
 * someone remembered ([[thalassa-pi-pinned-transport]]).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['components', 'services', 'utils', 'hooks', 'stores'];
/** The model that owns the words, and two places that mean something else by "aboard". */
const OWNER = 'services/boatLink/';
const OTHER_MEANINGS = new Set([
    // People aboard on the float plan.
    'services/floatPlan.ts',
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) sourceFiles(p, out);
        else if (/\.(ts|tsx)$/.test(p) && !/\.test\.|\.spec\./.test(p)) out.push(p);
    }
    return out;
}

/** Code without its comments: the explanations quote the old words on purpose. */
function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const files = ROOTS.flatMap((root) => sourceFiles(root)).map((path) => ({
    path,
    text: code(readFileSync(path, 'utf8')),
}));

describe('only services/boatLink says where the phone is', () => {
    it('finds the source it is guarding', () => {
        expect(files.length).toBeGreaterThan(500);
        expect(files.some((f) => f.path === 'components/vessel/NmeaPage.tsx')).toBe(true);
    });

    it('no screen writes "Aboard" or "Away" as a status word of its own', () => {
        const placeWord = /['"`](?:Aboard|Away)(?:['"`]| ·)/;
        const offenders = files
            .filter((f) => !f.path.startsWith(OWNER) && !OTHER_MEANINGS.has(f.path))
            .filter((f) => placeWord.test(f.text))
            .map((f) => f.path);
        expect(offenders).toEqual([]);
    });

    it('no screen calls a direct Pi answer "the boat network" or "Live · Pi"', () => {
        const offenders = files
            .filter((f) => /Live · Pi|through the Pi on the boat network|Aboard · via the Pi/.test(f.text))
            .map((f) => f.path);
        expect(offenders).toEqual([]);
    });

    it('no lane is turned into a place: a via === "lan" test never sits beside a place word', () => {
        const offenders: string[] = [];
        for (const f of files) {
            if (f.path.startsWith(OWNER)) continue;
            const lines = f.text.split('\n');
            lines.forEach((line, i) => {
                if (!/via\s*[!=]==\s*'lan'/.test(line)) return;
                const near = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
                if (/\b(?:Aboard|Away|aboard|onboard|boat network)\b/.test(near)) offenders.push(`${f.path}:${i + 1}`);
            });
        }
        expect(offenders).toEqual([]);
    });

    it('no screen reads the Pi cache’s host ladder as a place (viaRemoteAccess)', () => {
        const offenders = files
            .filter((f) => f.path !== 'services/PiCacheService.ts' && /\.viaRemoteAccess\b/.test(f.text))
            .map((f) => f.path);
        expect(offenders).toEqual([]);
    });

    it('the phone stands in for the boat only by the boat link’s rule (by position, or a GPS-less bus on her own network)', () => {
        const overlay = readFileSync('components/map/MapboxVelocityOverlay.tsx', 'utf8');
        expect(overlay).toContain('const aboard = BoatLinkService.phoneStandsInForBoat();');
        expect(code(overlay)).not.toMatch(/const aboard = NmeaStore\.isBoatFeed\(\)/);
    });
});
