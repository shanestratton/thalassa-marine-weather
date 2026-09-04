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
    it('reports on the gateway host, not the Pi', () => {
        expect(nmea).toContain('<GatewayRouteNote host={host} />');
        expect(nmea).toContain("assessHostRoute(host, 'the NMEA gateway')");
    });

    it('says nothing at all when it cannot know', () => {
        // Empty interfaces on web and on any failure. A false claim about the
        // network is what sends a skipper to the boat for a phone problem.
        expect(nmea).toContain('if (!state || !state.known) return null;');
        expect(nmea).toContain('known: interfaces.length > 0');
    });

    it('says NOTHING when a VPN is up, rather than explaining a non-problem', () => {
        // It used to say "a VPN is up, so this works if that VPN carries the
        // boat's network" — true, unverifiable, and shown at the exact moment
        // the setup was fine. iOS exposes that a tunnel is up, never which
        // subnets it carries, so the honest move is silence, not a hedge.
        // Shane 2026-09-04: "VPN's are for advanced users only, so they will
        // not [need] this. also it is buggering up my screen."
        expect(nmea).toContain('if (state.onLan || state.vpn) return null;');
        expect(nmea).not.toMatch(/this works if that VPN carries/);
        expect(nmea).not.toMatch(/connected via the VPN|reachable over the VPN/);
    });

    it('does not nag about the hairpin, or narrate a working connection', () => {
        // Scoped to what RENDERS. A whole-file match read the comment above
        // the guard — which quotes the removed wording to explain why it went
        // — and failed on the explanation rather than on the behaviour.
        const render = nmea.slice(
            nmea.indexOf('if (state.onLan || state.vpn) return null;'),
            nmea.indexOf('export const NmeaPage'),
        );
        expect(render.length).toBeGreaterThan(0);
        expect(render).not.toContain('turn it off aboard so traffic goes direct');
        expect(render).not.toContain('connecting directly');
    });

    it('STILL speaks the one time the skipper must act', () => {
        // No LAN and no tunnel is a real dead end. Removing this one too would
        // make a genuine failure silent — the fault this page exists to catch.
        expect(nmea).toMatch(/Join the boat&apos;s Wi-Fi to reach the gateway/);
    });

    it('notices the skipper joining Wi-Fi or toggling the VPN', () => {
        expect(nmea).toContain('setInterval(() => void check(), 20_000)');
    });
});
