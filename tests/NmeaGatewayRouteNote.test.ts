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
import { readFileSync } from 'node:fs';

const nmea = readFileSync('components/vessel/NmeaPage.tsx', 'utf8');
const piTab = readFileSync('components/settings/PiCacheTab.tsx', 'utf8');

describe('the Pi control is off the gateway card', () => {
    it('no longer renders remote access there', () => {
        expect(nmea).not.toContain('<RemoteAccessSection />');
        expect(nmea).not.toContain('RemoteAccessSection');
    });

    it('still has exactly one home, in the Boat Pi tab', () => {
        expect(piTab).toContain('<RemoteAccessSection />');
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

    it('does not claim a VPN carries the boat when it cannot see its routes', () => {
        // iOS exposes that a tunnel is up, never which subnets it carries.
        expect(nmea).toContain('this works if that VPN carries');
        expect(nmea).not.toMatch(/connected via the VPN|reachable over the VPN/);
    });

    it('tells a skipper on the boat LAN with a VPN up to turn it off', () => {
        // The hairpin: LAN traffic round-tripping to the internet and back,
        // which gets rediagnosed as broken hardware.
        expect(nmea).toContain('turn it off aboard so traffic goes direct');
    });

    it('names the direct case as direct', () => {
        expect(nmea).toContain("You are on the gateway's own network — connecting directly.");
    });

    it('notices the skipper joining Wi-Fi or toggling the VPN', () => {
        expect(nmea).toContain('setInterval(() => void check(), 20_000)');
    });
});
