/**
 * Shane 2026-08-28: "on the nmea gateway card, we have enable remote access,
 * but i can still reach the ydwg-02 without it being connected??? so i am
 * unsure of its purpose. bear in mind the ydwg-02 is on the yacht, and i am
 * here at home."
 *
 * He was right to be unsure, and I put it there. "Enable remote access" runs
 * `tailscale up` ON THE PI — POST /api/remote-access/enable against pi-cache —
 * and makes the PI reachable off the boat. It has nothing to do with the
 * gateway. He reaches the YDWG-02 from home because his RUTX50 advertises the
 * boat's 192.168.1.0/24 to his tailnet and the route is approved: a router
 * setting, true whether the Pi is on, off, or on his bench at home.
 *
 * It was also mounted on the NMEA card AND in the Boat Pi tab — one Pi
 * setting with two switches on two screens.
 *
 * What belongs on the gateway card is the question the gateway card raises:
 * can this phone reach THIS gateway from where it is standing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const nmea = readFileSync('components/vessel/NmeaPage.tsx', 'utf8');
const piTab = readFileSync('components/settings/PiCacheTab.tsx', 'utf8');
const avNav = readFileSync('components/vessel/AvNavPage.tsx', 'utf8');

/** Every component file, so "exactly one mount" is a real sweep. */
function sourceFiles(dir = 'components', out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) sourceFiles(p, out);
        else if (p.endsWith('.tsx') && !p.includes('.test.')) out.push(p);
    }
    return out;
}

describe('the Pi control is off the gateway card', () => {
    it('no longer renders remote access there', () => {
        expect(nmea).not.toContain('<RemoteAccessSection />');
        expect(nmea).not.toContain('RemoteAccessSection');
    });

    it("still has exactly one home — the Vessel tab's Boat Network page", () => {
        // Moved out of the Advanced settings tab on 2026-08-29 at Shane's
        // request. That page is the everyday "is the boat there?" glance, and
        // "can I reach the Pi from away?" is the same question from further
        // off. The settings tab keeps pairing, the fingerprint and the cache.
        //
        // The invariant that matters is ONE mount, not which file: it had two
        // for a day and that is how a single Pi setting ends up with two
        // switches on two screens.
        expect(avNav).toContain('<RemoteAccessSection />');
        expect(piTab).not.toContain('<RemoteAccessSection />');
        expect(piTab).not.toContain('import { RemoteAccessSection }');
    });

    it('is mounted exactly once across the whole app', () => {
        const mounts = sourceFiles().filter((f) => readFileSync(f, 'utf8').includes('<RemoteAccessSection />'));
        expect(mounts).toHaveLength(1);
    });
});

describe('what the gateway card says instead', () => {
    // 2026-10-07: the route note guessed "you are not on the gateway's network"
    // from a /24 match on this phone's own address. 192.168.1.0/24 is the
    // world's commonest home network, so at home it went quiet, and over
    // Tailscale it never spoke at all — while the pill above it said "Aboard"
    // from 900 km away. One line now answers the question from where the
    // phone actually is (services/boatLink).
    const model = readFileSync('services/boatLink/boatLinkModel.ts', 'utf8');
    const service = readFileSync('services/boatLink/BoatLinkService.ts', 'utf8');

    it('no longer guesses the route from a subnet match', () => {
        expect(nmea).not.toContain('GatewayRouteNote');
        expect(nmea).not.toContain('assessHostRoute');
        expect(nmea).toContain('data-testid="gateway-link-line"');
        expect(nmea).toContain('{link.line}');
    });

    it('says nothing about the path it cannot know', () => {
        // No interface data (web, or a failure), or no address on the
        // device's own /24, and no place: the path is 'direct', never a guess
        // at Wi-Fi or a VPN.
        expect(model).toContain("return onSubnetOf(network, deviceHost) ? 'boat-wifi' : 'direct';");
        expect(model).toContain('Reading the boat directly from ${pi}.');
    });

    it('names a VPN only when an address proves which one', () => {
        expect(model).toContain(
            "return piOnTailscale && network.tunnelAddresses.some(isTailnetAddress) ? 'Tailscale' : 'your VPN';",
        );
        expect(nmea).not.toMatch(/this works if that VPN carries/);
    });

    it('does not nag about the hairpin', () => {
        expect(nmea).not.toContain('turn it off aboard so traffic goes direct');
        expect(nmea).not.toContain('connecting directly');
    });

    it('STILL speaks the one time the skipper must act: a gateway-only boat that is not answering', () => {
        expect(model).toContain('answers on the boat’s Wi-Fi, or over a VPN to the boat’s network.');
    });

    it('notices the skipper joining Wi-Fi or toggling the VPN', () => {
        expect(service).toContain('const NETWORK_REFRESH_MS = 15_000;');
    });
});
