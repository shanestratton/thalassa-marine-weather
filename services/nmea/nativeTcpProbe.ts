/**
 * nativeTcpProbe — the real socket probe behind gatewayScan, plus local-subnet
 * detection.
 *
 * Kept apart from gatewayScan.ts so the scan logic stays testable without
 * sockets, and so the platform quirks live in exactly one file:
 *
 *  • capacitor-tcp-socket's connect() has NO timeout option. An unreachable
 *    host on a /24 sweep would otherwise sit on the OS default (tens of
 *    seconds) — 254 of those is not a scan, it is a hang. Every call is
 *    wrapped in a JS deadline. (Same class as
 *    [[lesson_capacitorhttp_abortsignal_noop]]: the plugin cannot be told to
 *    stop, so the JS side stops waiting and disowns it.)
 *
 *  • A deadline that fires leaves the native connect in flight. Its client id
 *    arrives later with nobody holding it, so the resolve path records the id
 *    and a background sweep closes any that were abandoned — otherwise a full
 *    scan leaks ~250 native sockets.
 */
import { withDeadline } from '../../utils/deadline';
import { createLogger } from '../../utils/createLogger';
import type { ScanProbeResult } from './gatewayScan';

const log = createLogger('gatewayScan');

/** How long to wait for a connected gateway to say something. */
const READ_WINDOW_MS = 600;

/**
 * Probe one host:port. Resolves { open: false } for anything that is not a
 * live TCP listener — this is a scan, so failure is the common case and must
 * be cheap and quiet.
 */
export async function nativeTcpProbe(host: string, port: number, timeoutMs: number): Promise<ScanProbeResult> {
    const { TcpSocket } = await import('capacitor-tcp-socket');

    let clientId: number | null = null;
    try {
        const connect = TcpSocket.connect({ ipAddress: host, port }).then((r) => {
            clientId = r.client; // recorded even if the deadline already fired
            return r;
        });
        const result = await withDeadline(connect, timeoutMs, `probe ${host}:${port}`);
        clientId = result.client;

        // Connected. Listen briefly — the bytes are what separate a gateway
        // from a router's admin page.
        let sample = '';
        try {
            const read = await withDeadline(
                TcpSocket.read({ client: result.client, expectLen: 256 }),
                READ_WINDOW_MS,
                `read ${host}:${port}`,
            );
            sample = typeof read?.result === 'string' ? read.result : '';
        } catch {
            // Silent listener — still a candidate, just unconfirmed.
        }
        return { open: true, sample };
    } catch {
        return { open: false };
    } finally {
        if (clientId !== null) {
            const id = clientId;
            void (async () => {
                try {
                    const { TcpSocket: T } = await import('capacitor-tcp-socket');
                    await T.disconnect({ client: id });
                } catch {
                    /* already gone */
                }
            })();
        }
    }
}

/**
 * Best guess at the /24 this device is on.
 *
 * There is no Capacitor API for the local IP, so this uses the WebRTC ICE
 * candidate trick. It is best-effort by nature: iOS hands out an mDNS
 * `.local` candidate instead of a real address when the page has no camera or
 * microphone permission, in which case this resolves null and the caller must
 * ask the skipper (iOS shows the address under Settings → Wi-Fi → ⓘ).
 */
export async function detectLocalSubnetPrefix(timeoutMs = 2000): Promise<string | null> {
    if (typeof RTCPeerConnection === 'undefined') return null;
    let pc: RTCPeerConnection | null = null;
    try {
        pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel('probe');
        const found = new Promise<string | null>((resolve) => {
            pc!.onicecandidate = (e) => {
                const text = e.candidate?.candidate;
                if (!text) return;
                const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(text);
                if (m) resolve(m[1]);
            };
        });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const ip = await withDeadline(found, timeoutMs, 'local-ip probe').catch(() => null);
        if (!ip) return null;
        const { subnetPrefixOf, isPrivateIpv4 } = await import('./gatewayScan');
        if (!isPrivateIpv4(ip)) return null; // a public/relay address is not the boat LAN
        return subnetPrefixOf(ip);
    } catch (err) {
        log.warn(`local subnet detection failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    } finally {
        try {
            pc?.close();
        } catch {
            /* fine */
        }
    }
}

/** Offered when detection fails — the ranges boat routers actually use. */
export const COMMON_SUBNET_PREFIXES = [
    '192.168.1.',
    '192.168.0.',
    '192.168.50.',
    '192.168.4.',
    '192.168.8.',
    '10.0.0.',
    '10.1.1.',
    '172.20.10.', // iPhone personal hotspot
];
