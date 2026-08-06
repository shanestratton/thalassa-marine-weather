import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

/**
 * EVERY call to the Pi must go through the pinned transport.
 *
 * This is the test that would have caught the 2026-08-07 outage. Moving the Pi
 * to TLS changed `piCache.baseUrl` from http to https, and its certificate is
 * self-signed and pinned — so any caller still using CapacitorHttp or plain
 * fetch stopped completing the handshake. The conversion was partial:
 * discovery, pairing and fetchVerifiedFromPi were moved, but checkHealth was
 * not.
 *
 * checkHealth is the gate isAvailable() depends on, which is the gate the ENC
 * sync depends on. So the Pi could never become reachable, nothing synced, and
 * the app reported "no verified ENC charts" while the Pi sat there serving 345
 * of them. Nothing logged an error loud enough to notice, because every layer
 * treated an unreachable Pi as a normal offline condition.
 *
 * A grep-shaped test is the right tool here: the failure mode is a call site
 * someone forgot, and no behavioural test covers a transport that silently
 * degrades to "Pi is offline".
 */
const PI_TRANSPORT_FILES = [
    'services/PiCacheService.ts',
    'services/EncImportService.ts',
    'services/DiaryRelayTransport.ts',
    'services/OsmRouteOverlayService.ts',
    'services/ChartLockerService.ts',
    'services/isochroneEnhancer.ts',
];

/** Strip comments so prose about CapacitorHttp doesn't read as a call. */
const codeOf = (relative: string): string =>
    read(relative)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

describe('Pi transport completeness', () => {
    it('never sends a Pi URL through CapacitorHttp or plain fetch', () => {
        const offenders: string[] = [];

        for (const file of PI_TRANSPORT_FILES) {
            const code = codeOf(file);
            const lines = code.split('\n');
            lines.forEach((line, index) => {
                const usesRawTransport = /CapacitorHttp\.|await fetch\(/.test(line);
                if (!usesRawTransport) return;
                // A raw transport is only a bug when the URL is the Pi's. Look
                // back a few lines for the Pi base being interpolated — that is
                // how every one of these call sites builds its URL.
                const context = lines.slice(Math.max(0, index - 8), index + 1).join('\n');
                if (/piCache\.baseUrl|piCacheBase|\$\{piBase\}|\$\{base\}\/api\//.test(context)) {
                    offenders.push(`${file}:${index + 1} — ${line.trim().slice(0, 70)}`);
                }
            });
        }

        expect(offenders).toEqual([]);
    });

    it('keeps checkHealth on the pinned transport — it gates everything else', () => {
        const service = codeOf('services/PiCacheService.ts');
        const checkHealth = service.slice(service.indexOf('private async checkHealth'));
        // Search from 1: the slice STARTS with 'private async', so indexOf
        // from 0 matches immediately and yields an empty body that trivially
        // passes a .not assertion.
        const nextMethod = checkHealth.indexOf('private async ', 1);
        const body = nextMethod > 0 ? checkHealth.slice(0, nextMethod) : checkHealth;
        expect(body).toContain('pinnedPiRequest');
        expect(body).not.toMatch(/CapacitorHttp\.|await fetch\(/);
    });

    it('routes the ENC listing through the pinned transport', () => {
        // listPiInstalledCharts is what the ENC sync reads to learn which
        // cells the Pi holds. Unpinned, it returns [] and the app concludes
        // there are no charts.
        const enc = codeOf('services/EncImportService.ts');
        expect(enc).toContain('/api/enc/installed');
        const listing = enc.slice(enc.indexOf('export async function listPiInstalledCharts'));
        expect(listing.slice(0, 600)).toContain('pinnedPiRequest');
    });

    it('never carries the diary relay token over an unpinned channel', () => {
        // Confidentiality of this token is the reason the boat LAN went to TLS.
        const diary = codeOf('services/DiaryRelayTransport.ts');
        const postToPi = diary.slice(diary.indexOf('async function postToPi'));
        const body = postToPi.slice(0, postToPi.indexOf('async function configurePiRelay'));
        expect(body).toContain('pinnedPiRequest');
        expect(body).not.toMatch(/CapacitorHttp\.|await fetch\(/);

        // /api/configure is the other token-bearing call. Anchor on the URL
        // TEMPLATE, not the bare path — the path also appears inside an error
        // message string, and matching that would test nothing.
        const config = codeOf('services/PiCacheService.ts');
        const callSite = config.indexOf('url: `${this.baseUrl}/api/configure`');
        expect(callSite).toBeGreaterThan(-1);
        expect(config.slice(callSite - 300, callSite + 300)).toContain('pinnedPiRequest');
    });

    it('keeps the binary wind grid on an arraybuffer response', () => {
        // Reading GRIB2 as text corrupts it into a decode failure that looks
        // like a bad forecast rather than a transport bug.
        const iso = codeOf('services/isochroneEnhancer.ts');
        const piLeg = iso.slice(iso.indexOf('if (usePi)'), iso.indexOf('} else {'));
        expect(piLeg).toContain("responseType: 'arraybuffer'");
        expect(piLeg).not.toContain("responseType: 'text'");
    });
});
