/**
 * boatLinkModel — where this phone is, how the boat's data reaches it, and how
 * fresh that data is. Three separate answers, and the words every screen uses
 * for them. Pure: state in, words out.
 *
 * Shane 2026-10-07, at home in one port with the boat 900 km away in another,
 * reading her over Tailscale: "it seems to get confused about where we are …
 * sometime take over, other times it says i am onboard, sometimes it says
 * remote, other times it says live." Each screen used to work this out for
 * itself, and every one of them took "a request to the Pi was answered" to
 * mean "aboard". Over a VPN that carries the boat's network (a Tailscale
 * subnet router, ZeroTier, WireGuard to the boat's router, a router-to-router
 * VPN) the boat's own addresses answer from anywhere in the world, so the
 * label followed whichever transport had answered last.
 *
 *   WHERE — aboard / ashore / unknown. Decided by position, never by which
 *           address answered: this phone's fix against the boat's, with room
 *           for each fix's accuracy and age (the anchor watch's hand-over
 *           pattern). The one network fact that may say "aboard" is the Pi
 *           seeing a request arrive from this phone's own Wi-Fi address on
 *           the Pi's own /24 (echoSameNetwork), and only when the GPS cannot
 *           decide.
 *   LINK  — how the boat's data reaches this phone right now: the boat's
 *           Wi-Fi, a private network to her (any VPN), the Pi's internet
 *           updates, or nothing.
 *   DATA  — live, so many seconds old, quiet, connecting, failed, or none.
 *
 * Thalassa is a global app. Most boats have no Pi and no Tailscale: some have
 * only a gateway (YDWG-02, W2K-1, iKommunicate, a Signal K server, a plain
 * NMEA 0183 multiplexer); some reach the boat through a VPN of their own or
 * not at all from ashore. Nothing here assumes a network, a country or a
 * brand of VPN. "Tailscale" is said only when the tunnel's address proves it.
 */
import { sameIpv4Subnet, type NetworkInterfaceInfo } from '../../utils/lanRoute';

// ── WHERE ────────────────────────────────────────────────────────────────

/**
 * The phone is with the boat inside this distance. The Ship's Log and the
 * sightings log already use 300 m (services/shiplog/GpsSubscriptionManager.ts,
 * services/sightings/sightingContext.ts): a marina berth, a mooring, or the
 * dinghy alongside.
 */
export const ABOARD_M = 300;
/** Once aboard, leaving needs this much clear separation (hysteresis). */
export const LEAVE_M = 500;
/** A phone fix older than this cannot say "aboard" (it can still prove "ashore"). */
export const PHONE_FIX_MAX_MS = 120_000;
/** A phone fix less accurate than this cannot say "aboard". */
export const PHONE_ACC_MAX_M = 100;
/** A boat fix older than this cannot say "aboard". */
export const BOAT_FIX_ABOARD_MAX_MS = 600_000;
/** How far the boat may have moved per second since her fix (about 29 kn: a fast cruiser, not just a yacht). */
export const BOAT_DRIFT_MPS = 15;
/** How far the phone may have travelled per second since its fix (about 126 km/h). */
export const PHONE_TRAVEL_MPS = 35;
/**
 * A phone fix older than this proves nothing at all. Kept from an hour ago it
 * may be from before a flight to the boat; the road allowance above cannot
 * cover an aeroplane, so an old phone fix is "no fix", not "far away".
 */
export const PHONE_FIX_PROOF_MAX_MS = 15 * 60_000;
/** An inconclusive reading keeps the last decided answer this long. */
export const WHERE_HOLD_MS = 600_000;
/** A change from aboard to ashore (or back) must be seen twice this far apart. */
export const WHERE_CONFIRM_MS = 10_000;
/** Assumed when a fix carries no accuracy. */
const DEFAULT_PHONE_ACC_M = 100;
const DEFAULT_BOAT_ACC_M = 15;
const FUTURE_TOLERANCE_MS = 5_000;

export type Where = 'aboard' | 'ashore' | 'unknown';
export type WhereReason =
    /** Phone and boat fixes agree. */
    | 'together'
    /** Phone and boat fixes are clearly apart, after every allowance. */
    | 'apart'
    /** The Pi saw this phone's own Wi-Fi address, on the Pi's own /24: one network. */
    | 'same-network'
    /** Nothing decisive now; the last decided answer stands for a while. */
    | 'held'
    | 'no-phone-fix'
    | 'no-boat-fix'
    | 'too-close-to-call';

export interface PlaceFix {
    lat: number;
    lon: number;
    /** When the receiver produced the fix (epoch ms). */
    at: number;
    /** Horizontal accuracy in metres, when the receiver said. */
    accuracyM?: number | null;
}

export interface WhereResult {
    where: Where;
    reason: WhereReason;
    /** Metres between the two fixes, when both were usable. */
    separationM: number | null;
}

export interface WhereInput {
    now: number;
    phone: PlaceFix | null;
    boat: PlaceFix | null;
    /** echoSameNetwork: the Pi saw this phone's own Wi-Fi address, on the Pi's own /24. */
    sameNetwork?: boolean;
    /** The last DECIDED answer (together / apart / same-network) and when. */
    previous?: { where: Exclude<Where, 'unknown'>; at: number } | null;
}

/** Great-circle metres between two points. */
export function metresBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const toRad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toRad;
    const dLon = (b.lon - a.lon) * toRad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function usableFix(fix: PlaceFix | null | undefined, now: number): fix is PlaceFix {
    return (
        !!fix &&
        Number.isFinite(fix.lat) &&
        Number.isFinite(fix.lon) &&
        Math.abs(fix.lat) <= 90 &&
        Math.abs(fix.lon) <= 180 &&
        !(fix.lat === 0 && fix.lon === 0) &&
        Number.isFinite(fix.at) &&
        fix.at > 0 &&
        fix.at <= now + FUTURE_TOLERANCE_MS
    );
}

function accuracyOr(value: number | null | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Is this phone with the boat? Never decided from which address answered. */
export function resolveWhere(input: WhereInput): WhereResult {
    const { now, phone, boat, sameNetwork = false, previous = null } = input;
    const held = (separationM: number | null, fallback: WhereReason): WhereResult =>
        previous && now - previous.at <= WHERE_HOLD_MS
            ? { where: previous.where, reason: 'held', separationM }
            : { where: 'unknown', reason: fallback, separationM };

    const phoneUsable = usableFix(phone, now) && now - phone.at <= PHONE_FIX_PROOF_MAX_MS;
    if (!phoneUsable || !usableFix(boat, now)) {
        if (sameNetwork) return { where: 'aboard', reason: 'same-network', separationM: null };
        return held(null, phoneUsable ? 'no-boat-fix' : 'no-phone-fix');
    }

    const separationM = metresBetween(phone, boat);
    const phoneAgeS = Math.max(0, now - phone.at) / 1000;
    const boatAgeS = Math.max(0, now - boat.at) / 1000;
    const phoneAcc = accuracyOr(phone.accuracyM, DEFAULT_PHONE_ACC_M);
    const boatAcc = accuracyOr(boat.accuracyM, DEFAULT_BOAT_ACC_M);
    const wasAboard = previous?.where === 'aboard';

    // Clearly apart, after every allowance: the fixes' own error, the boat
    // sailing on since hers, and the phone travelling since its own. A fix
    // held for six hours still proves 900 km.
    const slack = phoneAcc + boatAcc + boatAgeS * BOAT_DRIFT_MPS + phoneAgeS * PHONE_TRAVEL_MPS;
    if (separationM - slack > (wasAboard ? LEAVE_M : ABOARD_M)) {
        return { where: 'ashore', reason: 'apart', separationM };
    }

    // Together needs both fixes current and the phone's a good one.
    const current =
        phoneAgeS * 1000 <= PHONE_FIX_MAX_MS &&
        phoneAcc <= PHONE_ACC_MAX_M &&
        boatAgeS * 1000 <= BOAT_FIX_ABOARD_MAX_MS;
    if (current && separationM <= (wasAboard ? LEAVE_M : ABOARD_M)) {
        return { where: 'aboard', reason: 'together', separationM };
    }

    if (sameNetwork) return { where: 'aboard', reason: 'same-network', separationM };
    return held(separationM, 'too-close-to-call');
}

// ── LINK ─────────────────────────────────────────────────────────────────

/**
 * Which feed is filling the instruments right now. 'shared' is a cloud row a
 * PHONE published (the skipper's phone sharing what it reads, for crew or the
 * skipper's iPad): the boat's readings, but never the boat's position.
 */
export type Lane = 'socket' | 'pi-direct' | 'cloud' | 'shared' | 'none';
/**
 * How it reaches this phone. 'direct' = a boat device answered and nothing
 * here can tell which path carried it (no interface data, place unknown).
 */
export type LinkKind = 'boat-wifi' | 'private-network' | 'cloud' | 'direct' | 'none';
/** Who opened the gateway socket. */
export type SocketOwner = 'skipper' | 'boot' | 'policy' | 'none';
export type SocketStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

export interface NetworkFacts {
    /** Interface data exists (iOS). False on web and on any failure. */
    known: boolean;
    /** This phone's own IPv4 addresses on ordinary (non-tunnel) interfaces. */
    lanAddresses: string[];
    /** Addresses on tunnel interfaces (any VPN). */
    tunnelAddresses: string[];
}

export const UNKNOWN_NETWORK: NetworkFacts = { known: false, lanAddresses: [], tunnelAddresses: [] };

/**
 * 100.64.0.0/10: Tailscale hands these out, and so do NetBird, Cloudflare
 * WARP and carrier-grade NAT. An address here is SOME overlay, not proof of
 * Tailscale (see networkNameFor).
 */
export function isTailnetAddress(ip: string | null | undefined): boolean {
    if (!ip) return false;
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

/** A Tailscale MagicDNS name (*.ts.net): the one host name that proves Tailscale. */
export function isMagicDnsName(host: string | null | undefined): boolean {
    if (!host) return false;
    return host.trim().toLowerCase().replace(/\.$/, '').endsWith('.ts.net');
}

/** An overlay address (100.64/10) or a MagicDNS name: reached through a private network. */
export function isTailnetHost(host: string | null | undefined): boolean {
    if (!host) return false;
    return isTailnetAddress(host.trim()) || isMagicDnsName(host);
}

function isLoopbackOrLinkLocal(ip: string): boolean {
    return ip.startsWith('127.') || ip.startsWith('169.254.');
}

/** The phone's own addresses, from the interface list networkContext reads. */
export function networkFactsFrom(interfaces: readonly NetworkInterfaceInfo[]): NetworkFacts {
    if (interfaces.length === 0) return UNKNOWN_NETWORK;
    return {
        known: true,
        lanAddresses: interfaces
            .filter((i) => !i.tunnel && i.family === 'ipv4' && !isLoopbackOrLinkLocal(i.address))
            .map((i) => i.address),
        tunnelAddresses: interfaces.filter((i) => i.tunnel && i.address).map((i) => i.address),
    };
}

/** Some private network (a VPN) is up on this phone. */
export function tunnelUp(network: NetworkFacts): boolean {
    return network.known && network.tunnelAddresses.length > 0;
}

/** This phone holds an ordinary (non-tunnel) address on the same /24 as `host`. */
export function onSubnetOf(network: NetworkFacts, host: string | null | undefined): boolean {
    if (!network.known || !host) return false;
    return network.lanAddresses.some((address) => sameIpv4Subnet(address, host));
}

/**
 * The phone is on the gateway's own network with no VPN up: the one network
 * fact that may let a silent Pi's fallback socket open when the GPS cannot say
 * where the phone is. A /24 match alone is not enough anywhere else —
 * 192.168.1.0/24 is the world's most common home network.
 */
export function boatWifiEvidence(network: NetworkFacts, gatewayHost: string | null): boolean {
    if (tunnelUp(network)) return false;
    return onSubnetOf(network, gatewayHost);
}

/**
 * The Pi saw this request arrive from one of this phone's own Wi-Fi
 * addresses, on the same /24 as the Pi's own address that took it. Both
 * halves matter. A routed VPN with no address translation — site-to-site
 * WireGuard or IPsec from the boat's router, a router's own VPN, a subnet
 * route with source NAT turned off, a port-forward to a phone with a public
 * address — shows the Pi this phone's real HOME address, so "the Pi saw my
 * address" alone said "Aboard" from the kitchen table. A home network and
 * the boat's cannot share a /24 and still route to each other, so the
 * subnet check is what makes it the boat's network. An older Pi echoes
 * nothing, and proves nothing.
 */
export function echoSameNetwork(network: NetworkFacts, pi: PiPathFacts): boolean {
    if (!network.known || !pi.seenFrom || !pi.seenAt) return false;
    return network.lanAddresses.includes(pi.seenFrom) && sameIpv4Subnet(pi.seenFrom, pi.seenAt);
}

/**
 * This phone is at the boat's LAST KNOWN berth, however old her fix: a
 * current, accurate phone fix within ABOARD_M of where she last reported.
 * Not "aboard" on its own — she may have sailed since — but together with
 * an address on the gateway's own /24 it is the boat, not a home network
 * that happens to use the same numbers.
 */
export function atBoatsLastBerth(params: { now: number; phone: PlaceFix | null; boat: PlaceFix | null }): boolean {
    const { now, phone, boat } = params;
    if (!usableFix(phone, now) || !usableFix(boat, now)) return false;
    if (now - phone.at > PHONE_FIX_MAX_MS) return false;
    if (accuracyOr(phone.accuracyM, DEFAULT_PHONE_ACC_M) > PHONE_ACC_MAX_M) return false;
    return metresBetween(phone, boat) <= ABOARD_M;
}

/**
 * May the policy open the gateway's socket because the Pi has gone quiet?
 * Aboard, yes. Ashore, never: it would take one of the gateway's few client
 * slots from the boat for a phone that is not there. Place unknown, only with
 * proof of the boat's own network: the phone on the gateway's /24 with no
 * VPN up, or the phone on the gateway's /24 AND at her last known berth — the
 * case the fallback exists for (the Pi died days ago, so her fix is old, and
 * the skipper runs a VPN aboard).
 */
export function fallbackSocketPermitted(
    where: Where,
    network: NetworkFacts,
    gatewayHost: string | null,
    atLastBerth = false,
): boolean {
    if (where === 'aboard') return true;
    if (where === 'ashore') return false;
    if (boatWifiEvidence(network, gatewayHost)) return true;
    return atLastBerth && onSubnetOf(network, gatewayHost);
}

export interface StoreFacts {
    status: SocketStatus | 'remote';
    via: 'lan' | 'cloud' | null;
    source: 'pi' | 'device' | null;
    /** The Pi's (or the bus's) reading time for the current feed. */
    readingAt: number | null;
    /** Any instrument reading in the store is inside its usable window. */
    usableReading: boolean;
}

/** The store already ranks the feeds (socket over the Pi direct over the cloud). */
export function resolveLane(store: StoreFacts): Lane {
    if (store.status === 'connected') return 'socket';
    if (store.status !== 'remote') return 'none';
    if (store.source === 'device') return 'shared';
    if (store.source !== 'pi') return 'none';
    return store.via === 'lan' ? 'pi-direct' : 'cloud';
}

export interface PiPathFacts {
    /** Which saved address answered: the boat-network one, or the Pi's own tailnet one. */
    answeredVia: 'lan-host' | 'tailnet-host' | null;
    /** The address the Pi saw this phone's request come from (newer Pis only). */
    seenFrom: string | null;
    /** The Pi's own address that took the request (newer Pis only). */
    seenAt?: string | null;
}

/** How a lane reaches the phone. */
export function resolveKind(params: {
    lane: Lane;
    where: Where;
    network: NetworkFacts;
    pi: PiPathFacts;
    gatewayHost: string | null;
    /** The Pi's own boat-network address, when known (piCache's LAN host). */
    piHost?: string | null;
}): LinkKind {
    const { lane, where, network, pi, gatewayHost, piHost = null } = params;
    if (lane === 'none') return 'none';
    if (lane === 'cloud' || lane === 'shared') return 'cloud';
    const byPlace = (deviceHost: string | null): LinkKind => {
        if (tunnelUp(network)) return where === 'aboard' ? 'boat-wifi' : 'private-network';
        if (where === 'ashore') return 'private-network';
        if (where === 'aboard') return 'boat-wifi';
        // Place unknown and no VPN on this phone: on the device's own /24 it
        // is the boat's network; anywhere else a router-to-router VPN reaches
        // her just the same, so the path is honestly unknown.
        return onSubnetOf(network, deviceHost) ? 'boat-wifi' : 'direct';
    };
    if (lane === 'pi-direct') {
        if (pi.answeredVia === 'tailnet-host') return 'private-network';
        if (pi.seenFrom && pi.seenAt && network.known) {
            return echoSameNetwork(network, pi) ? 'boat-wifi' : 'private-network';
        }
        return byPlace(pi.seenAt ?? piHost);
    }
    // The gateway socket.
    if (isTailnetHost(gatewayHost)) return 'private-network';
    return byPlace(gatewayHost);
}

/**
 * "Tailscale" only when something proves it: the Pi's own tailnet address
 * answered, the gateway is a MagicDNS name, or the paired Pi runs Tailscale
 * itself (its remote-access status gave this phone its tailnet address) and
 * this phone has a tunnel in Tailscale's range. A 100.64/10 tunnel alone is
 * NetBird, Cloudflare WARP or a carrier's NAT as often as Tailscale: "your VPN".
 */
export function networkNameFor(params: {
    network: NetworkFacts;
    pi: PiPathFacts;
    lane: Lane;
    gatewayHost: string | null;
    /** The paired Pi runs Tailscale (piCache learned its tailnet address). */
    piOnTailscale?: boolean;
}): 'Tailscale' | 'your VPN' {
    const { network, pi, lane, gatewayHost, piOnTailscale = false } = params;
    if (lane === 'pi-direct' && pi.answeredVia === 'tailnet-host') return 'Tailscale';
    if (lane === 'socket' && isMagicDnsName(gatewayHost)) return 'Tailscale';
    return piOnTailscale && network.tunnelAddresses.some(isTailnetAddress) ? 'Tailscale' : 'your VPN';
}

/**
 * Aboard, on the boat's Wi-Fi, with a VPN up, and the Pi saw the request
 * arrive from somewhere that is not this phone: traffic to a device a few
 * metres away is going out to the internet and back (lanRoute.ts tells the
 * 2026-08-08 story). Only provable with the Pi's echo, so an older Pi never
 * raises it. "On the boat's Wi-Fi" is a phone address on the Pi's own /24:
 * aboard on cellular alone, the VPN is this phone's only way to the Pi, and
 * telling the skipper to turn it off would cut the link.
 */
export function hairpinProven(
    where: Where,
    network: NetworkFacts,
    pi: PiPathFacts,
    piHost: string | null = null,
): boolean {
    if (where !== 'aboard' || !tunnelUp(network) || !pi.seenFrom) return false;
    if (network.lanAddresses.includes(pi.seenFrom) || network.tunnelAddresses.includes(pi.seenFrom)) return false;
    return onSubnetOf(network, pi.seenAt ?? piHost);
}

/**
 * May this phone's own GPS stand in for the boat's position (Obs's "is the
 * boat on screen")? Aboard by position, yes. And on a boat whose bus carries
 * wind but no GPS — so "aboard" can never be decided — when a direct lane is
 * live and the phone is plainly on the boat's own network: the device's /24
 * with no VPN up (directEvidence). Never from the network alone when the boat
 * HAS a fix: then position decides.
 */
export function phoneMayStandInForBoat(params: {
    where: WhereResult;
    lane: Lane;
    data: DataState;
    directEvidence: boolean;
}): boolean {
    const { where, lane, data, directEvidence } = params;
    if (where.where === 'aboard') return true;
    return (
        where.where === 'unknown' &&
        where.reason === 'no-boat-fix' &&
        (lane === 'socket' || lane === 'pi-direct') &&
        data === 'live' &&
        directEvidence
    );
}

/**
 * The gateway's short name for a sentence ("Connected to the YDWG-02 over
 * Tailscale"): the model, without the maker. A gateway this app has no
 * profile for is just "gateway".
 */
export function gatewayShortName(deviceId: string | null | undefined, label: string | null | undefined): string {
    const byId: Record<string, string> = {
        ydwg02: 'YDWG-02',
        ikonvert: 'iKonvert',
        w2k1: 'W2K-1',
        signalk: 'Signal K server',
        direct: 'NMEA 0183 gateway',
    };
    if (deviceId && byId[deviceId]) return byId[deviceId];
    const text = label ?? '';
    for (const model of ['YDWG-02', 'iKonvert', 'W2K-1']) if (text.includes(model)) return model;
    if (/signal\s*k/i.test(text)) return 'Signal K server';
    return 'gateway';
}

// ── DATA ─────────────────────────────────────────────────────────────────

export type DataState = 'live' | 'stale' | 'quiet' | 'connecting' | 'failed' | 'none';
/** A reading this recent is live, whichever lane carried it. */
export const LIVE_MAX_MS = 30_000;
/** After its lane has gone, the last reading is shown with its age for this long. */
export const STALE_SHOW_MS = 5 * 60_000;

export interface DataResult {
    state: DataState;
    /** Age of the reading behind 'live' / 'stale'. */
    ageMs: number | null;
}

export function resolveData(params: {
    now: number;
    lane: Lane;
    where: Where;
    store: StoreFacts;
    /** `retrying`: the socket is on a reconnect ladder after a failure. */
    socket: { status: SocketStatus; owner: SocketOwner; retrying?: boolean };
    piQuiet: boolean;
    lastReading: { at: number; lane: Lane } | null;
}): DataResult {
    const { now, lane, where, store, socket, piQuiet, lastReading } = params;
    if (lane !== 'none') {
        if (!store.usableReading) return { state: 'quiet', ageMs: null };
        const at = store.readingAt;
        const age = at === null ? null : Math.max(0, now - at);
        if (age === null || age <= LIVE_MAX_MS) return { state: 'live', ageMs: age };
        return { state: 'stale', ageMs: age };
    }
    // A socket the skipper opened, or the boot socket of a boat with no Pi,
    // speaks for itself. Ashore, a boot socket that cannot reach her is no
    // failure: she is simply not reachable from here.
    // A retry after a failure stays "failed" until it succeeds, so the pill
    // does not blink between Connecting and Connection failed on every rung
    // of the reconnect ladder; the page says which attempt it is on.
    const ownSocket = socket.owner === 'skipper' || (socket.owner === 'boot' && where !== 'ashore');
    if (ownSocket && (socket.status === 'error' || (socket.status === 'connecting' && socket.retrying))) {
        return { state: 'failed', ageMs: null };
    }
    if (ownSocket && socket.status === 'connecting') return { state: 'connecting', ageMs: null };
    if (piQuiet) return { state: 'quiet', ageMs: null };
    if (lastReading && now - lastReading.at <= STALE_SHOW_MS) {
        return { state: 'stale', ageMs: Math.max(0, now - lastReading.at) };
    }
    return { state: 'none', ageMs: null };
}

// ── WORDS ────────────────────────────────────────────────────────────────

export type Tone = 'green' | 'sky' | 'amber' | 'grey' | 'red';

/**
 * The header pill: WHERE · DATA, with WHERE left out when unknown. `text` is
 * the whole of it for a reader; a screen may draw `place` and `data` as two
 * chips, so the pair wraps cleanly in a narrow header instead of clipping.
 * `tone` is the pair's one colour (green live aboard, sky live from away).
 */
export interface BoatLinkPillWords {
    text: string;
    tone: Tone;
    place: 'Aboard' | 'Away' | null;
    placeTone: Tone;
    data: string;
    dataTone: Tone;
}

export interface BoatLinkWords {
    pill: BoatLinkPillWords;
    /** One plain sentence: how the boat's data reaches this phone. */
    line: string | null;
    /** Why WHERE is unknown, when the skipper can do something about it. */
    whereNote: string | null;
    /** The System status box's NMEA row: WHERE · source and path · data. */
    statusRow: string;
    /** The Vessel page's NMEA Gateway row: a short value and its subtitle. */
    hub: { value: string; status: string; tone: Tone };
}

export interface WordsInput {
    where: WhereResult;
    /** The lane filling the instruments now (held a moment across a change of route). */
    lane: Lane;
    kind: LinkKind;
    networkName: 'Tailscale' | 'your VPN';
    data: DataResult;
    setup: { piPaired: boolean; gatewaySaved: boolean; gatewayLabel: string };
    socket: { status: SocketStatus; owner: SocketOwner };
    /**
     * With no lane now and the last reading still on screen ('stale'): the
     * lane it came down, and how. Said in the past tense — a closed socket is
     * never "connected".
     */
    last?: { lane: Lane; kind: LinkKind } | null;
}

/** "8 s", "3 min", "2 h". */
export function ageWords(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    return `${Math.floor(s / 3600)} h`;
}

const capitalise = (text: string): string => (text ? text[0].toUpperCase() + text.slice(1) : text);

function placeWord(where: Where): string | null {
    return where === 'aboard' ? 'Aboard' : where === 'ashore' ? 'Away' : null;
}

export function describeBoatLink(input: WordsInput): BoatLinkWords {
    const { where, lane, kind, networkName, data, setup, socket, last = null } = input;
    const place = placeWord(where.where);
    const prefix = place ? `${place} · ` : '';
    const anySetup = setup.piPaired || setup.gatewaySaved;
    const label = setup.gatewayLabel;
    const pi = setup.piPaired ? 'your Pi' : 'the boat’s Pi';
    const age = data.ageMs === null ? null : ageWords(data.ageMs);
    const fallback = socket.owner === 'policy';
    // The lane is gone and its last reading is ageing on screen.
    const gone = lane === 'none' && data.state === 'stale' && last !== null && last.lane !== 'none' ? last : null;

    // ── Pill ──
    const pillOf = (dataText: string, dataTone: Tone, tone: Tone, withPlace: boolean): BoatLinkPillWords => ({
        text: withPlace && place ? `${prefix}${dataText}` : dataText,
        tone,
        place: withPlace ? (place as 'Aboard' | 'Away' | null) : null,
        placeTone: where.where === 'aboard' ? 'green' : 'sky',
        data: dataText,
        dataTone,
    });
    let pill: BoatLinkPillWords;
    switch (data.state) {
        case 'live':
            pill = pillOf('Live', 'green', where.where === 'ashore' ? 'sky' : 'green', true);
            break;
        case 'stale':
            pill = pillOf(`${age ?? 'Some time'} old`, 'amber', 'amber', true);
            break;
        case 'quiet':
            pill = pillOf('Boat quiet', 'grey', 'grey', true);
            break;
        case 'connecting':
            pill = pillOf('Connecting…', 'amber', 'amber', false);
            break;
        case 'failed':
            pill = pillOf('Connection failed', 'red', 'red', false);
            break;
        default:
            pill = anySetup
                ? pillOf('Not connected', 'grey', 'grey', true)
                : pillOf('No gateway', 'grey', 'grey', false);
    }

    // ── Line ──
    const pathWords = (k: LinkKind): string | null =>
        k === 'boat-wifi' ? 'on the boat’s Wi-Fi' : k === 'private-network' ? `over ${networkName}` : null;
    const viaPath = pathWords(kind);
    let line: string | null = null;
    if (lane === 'socket' && fallback) {
        line = `Your Pi hasn’t answered for a minute, so this phone is reading the ${label} directly until it’s back.`;
    } else if (lane === 'none' && fallback && (socket.status === 'connecting' || socket.status === 'error')) {
        line = `Your Pi hasn’t answered for a minute, so this phone is trying the ${label} directly until it’s back.`;
    } else if (lane === 'pi-direct') {
        line = viaPath ? `Reading the boat through ${pi}, ${viaPath}.` : `Reading the boat directly from ${pi}.`;
    } else if (lane === 'cloud') {
        line = `Reading the boat through ${setup.piPaired ? 'your' : 'the'} Pi’s internet updates.`;
    } else if (lane === 'shared') {
        line = 'Reading the boat through the skipper’s phone.';
    } else if (lane === 'socket') {
        line = viaPath ? `Connected to the ${label} ${viaPath}.` : `Connected to the ${label}.`;
    } else if (data.state === 'quiet' && setup.piPaired) {
        line = 'Your Pi answers, but the boat’s instruments are quiet.';
    } else if (setup.piPaired) {
        line = 'Your Pi isn’t answering right now. Its readings show here as soon as it does.';
    } else if (gone) {
        const lastPath = gone.lane === 'socket' ? pathWords(gone.kind) : null;
        const through =
            gone.lane === 'socket'
                ? `the ${label}${lastPath ? ` ${lastPath}` : ''}`
                : gone.lane === 'shared'
                  ? 'the skipper’s phone'
                  : 'the boat’s Pi';
        line = `Last reading came through ${through}, ${age ?? 'some time'} ago.${
            gone.lane === 'socket' ? ' It isn’t connected now.' : ''
        }`;
    } else if (setup.gatewaySaved && data.state !== 'failed' && data.state !== 'connecting') {
        line = `The ${label} answers on the boat’s Wi-Fi, or over a VPN to the boat’s network.`;
    }

    // ── Why the place is unknown ──
    let whereNote: string | null = null;
    if (where.where === 'unknown' && (anySetup || lane !== 'none')) {
        if (where.reason === 'no-phone-fix') {
            whereNote = 'Thalassa needs this phone’s location to tell whether you’re aboard.';
        } else if (where.reason === 'no-boat-fix') {
            whereNote = 'The boat’s GPS isn’t reporting, so Thalassa can’t tell whether you’re aboard.';
        }
    }

    // ── System status row ──
    const pathShort =
        kind === 'boat-wifi' ? 'on the boat’s Wi-Fi' : kind === 'private-network' ? `over ${networkName}` : 'direct';
    let source: string | null = null;
    if (lane === 'pi-direct') source = `Pi ${pathShort}`;
    else if (lane === 'cloud') source = 'Pi through the cloud';
    else if (lane === 'shared') source = 'Skipper’s phone through the cloud';
    else if (lane === 'socket') source = fallback ? `${label} direct, Pi silent` : `${label} ${pathShort}`;
    else if (gone)
        source = setup.piPaired ? 'Pi not answering' : gone.lane === 'socket' ? `${label} not connected` : null;
    const dataWord =
        data.state === 'live'
            ? 'live'
            : data.state === 'stale'
              ? `${age ?? 'some time'} old`
              : data.state === 'quiet'
                ? 'boat quiet'
                : data.state === 'connecting'
                  ? `connecting to the ${label}`
                  : data.state === 'failed'
                    ? `${label} connection failed`
                    : anySetup
                      ? 'not connected'
                      : 'not set up';
    const statusRow = capitalise([place, source, dataWord].filter(Boolean).join(' · '));

    // ── Vessel page row ──
    const hubValue =
        data.state === 'live'
            ? pill.text
            : data.state === 'stale'
              ? `${age ?? 'Some time'} old`
              : data.state === 'quiet'
                ? 'Boat quiet'
                : data.state === 'connecting'
                  ? 'Connecting…'
                  : 'Not connected';
    const hubPath = kind === 'boat-wifi' ? 'boat Wi-Fi' : kind === 'private-network' ? networkName : null;
    const hubStatus =
        lane === 'pi-direct'
            ? `Through the Pi${hubPath ? ` · ${hubPath}` : ''}`
            : lane === 'cloud'
              ? 'Through the Pi · cloud'
              : lane === 'shared'
                ? 'Through the skipper’s phone'
                : lane === 'socket'
                  ? `${label}${fallback ? ' · Pi silent' : hubPath ? ` · ${hubPath}` : ''}`
                  : gone && setup.piPaired
                    ? 'Pi not answering'
                    : gone?.lane === 'socket'
                      ? `${label} · not connected`
                      : 'Instruments & AIS';

    return {
        pill,
        line,
        whereNote,
        statusRow,
        hub: { value: hubValue, status: hubStatus, tone: data.state === 'none' ? 'grey' : pill.tone },
    };
}
