/**
 * networkContext — the shared answer to "can we reach this boat device
 * directly, or is a VPN in the way?"
 *
 * Shared on purpose. The hairpin that broke the NMEA gateway
 * ([[lanRoute]]) will do the same to anything addressed by a boat-LAN IP —
 * AvNav chart tiles, the Pi cache, Signal K. Bolting the check onto the NMEA
 * page alone would leave the next one to be rediscovered from scratch, which
 * is precisely how this cost a day the first time.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { createLogger } from '../../utils/createLogger';
import { assessHairpin, type HairpinAssessment, type NetworkInterfaceInfo } from '../../utils/lanRoute';

const log = createLogger('networkContext');

interface NetworkInterfacesPlugin {
    list(): Promise<{ interfaces: NetworkInterfaceInfo[]; vpnActive: boolean }>;
}

const Native = registerPlugin<NetworkInterfacesPlugin>('NetworkInterfaces');

/** Interfaces change on Wi-Fi joins and VPN toggles, not by the second. */
const CACHE_MS = 15_000;

let cached: { at: number; interfaces: NetworkInterfaceInfo[] } | null = null;
let inFlight: Promise<NetworkInterfaceInfo[]> | null = null;

/**
 * Current network interfaces. Empty on web and on any failure — every caller
 * treats "we don't know" as "don't warn", because a false hairpin warning
 * teaches the skipper to ignore the banner that will one day be right.
 */
export async function getInterfaces(force = false): Promise<NetworkInterfaceInfo[]> {
    if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.interfaces;
    if (inFlight) return inFlight;
    if (Capacitor.getPlatform() !== 'ios') return [];

    inFlight = (async () => {
        try {
            const result = await Native.list();
            const interfaces = Array.isArray(result?.interfaces) ? result.interfaces : [];
            cached = { at: Date.now(), interfaces };
            return interfaces;
        } catch (err) {
            log.warn('interface probe failed; assuming nothing', err);
            return [];
        } finally {
            inFlight = null;
        }
    })();
    return inFlight;
}

/**
 * Would reaching `hostIp` be hairpinned through a VPN right now?
 *
 * `hostLabel` is what the warning calls the device — "the NMEA gateway", "the
 * Pi cache" — so the message names the thing the skipper is actually trying
 * to use.
 */
export async function assessHostRoute(hostIp: string | null, hostLabel?: string): Promise<HairpinAssessment> {
    const interfaces = await getInterfaces();
    return assessHairpin({ interfaces, hostIp, hostLabel });
}

/** Test seam. */
export function __resetNetworkContextForTests(): void {
    cached = null;
    inFlight = null;
}
