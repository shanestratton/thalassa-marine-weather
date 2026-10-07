/**
 * boatLinkModel — where this phone is, how the boat reaches it, how fresh.
 *
 * Shane 2026-10-07, at home with the boat 900 km away and reading her over
 * Tailscale: "it seems to get confused about where we are … sometime take
 * over, other times it says i am onboard, sometimes it says remote, other
 * times it says live." Thalassa is a global app, so the places here are from
 * every ocean, and the networks are whatever a boat might have: a Pi or none,
 * a gateway or none, Tailscale, another VPN, a router-to-router VPN, the Pi's
 * internet updates, or nothing at all from ashore. Fictional fixes and
 * documentation-range addresses only (RFC 5737 TEST-NET, 100.64/10 CGNAT).
 */
import { describe, expect, it } from 'vitest';
import {
    ABOARD_M,
    atBoatsLastBerth,
    describeBoatLink,
    echoSameNetwork,
    fallbackSocketPermitted,
    hairpinProven,
    phoneMayStandInForBoat,
    isTailnetAddress,
    isTailnetHost,
    metresBetween,
    networkFactsFrom,
    networkNameFor,
    resolveData,
    resolveKind,
    resolveLane,
    resolveWhere,
    UNKNOWN_NETWORK,
    WHERE_HOLD_MS,
    type NetworkFacts,
    type PlaceFix,
    type StoreFacts,
    type WhereResult,
} from '../services/boatLink/boatLinkModel';

const NOW = Date.parse('2026-10-07T03:00:00Z');
const fix = (lat: number, lon: number, agoMs = 2_000, accuracyM: number | null = 8): PlaceFix => ({
    lat,
    lon,
    at: NOW - agoMs,
    accuracyM,
});
/** A point `metres` north of another. */
const north = (p: PlaceFix, metres: number, agoMs = 2_000, accuracyM: number | null = 8): PlaceFix =>
    fix(p.lat + metres / 111_320, p.lon, agoMs, accuracyM);

const HOME_WIFI_WITH_TAILSCALE: NetworkFacts = {
    known: true,
    lanAddresses: ['10.0.0.23'],
    tunnelAddresses: ['100.101.102.103'],
};
const BOAT_WIFI: NetworkFacts = { known: true, lanAddresses: ['192.0.2.37'], tunnelAddresses: [] };
const BOAT_WIFI_WITH_TAILSCALE: NetworkFacts = {
    known: true,
    lanAddresses: ['192.0.2.37'],
    tunnelAddresses: ['100.101.102.103'],
};
const HOME_WIFI_WITH_ZEROTIER: NetworkFacts = {
    known: true,
    lanAddresses: ['198.51.100.20'],
    tunnelAddresses: ['10.147.17.5'],
};
const HOME_WIFI_NO_VPN: NetworkFacts = { known: true, lanAddresses: ['192.168.1.44'], tunnelAddresses: [] };
/** Aboard on cellular only, the boat's Wi-Fi not joined, a VPN up. */
const CELLULAR_WITH_VPN: NetworkFacts = {
    known: true,
    lanAddresses: ['10.20.30.40'],
    tunnelAddresses: ['100.101.102.103'],
};
/** The Pi's own boat-network address (TEST-NET-1, the boat's /24). */
const PI_LAN = '192.0.2.180';

describe('WHERE: decided by position, never by which address answered', () => {
    it('Moreton Bay phone, Whitsundays boat (the reported case): away, whatever answered', () => {
        const phone = fix(-27.21, 153.1);
        const boat = fix(-20.27, 148.72, 3_000);
        const r = resolveWhere({ now: NOW, phone, boat });
        expect(r.where).toBe('ashore');
        expect(r.reason).toBe('apart');
        expect(r.separationM).toBeGreaterThan(800_000);
    });

    it('a Mediterranean marina berth: phone and boat 40 m apart is aboard', () => {
        const boat = fix(43.6952, 7.2861);
        expect(resolveWhere({ now: NOW, phone: north(boat, 40), boat })).toMatchObject({
            where: 'aboard',
            reason: 'together',
        });
    });

    it('a Caribbean anchorage: the dinghy 250 m off is with her; the beach bar 900 m off is not', () => {
        const boat = fix(13.0071, -61.2432);
        expect(resolveWhere({ now: NOW, phone: north(boat, 250), boat }).where).toBe('aboard');
        expect(resolveWhere({ now: NOW, phone: north(boat, 900, 2_000, 10), boat }).where).toBe('ashore');
    });

    it('the North Sea under way: fresh fixes 60 m apart are aboard', () => {
        const boat = fix(54.21, 4.88, 1_000);
        expect(resolveWhere({ now: NOW, phone: north(boat, 60, 1_500), boat }).where).toBe('aboard');
    });

    it('a held boat fix six hours old still proves 900 km', () => {
        const phone = fix(-27.21, 153.1);
        const boat = fix(-20.27, 148.72, 6 * 3_600_000);
        expect(resolveWhere({ now: NOW, phone, boat }).where).toBe('ashore');
    });

    it('a phone fix kept from an hour ago proves nothing: the phone may have flown to her since', () => {
        const boat = fix(-20.27, 148.72, 3_000);
        expect(resolveWhere({ now: NOW, phone: fix(-27.21, 153.1, 60 * 60_000), boat })).toMatchObject({
            where: 'unknown',
            reason: 'no-phone-fix',
        });
        // Fifteen minutes old still counts, with the road allowance.
        expect(resolveWhere({ now: NOW, phone: fix(-27.21, 153.1, 14 * 60_000), boat }).where).toBe('ashore');
    });

    it('a held boat fix three days old proves nothing even at 900 km: she may have been moved', () => {
        const phone = fix(-27.21, 153.1);
        const boat = fix(-20.27, 148.72, 3 * 86_400_000);
        expect(resolveWhere({ now: NOW, phone, boat }).where).toBe('unknown');
    });

    it('a held boat fix six hours old cannot tell 20 km: too close to call', () => {
        const boat = fix(41.38, 2.18, 6 * 3_600_000);
        const r = resolveWhere({ now: NOW, phone: north(boat, 20_000), boat });
        expect(r).toMatchObject({ where: 'unknown', reason: 'too-close-to-call' });
    });

    it('a poor phone fix (2 km) beside her cannot say aboard', () => {
        const boat = fix(-33.86, 151.21);
        expect(resolveWhere({ now: NOW, phone: north(boat, 50, 2_000, 2_000), boat }).where).toBe('unknown');
    });

    it('a stale phone fix (10 min) beside her cannot say aboard, nor can a stale boat fix (20 min)', () => {
        const boat = fix(25.77, -80.13);
        expect(resolveWhere({ now: NOW, phone: north(boat, 30, 10 * 60_000), boat }).where).toBe('unknown');
        const oldBoat = fix(25.77, -80.13, 20 * 60_000);
        expect(resolveWhere({ now: NOW, phone: north(oldBoat, 30), boat: oldBoat }).where).toBe('unknown');
    });

    it('US East Coast with location off: unknown, and says why; the Pi seeing this phone’s Wi-Fi says aboard', () => {
        const boat = fix(38.97, -76.48);
        expect(resolveWhere({ now: NOW, phone: null, boat })).toMatchObject({
            where: 'unknown',
            reason: 'no-phone-fix',
        });
        expect(resolveWhere({ now: NOW, phone: null, boat, sameNetwork: true })).toMatchObject({
            where: 'aboard',
            reason: 'same-network',
        });
    });

    it('her GPS quiet: unknown, and says so', () => {
        expect(resolveWhere({ now: NOW, phone: fix(50.76, -1.54), boat: null })).toMatchObject({
            where: 'unknown',
            reason: 'no-boat-fix',
        });
    });

    it('a routed VPN from home, the boat’s fix three days old: the Pi seeing my home address is not "Aboard"', () => {
        // Site-to-site WireGuard from the boat's router, no address
        // translation: the Pi sees this phone's real home address.
        const boat = fix(-20.27, 148.72, 3 * 86_400_000, 5);
        const routed = { answeredVia: 'lan-host' as const, seenFrom: '192.168.1.44', seenAt: '192.0.2.180' };
        const sameNetwork = echoSameNetwork(HOME_WIFI_NO_VPN, routed);
        expect(sameNetwork).toBe(false);
        const r = resolveWhere({ now: NOW, phone: fix(-27.21, 153.1), boat, sameNetwork });
        expect(r.where).not.toBe('aboard');
        expect(fallbackSocketPermitted(r.where, HOME_WIFI_NO_VPN, '192.0.2.151')).toBe(false);
    });

    it('GPS clearly apart outranks the network: a Pi on the bench at home is not the boat', () => {
        const phone = fix(-27.21, 153.1);
        const boat = fix(-20.27, 148.72);
        expect(resolveWhere({ now: NOW, phone, boat, sameNetwork: true }).where).toBe('ashore');
    });

    it('null island and future-dated fixes are not fixes', () => {
        const boat = fix(-20.27, 148.72);
        expect(resolveWhere({ now: NOW, phone: fix(0, 0), boat }).reason).toBe('no-phone-fix');
        expect(resolveWhere({ now: NOW, phone: fix(-20.27, 148.72, -60_000), boat }).reason).toBe('no-phone-fix');
    });

    it('hysteresis: once aboard, 400 m stays aboard; well clear is away', () => {
        const boat = fix(-20.27, 148.72);
        const previous = { where: 'aboard' as const, at: NOW - 5_000 };
        expect(resolveWhere({ now: NOW, phone: north(boat, 400), boat, previous }).where).toBe('aboard');
        expect(resolveWhere({ now: NOW, phone: north(boat, 400), boat }).where).toBe('unknown');
        expect(resolveWhere({ now: NOW, phone: north(boat, 700), boat, previous }).where).toBe('ashore');
    });

    it('an inconclusive reading keeps the last decided answer for a while, then lets it go', () => {
        const boat = fix(-20.27, 148.72);
        const recent = { where: 'ashore' as const, at: NOW - 5 * 60_000 };
        expect(resolveWhere({ now: NOW, phone: null, boat, previous: recent })).toMatchObject({
            where: 'ashore',
            reason: 'held',
        });
        const old = { where: 'ashore' as const, at: NOW - WHERE_HOLD_MS - 1 };
        expect(resolveWhere({ now: NOW, phone: null, boat, previous: old }).where).toBe('unknown');
    });

    it('measures like the haversine everyone else uses', () => {
        expect(Math.round(metresBetween(fix(0, 0.001), fix(0, 0.002)))).toBe(111);
        expect(ABOARD_M).toBe(300);
    });
});

describe('LINK: which path carries her, never a place', () => {
    const pi = (
        answeredVia: 'lan-host' | 'tailnet-host' | null,
        seenFrom: string | null = null,
        seenAt: string | null = seenFrom ? PI_LAN : null,
    ) => ({
        answeredVia,
        seenFrom,
        seenAt,
    });

    it('the reported case: the boat-network address answering over a Tailscale subnet route from away', () => {
        const params = {
            lane: 'pi-direct' as const,
            where: 'ashore' as const,
            network: HOME_WIFI_WITH_TAILSCALE,
            pi: pi('lan-host'),
            gatewayHost: '192.0.2.151',
            // The paired Pi runs Tailscale: its remote-access status gave this phone its tailnet address.
            piOnTailscale: true,
        };
        expect(resolveKind(params)).toBe('private-network');
        expect(networkNameFor(params)).toBe('Tailscale');
    });

    it('a 100.64/10 tunnel alone is not Tailscale: NetBird and Cloudflare WARP use that range too', () => {
        const params = {
            lane: 'pi-direct' as const,
            where: 'ashore' as const,
            network: HOME_WIFI_WITH_TAILSCALE,
            pi: pi('lan-host'),
            gatewayHost: '192.0.2.151',
        };
        expect(networkNameFor(params)).toBe('your VPN');
        // A gateway at an overlay address is a private network, but which one it does not say.
        const overlayGateway = {
            lane: 'socket' as const,
            where: 'ashore' as const,
            network: HOME_WIFI_WITH_TAILSCALE,
            pi: pi(null),
            gatewayHost: '100.96.12.34',
        };
        expect(resolveKind(overlayGateway)).toBe('private-network');
        expect(networkNameFor(overlayGateway)).toBe('your VPN');
    });

    it('the Pi’s own tailnet address answering is a private network, wherever the phone is', () => {
        expect(
            resolveKind({
                lane: 'pi-direct',
                where: 'unknown',
                network: UNKNOWN_NETWORK,
                pi: pi('tailnet-host'),
                gatewayHost: null,
            }),
        ).toBe('private-network');
    });

    it('aboard on the boat’s Wi-Fi: the Pi saw this phone’s own address', () => {
        expect(
            resolveKind({
                lane: 'pi-direct',
                where: 'unknown',
                network: BOAT_WIFI_WITH_TAILSCALE,
                pi: pi('lan-host', '192.0.2.37'),
                gatewayHost: null,
            }),
        ).toBe('boat-wifi');
    });

    it('the hairpin is proven only by the Pi’s echo: aboard, a VPN up, and the request came in via the router', () => {
        expect(hairpinProven('aboard', BOAT_WIFI_WITH_TAILSCALE, pi('lan-host', '192.0.2.1'))).toBe(true);
        expect(hairpinProven('aboard', BOAT_WIFI_WITH_TAILSCALE, pi('lan-host', '192.0.2.37'))).toBe(false);
        expect(hairpinProven('aboard', BOAT_WIFI_WITH_TAILSCALE, pi('lan-host', null))).toBe(false);
        // Away, the same echo is simply the VPN working.
        expect(hairpinProven('ashore', HOME_WIFI_WITH_TAILSCALE, pi('lan-host', '192.0.2.1'))).toBe(false);
    });

    it('aboard on cellular alone, the VPN is the only way to the Pi: no hairpin, never "turn it off"', () => {
        // The router translated the source to its own address, as a subnet router does.
        expect(hairpinProven('aboard', CELLULAR_WITH_VPN, pi('lan-host', '192.0.2.1'))).toBe(false);
        // An older Pi with no seen_at: the saved boat-network address decides.
        expect(hairpinProven('aboard', CELLULAR_WITH_VPN, pi('lan-host', '192.0.2.1', null), PI_LAN)).toBe(false);
        expect(hairpinProven('aboard', BOAT_WIFI_WITH_TAILSCALE, pi('lan-host', '192.0.2.1', null), PI_LAN)).toBe(true);
        // With neither, nothing is proven.
        expect(hairpinProven('aboard', BOAT_WIFI_WITH_TAILSCALE, pi('lan-host', '192.0.2.1', null))).toBe(false);
    });

    it('the Pi seeing this phone’s address is one network only on the Pi’s own /24', () => {
        // On the boat's Wi-Fi.
        expect(echoSameNetwork(BOAT_WIFI, pi('lan-host', '192.0.2.37'))).toBe(true);
        // A routed VPN with no address translation (site-to-site WireGuard, a
        // subnet route with source NAT off): the Pi sees this phone's real
        // home address, which is this phone's own — on another /24.
        expect(echoSameNetwork(HOME_WIFI_NO_VPN, pi('lan-host', '192.168.1.44', PI_LAN))).toBe(false);
        expect(
            resolveKind({
                lane: 'pi-direct',
                where: 'unknown',
                network: HOME_WIFI_NO_VPN,
                pi: pi('lan-host', '192.168.1.44', PI_LAN),
                gatewayHost: null,
            }),
        ).toBe('private-network');
        // An older Pi echoes only where the request came from: proves nothing.
        expect(echoSameNetwork(BOAT_WIFI, pi('lan-host', '192.0.2.37', null))).toBe(false);
        expect(echoSameNetwork(UNKNOWN_NETWORK, pi('lan-host', '192.0.2.37'))).toBe(false);
    });

    it('a router-to-router VPN: away, no tunnel on the phone, the boat’s address answers — a private network, “your VPN”', () => {
        const params = {
            lane: 'pi-direct' as const,
            where: 'ashore' as const,
            network: HOME_WIFI_NO_VPN,
            pi: pi('lan-host'),
            gatewayHost: null,
        };
        expect(resolveKind(params)).toBe('private-network');
        expect(networkNameFor(params)).toBe('your VPN');
    });

    it('ZeroTier, WireGuard or any other tunnel is “your VPN”, not Tailscale', () => {
        expect(
            networkNameFor({
                network: HOME_WIFI_WITH_ZEROTIER,
                pi: pi('lan-host'),
                lane: 'pi-direct',
                gatewayHost: null,
            }),
        ).toBe('your VPN');
    });

    it('a gateway-only boat reached by MagicDNS name is over Tailscale', () => {
        const params = {
            lane: 'socket' as const,
            where: 'unknown' as const,
            network: UNKNOWN_NETWORK,
            pi: pi(null),
            gatewayHost: 'boat-gateway.tail1234.ts.net',
        };
        expect(resolveKind(params)).toBe('private-network');
        expect(networkNameFor(params)).toBe('Tailscale');
    });

    it('with no interface data and no place, the path is honestly unknown', () => {
        expect(
            resolveKind({
                lane: 'socket',
                where: 'unknown',
                network: UNKNOWN_NETWORK,
                pi: pi(null),
                gatewayHost: '192.0.2.151',
            }),
        ).toBe('direct');
    });

    it('the lane comes from the store’s own ranking; a phone’s cloud row is no boat feed', () => {
        const store = (over: Partial<StoreFacts>): StoreFacts => ({
            status: 'disconnected',
            via: null,
            source: null,
            readingAt: null,
            usableReading: false,
            ...over,
        });
        expect(resolveLane(store({ status: 'connected' }))).toBe('socket');
        expect(resolveLane(store({ status: 'remote', via: 'lan', source: 'pi' }))).toBe('pi-direct');
        expect(resolveLane(store({ status: 'remote', via: 'cloud', source: 'pi' }))).toBe('cloud');
        // A phone's cloud row is the boat's readings through that phone: a lane, never her position.
        expect(resolveLane(store({ status: 'remote', via: 'cloud', source: 'device' }))).toBe('shared');
        expect(
            resolveKind({ lane: 'shared', where: 'ashore', network: BOAT_WIFI, pi: pi(null), gatewayHost: null }),
        ).toBe('cloud');
    });

    it('reads interfaces as iOS reports them', () => {
        expect(networkFactsFrom([])).toEqual(UNKNOWN_NETWORK);
        expect(
            networkFactsFrom([
                { name: 'lo0', address: '127.0.0.1', family: 'ipv4', tunnel: false },
                { name: 'en0', address: '192.0.2.37', family: 'ipv4', tunnel: false },
                { name: 'en0', address: '169.254.3.3', family: 'ipv4', tunnel: false },
                { name: 'utun3', address: '100.101.102.103', family: 'ipv4', tunnel: true },
            ]),
        ).toEqual({ known: true, lanAddresses: ['192.0.2.37'], tunnelAddresses: ['100.101.102.103'] });
        expect(isTailnetAddress('100.64.0.1')).toBe(true);
        expect(isTailnetAddress('100.128.0.1')).toBe(false);
        expect(isTailnetHost('Boat.TAIL1234.ts.net.')).toBe(true);
    });
});

describe('the fallback socket: aboard only', () => {
    it('away never takes a gateway slot; aboard may', () => {
        expect(fallbackSocketPermitted('ashore', BOAT_WIFI, '192.0.2.151')).toBe(false);
        expect(fallbackSocketPermitted('aboard', HOME_WIFI_WITH_TAILSCALE, '192.0.2.151')).toBe(true);
    });

    it('place unknown: only on the gateway’s own network with no VPN up', () => {
        expect(fallbackSocketPermitted('unknown', BOAT_WIFI, '192.0.2.151')).toBe(true);
        expect(fallbackSocketPermitted('unknown', BOAT_WIFI_WITH_TAILSCALE, '192.0.2.151')).toBe(false);
        expect(fallbackSocketPermitted('unknown', HOME_WIFI_WITH_TAILSCALE, '192.0.2.151')).toBe(false);
        expect(fallbackSocketPermitted('unknown', UNKNOWN_NETWORK, '192.0.2.151')).toBe(false);
        expect(fallbackSocketPermitted('unknown', BOAT_WIFI, null)).toBe(false);
    });

    it('the Pi dead for days and a VPN up aboard: at her last berth and on the gateway’s /24, the fallback may open', () => {
        // Fictional St Peter Port berth; her fix held from three days ago, when the Pi died.
        const held = fix(49.4567, -2.5361, 3 * 86_400_000, 5);
        const phone = north(held, 13);
        const where = resolveWhere({ now: NOW, phone, boat: held });
        expect(where).toMatchObject({ where: 'unknown', reason: 'too-close-to-call' });
        const atBerth = atBoatsLastBerth({ now: NOW, phone, boat: held });
        expect(atBerth).toBe(true);
        expect(fallbackSocketPermitted(where.where, BOAT_WIFI_WITH_TAILSCALE, '192.0.2.151', atBerth)).toBe(true);
        // At her berth but not on her network (cellular): no.
        expect(fallbackSocketPermitted(where.where, CELLULAR_WITH_VPN, '192.0.2.151', atBerth)).toBe(false);
        // On a network with the same numbers, 900 km from her berth: no.
        const home = fix(-27.21, 153.1);
        expect(atBoatsLastBerth({ now: NOW, phone: home, boat: held })).toBe(false);
        // An old or poor phone fix is not "at her berth".
        expect(atBoatsLastBerth({ now: NOW, phone: north(held, 13, 10 * 60_000), boat: held })).toBe(false);
        expect(atBoatsLastBerth({ now: NOW, phone: north(held, 13, 2_000, 400), boat: held })).toBe(false);
        expect(atBoatsLastBerth({ now: NOW, phone: null, boat: held })).toBe(false);
    });
});

describe('DATA: live, so old, quiet, connecting, failed, none', () => {
    const live: StoreFacts = {
        status: 'remote',
        via: 'lan',
        source: 'pi',
        readingAt: NOW - 3_000,
        usableReading: true,
    };
    const noSocket = { status: 'disconnected' as const, owner: 'none' as const };

    it('a lane with a current reading is live; with an old one, its age', () => {
        expect(
            resolveData({
                now: NOW,
                lane: 'pi-direct',
                where: 'ashore',
                store: live,
                socket: noSocket,
                piQuiet: false,
                lastReading: null,
            }),
        ).toEqual({ state: 'live', ageMs: 3_000 });
        expect(
            resolveData({
                now: NOW,
                lane: 'cloud',
                where: 'ashore',
                store: { ...live, via: 'cloud', readingAt: NOW - 45_000 },
                socket: noSocket,
                piQuiet: false,
                lastReading: null,
            }),
        ).toEqual({ state: 'stale', ageMs: 45_000 });
    });

    it('a lane gone a moment ago keeps its reading’s age on screen, then lets go', () => {
        const none: StoreFacts = { ...live, status: 'disconnected', via: null, source: null, usableReading: false };
        const at = (ago: number) =>
            resolveData({
                now: NOW,
                lane: 'none',
                where: 'ashore',
                store: none,
                socket: noSocket,
                piQuiet: false,
                lastReading: { at: NOW - ago, lane: 'pi-direct' },
            });
        expect(at(40_000)).toEqual({ state: 'stale', ageMs: 40_000 });
        expect(at(6 * 60_000).state).toBe('none');
    });

    it('a gateway-only boat’s own socket failing aboard is a failure; from away it is not', () => {
        const none: StoreFacts = { status: 'error', via: null, source: null, readingAt: null, usableReading: false };
        const d = (where: 'aboard' | 'ashore' | 'unknown', status: 'error' | 'connecting', retrying = false) =>
            resolveData({
                now: NOW,
                lane: 'none',
                where,
                store: none,
                socket: { status, owner: 'boot', retrying },
                piQuiet: false,
                lastReading: null,
            }).state;
        expect(d('aboard', 'error')).toBe('failed');
        expect(d('unknown', 'error')).toBe('failed');
        expect(d('ashore', 'error')).toBe('none');
        expect(d('aboard', 'connecting')).toBe('connecting');
        // A retry after a failure stays failed: no blinking between the two.
        expect(d('aboard', 'connecting', true)).toBe('failed');
        expect(d('ashore', 'connecting', true)).toBe('none');
    });

    it('the policy’s fallback socket never paints the pill red', () => {
        expect(
            resolveData({
                now: NOW,
                lane: 'none',
                where: 'aboard',
                store: { status: 'error', via: null, source: null, readingAt: null, usableReading: false },
                socket: { status: 'error', owner: 'policy' },
                piQuiet: false,
                lastReading: null,
            }).state,
        ).toBe('none');
    });
});

describe('WORDS: one vocabulary for every screen', () => {
    const away: WhereResult = { where: 'ashore', reason: 'apart', separationM: 891_000 };
    const aboard: WhereResult = { where: 'aboard', reason: 'together', separationM: 30 };
    const unknown: WhereResult = { where: 'unknown', reason: 'no-phone-fix', separationM: null };
    const setupPi = { piPaired: true, gatewaySaved: true, gatewayLabel: 'YDWG-02' };
    const setupGateway = { piPaired: false, gatewaySaved: true, gatewayLabel: 'YDWG-02' };
    const noSocket = { status: 'disconnected' as const, owner: 'none' as const };
    const liveData = { state: 'live' as const, ageMs: 3_000 };

    it('the reported case reads Away · Live, over Tailscale — never Aboard', () => {
        const w = describeBoatLink({
            where: away,
            lane: 'pi-direct',
            kind: 'private-network',
            networkName: 'Tailscale',
            data: liveData,
            setup: setupPi,
            socket: noSocket,
        });
        expect(w.pill).toMatchObject({ text: 'Away · Live', tone: 'sky' });
        expect(w.line).toBe('Reading the boat through your Pi, over Tailscale.');
        expect(w.statusRow).toBe('Away · Pi over Tailscale · live');
        expect(w.hub).toEqual({ value: 'Away · Live', status: 'Through the Pi · Tailscale', tone: 'sky' });
        expect(JSON.stringify(w)).not.toMatch(/Aboard/);
    });

    it('the same words whichever lane answered: the place does not move with the transport', () => {
        const lanes = [
            { lane: 'pi-direct' as const, kind: 'private-network' as const },
            { lane: 'cloud' as const, kind: 'cloud' as const },
            { lane: 'socket' as const, kind: 'private-network' as const },
        ];
        const pills = lanes.map(
            ({ lane, kind }) =>
                describeBoatLink({
                    where: away,
                    lane,
                    kind,
                    networkName: 'Tailscale',
                    data: liveData,
                    setup: setupPi,
                    socket: { status: lane === 'socket' ? 'connected' : 'disconnected', owner: 'skipper' },
                }).pill.text,
        );
        expect(new Set(pills)).toEqual(new Set(['Away · Live']));
    });

    it('aboard on the boat’s Wi-Fi', () => {
        const w = describeBoatLink({
            where: aboard,
            lane: 'pi-direct',
            kind: 'boat-wifi',
            networkName: 'your VPN',
            data: liveData,
            setup: setupPi,
            socket: noSocket,
        });
        expect(w.pill).toMatchObject({ text: 'Aboard · Live', tone: 'green' });
        expect(w.line).toBe('Reading the boat through your Pi, on the boat’s Wi-Fi.');
        expect(w.statusRow).toBe('Aboard · Pi on the boat’s Wi-Fi · live');
    });

    it('a crew phone on the train, through the Pi’s internet updates', () => {
        const w = describeBoatLink({
            where: away,
            lane: 'cloud',
            kind: 'cloud',
            networkName: 'your VPN',
            data: { state: 'stale', ageMs: 40_000 },
            setup: { piPaired: false, gatewaySaved: false, gatewayLabel: 'gateway' },
            socket: noSocket,
        });
        expect(w.pill).toMatchObject({ text: 'Away · 40 s old', tone: 'amber' });
        expect(w.line).toBe('Reading the boat through the Pi’s internet updates.');
        expect(w.statusRow).toBe('Away · Pi through the cloud · 40 s old');
        expect(w.hub.value).toBe('40 s old');
    });

    it('place unknown: no place word, and the reason the skipper can act on', () => {
        const w = describeBoatLink({
            where: unknown,
            lane: 'pi-direct',
            kind: 'direct',
            networkName: 'your VPN',
            data: liveData,
            setup: setupPi,
            socket: noSocket,
        });
        expect(w.pill.text).toBe('Live');
        expect(w.line).toBe('Reading the boat directly from your Pi.');
        expect(w.whereNote).toBe('Thalassa needs this phone’s location to tell whether you’re aboard.');
        expect(w.statusRow).toBe('Pi direct · live');
    });

    it('a gateway-only boat: failed aboard is red; away is a grey Not connected that says how she is reached', () => {
        const failed = describeBoatLink({
            where: aboard,
            lane: 'none',
            kind: 'none',
            networkName: 'your VPN',
            data: { state: 'failed', ageMs: null },
            setup: setupGateway,
            socket: { status: 'error', owner: 'boot' },
        });
        expect(failed.pill).toMatchObject({ text: 'Connection failed', tone: 'red' });
        expect(failed.statusRow).toBe('Aboard · YDWG-02 connection failed');
        const awayNone = describeBoatLink({
            where: away,
            lane: 'none',
            kind: 'none',
            networkName: 'your VPN',
            data: { state: 'none', ageMs: null },
            setup: setupGateway,
            socket: { status: 'error', owner: 'boot' },
        });
        expect(awayNone.pill).toMatchObject({ text: 'Away · Not connected', tone: 'grey' });
        expect(awayNone.line).toBe('The YDWG-02 answers on the boat’s Wi-Fi, or over a VPN to the boat’s network.');
        expect(awayNone.hub).toEqual({ value: 'Not connected', status: 'Instruments & AIS', tone: 'grey' });
    });

    it('a gateway-only boat over a VPN from away', () => {
        const w = describeBoatLink({
            where: away,
            lane: 'socket',
            kind: 'private-network',
            networkName: 'your VPN',
            data: liveData,
            setup: setupGateway,
            socket: { status: 'connected', owner: 'boot' },
        });
        expect(w.pill.text).toBe('Away · Live');
        expect(w.line).toBe('Connected to the YDWG-02 over your VPN.');
        expect(w.statusRow).toBe('Away · YDWG-02 over your VPN · live');
        expect(w.hub.status).toBe('YDWG-02 · your VPN');
    });

    it('the policy’s fallback socket aboard is one line on the Pi card, not the gateway controls', () => {
        const w = describeBoatLink({
            where: aboard,
            lane: 'socket',
            kind: 'boat-wifi',
            networkName: 'your VPN',
            data: liveData,
            setup: setupPi,
            socket: { status: 'connected', owner: 'policy' },
        });
        expect(w.line).toBe(
            'Your Pi hasn’t answered for a minute, so this phone is reading the YDWG-02 directly until it’s back.',
        );
        expect(w.statusRow).toBe('Aboard · YDWG-02 direct, Pi silent · live');
        expect(w.hub.status).toBe('YDWG-02 · Pi silent');
    });

    it('nothing set up and nothing arriving: No gateway', () => {
        const w = describeBoatLink({
            where: unknown,
            lane: 'none',
            kind: 'none',
            networkName: 'your VPN',
            data: { state: 'none', ageMs: null },
            setup: { piPaired: false, gatewaySaved: false, gatewayLabel: 'YDWG-02' },
            socket: noSocket,
        });
        expect(w.pill).toMatchObject({ text: 'No gateway', tone: 'grey' });
        expect(w.line).toBeNull();
        expect(w.whereNote).toBeNull();
        expect(w.statusRow).toBe('Not set up');
    });

    it('a Pi answering with a quiet bus', () => {
        const w = describeBoatLink({
            where: away,
            lane: 'none',
            kind: 'none',
            networkName: 'Tailscale',
            data: { state: 'quiet', ageMs: null },
            setup: setupPi,
            socket: noSocket,
        });
        expect(w.pill).toMatchObject({ text: 'Away · Boat quiet', tone: 'grey' });
        expect(w.line).toBe('Your Pi answers, but the boat’s instruments are quiet.');
    });
});

describe('WORDS: a link that has gone is said in the past tense', () => {
    const aboard: WhereResult = { where: 'aboard', reason: 'together', separationM: 30 };
    const away: WhereResult = { where: 'ashore', reason: 'apart', separationM: 160_000 };
    const stale = { state: 'stale' as const, ageMs: 40_000 };

    it('a gateway-only boat after Disconnect: never "Connected to" a closed socket', () => {
        const w = describeBoatLink({
            where: aboard,
            lane: 'none',
            kind: 'none',
            networkName: 'your VPN',
            data: stale,
            setup: { piPaired: false, gatewaySaved: true, gatewayLabel: 'YDWG-02' },
            socket: { status: 'disconnected', owner: 'none' },
            last: { lane: 'socket', kind: 'boat-wifi' },
        });
        expect(w.pill).toMatchObject({ text: 'Aboard · 40 s old', tone: 'amber' });
        expect(w.line).toBe(
            'Last reading came through the YDWG-02 on the boat’s Wi-Fi, 40 s ago. It isn’t connected now.',
        );
        expect(w.statusRow).toBe('Aboard · YDWG-02 not connected · 40 s old');
        expect(w.hub).toEqual({ value: '40 s old', status: 'YDWG-02 · not connected', tone: 'amber' });
        expect(JSON.stringify(w)).not.toMatch(/Connected to/);
    });

    it('the policy closed its fallback because the phone went ashore: the Pi line, not the gateway', () => {
        const w = describeBoatLink({
            where: away,
            lane: 'none',
            kind: 'none',
            networkName: 'Tailscale',
            data: stale,
            setup: { piPaired: true, gatewaySaved: true, gatewayLabel: 'YDWG-02' },
            socket: { status: 'disconnected', owner: 'none' },
            last: { lane: 'socket', kind: 'private-network' },
        });
        expect(w.line).toBe('Your Pi isn’t answering right now. Its readings show here as soon as it does.');
        expect(w.statusRow).toBe('Away · Pi not answering · 40 s old');
        expect(w.hub.status).toBe('Pi not answering');
        expect(JSON.stringify(w)).not.toMatch(/Connected to|over Tailscale/);
    });

    it('the Pi gone silent: says so at once, while its last reading ages', () => {
        const w = describeBoatLink({
            where: away,
            lane: 'none',
            kind: 'none',
            networkName: 'Tailscale',
            data: stale,
            setup: { piPaired: true, gatewaySaved: false, gatewayLabel: 'gateway' },
            socket: { status: 'disconnected', owner: 'none' },
            last: { lane: 'pi-direct', kind: 'private-network' },
        });
        expect(w.line).toBe('Your Pi isn’t answering right now. Its readings show here as soon as it does.');
        expect(w.line).not.toMatch(/Reading the boat/);
    });

    it('a crew phone whose cloud row has stopped: past tense too', () => {
        const w = describeBoatLink({
            where: away,
            lane: 'none',
            kind: 'none',
            networkName: 'your VPN',
            data: stale,
            setup: { piPaired: false, gatewaySaved: false, gatewayLabel: 'gateway' },
            socket: { status: 'disconnected', owner: 'none' },
            last: { lane: 'cloud', kind: 'cloud' },
        });
        expect(w.line).toBe('Last reading came through the boat’s Pi, 40 s ago.');
    });
});

describe('WORDS: the skipper’s phone sharing the boat', () => {
    it('a fresh phone-published row is a lane like any other, said as the skipper’s phone', () => {
        const w = describeBoatLink({
            where: { where: 'unknown', reason: 'no-boat-fix', separationM: null },
            lane: 'shared',
            kind: 'cloud',
            networkName: 'your VPN',
            data: { state: 'live', ageMs: 7_000 },
            setup: { piPaired: false, gatewaySaved: false, gatewayLabel: 'gateway' },
            socket: { status: 'disconnected', owner: 'none' },
        });
        expect(w.pill).toMatchObject({ text: 'Live', tone: 'green' });
        expect(w.line).toBe('Reading the boat through the skipper’s phone.');
        expect(w.statusRow).toBe('Skipper’s phone through the cloud · live');
        expect(w.hub).toEqual({ value: 'Live', status: 'Through the skipper’s phone', tone: 'green' });
    });
});

describe('the phone standing in for the boat’s position', () => {
    const unknownNoBoatFix: WhereResult = { where: 'unknown', reason: 'no-boat-fix', separationM: null };

    it('aboard by position, always', () => {
        expect(
            phoneMayStandInForBoat({
                where: { where: 'aboard', reason: 'together', separationM: 20 },
                lane: 'cloud',
                data: 'live',
                directEvidence: false,
            }),
        ).toBe(true);
    });

    it('a bus with wind but no GPS: a live direct lane on the boat’s own network stands in', () => {
        expect(
            phoneMayStandInForBoat({ where: unknownNoBoatFix, lane: 'socket', data: 'live', directEvidence: true }),
        ).toBe(true);
        expect(
            phoneMayStandInForBoat({ where: unknownNoBoatFix, lane: 'pi-direct', data: 'live', directEvidence: true }),
        ).toBe(true);
        // Over a VPN, the cloud, a stale feed, or with the boat's own fix in play: no.
        expect(
            phoneMayStandInForBoat({ where: unknownNoBoatFix, lane: 'socket', data: 'live', directEvidence: false }),
        ).toBe(false);
        expect(
            phoneMayStandInForBoat({ where: unknownNoBoatFix, lane: 'cloud', data: 'live', directEvidence: true }),
        ).toBe(false);
        expect(
            phoneMayStandInForBoat({ where: unknownNoBoatFix, lane: 'socket', data: 'stale', directEvidence: true }),
        ).toBe(false);
        expect(
            phoneMayStandInForBoat({
                where: { where: 'unknown', reason: 'too-close-to-call', separationM: 20_000 },
                lane: 'socket',
                data: 'live',
                directEvidence: true,
            }),
        ).toBe(false);
        expect(
            phoneMayStandInForBoat({
                where: { where: 'ashore', reason: 'apart', separationM: 160_000 },
                lane: 'socket',
                data: 'live',
                directEvidence: true,
            }),
        ).toBe(false);
    });
});
