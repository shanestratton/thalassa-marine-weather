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
            // `timeout` is SECONDS and defaults to 10 in the plugin. Without
            // it, every open-but-quiet port blocks the plugin's serial native
            // bridge for ten seconds — the JS deadline below only stops US
            // waiting, it cannot cancel the native read — and a sweep across a
            // subnet of silent devices would queue behind them. 1 s is the
            // floor the API allows and still comfortably longer than the
            // 600 ms window we actually wait.
            const read = await withDeadline(
                TcpSocket.read({ client: result.client, expectLen: 256, timeout: 1 }),
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
 * The /24 this device is on, via WebRTC only. Best-effort by nature: iOS hands
 * out an mDNS `.local` candidate instead of a real address, so this often
 * resolves null — see detectSubnetPrefix for the fallback that does not.
 */
async function detectViaWebRtc(timeoutMs = 2000): Promise<string | null> {
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

/**
 * Work out the boat's subnet WITHOUT asking the skipper.
 *
 *   1. WebRTC, if iOS happens to hand over a real address (instant when it works);
 *   2. otherwise find the ROUTER — .1/.254 across the common private ranges.
 *
 * Shane, on being offered a text box: "no way Claude, I know you can find that
 * and enter it in." He was right. A router sits at .1 on essentially every
 * network a boat ever joins, so a couple of dozen probes settles it in about a
 * second. The manual field stays as a last resort, not the first ask.
 */
export async function detectSubnetPrefix(
    opts: { shouldStop?: () => boolean } = {},
): Promise<{ prefix: string; via: 'webrtc' | 'router' } | null> {
    const viaWebRtc = await detectViaWebRtc().catch(() => null);
    if (viaWebRtc) return { prefix: viaWebRtc, via: 'webrtc' };

    const { detectSubnetByRouterProbe } = await import('./gatewayScan');
    const prefix = await detectSubnetByRouterProbe(nativeTcpProbe, { shouldStop: opts.shouldStop });
    return prefix ? { prefix, via: 'router' } : null;
}
