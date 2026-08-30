import { Directory, Filesystem } from '@capacitor/filesystem';

import { createLogger } from '../../utils/createLogger';
import { piCache } from '../PiCacheService';
import { pinnedPiRequest } from '../PiPairingService';

const log = createLogger('S63SetupService');

/**
 * Licensing encrypted charts, from the phone.
 *
 * Two chart worlds identify a boat differently, and knowing which one you are in
 * is most of the job:
 *
 *   o-charts     identity is the SG-Lock dongle. Portable — move it to another
 *                Pi and the charts follow. None of this screen applies.
 *   ChartWorld   identity is a fingerprint of one machine. Moving costs one of
 *                five lifetime InstallPermits, so it is worth knowing before
 *                you spend one.
 *
 * The Pi does the work; this is the door to it.
 */
export interface S63Status {
    toolchainReady: boolean;
    missing: string[];
    dongle: { present: boolean; description: string | null };
    userPermit: string | null;
    installPermit: string | null;
    permitsValid: boolean | null;
    permitProblem: string | null;
}

function piBaseOrThrow(): string {
    if (!piCache.isAvailable()) {
        throw new Error("Pi cache not reachable. Connect to your boat's WiFi and try again.");
    }
    return piCache.baseUrl;
}

function errorFrom(res: { status: number; data: unknown }, fallback: string): string {
    const data = res.data as { error?: string } | string | undefined;
    if (data && typeof data === 'object' && typeof data.error === 'string') return data.error;
    return `${fallback} (HTTP ${res.status})`;
}

function parse<T>(data: unknown): T {
    return (typeof data === 'string' ? JSON.parse(data) : data) as T;
}

export async function fetchS63Status(): Promise<S63Status> {
    const res = await pinnedPiRequest({
        url: `${piBaseOrThrow()}/api/enc/s63/status`,
        connectTimeout: 5000,
        readTimeout: 30000,
        responseType: 'text',
    });
    if (res.status < 200 || res.status >= 300) throw new Error(errorFrom(res, 'Could not read S-63 status'));
    return parse<S63Status>(res.data);
}

/**
 * Generate the fingerprint on the Pi and hand it to the share sheet.
 *
 * It has to reach the o-charts shop in a browser, so getting it off the phone is
 * the whole point: Files, AirDrop to a laptop, or an email to yourself. Sending
 * the bytes through the share sheet is the only step a skipper cannot do from
 * this screen otherwise, short of ssh.
 */
export async function generateAndShareFingerprint(): Promise<string> {
    const res = await pinnedPiRequest({
        url: `${piBaseOrThrow()}/api/enc/s63/fingerprint`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {},
        connectTimeout: 5000,
        readTimeout: 60000,
        responseType: 'text',
    });
    if (res.status < 200 || res.status >= 300) throw new Error(errorFrom(res, 'Could not create a fingerprint'));

    const { filename, base64, bytes } = parse<{ filename: string; base64: string; bytes: number }>(res.data);
    if (!filename || !base64) throw new Error('The Pi did not return a fingerprint file');
    log.info(`[S63] fingerprint ${filename} (${bytes} bytes)`);

    // No `encoding` — Capacitor writes base64 as binary, which is what the shop
    // expects. The accepted .fpr is opaque binary; a text one is refused.
    const written = await Filesystem.writeFile({
        path: filename,
        data: base64,
        directory: Directory.Cache,
    });

    const { Share } = await import('@capacitor/share');
    await Share.share({
        title: filename,
        files: [written.uri],
        dialogTitle: 'Send your fingerprint to o-charts',
    });
    return filename;
}

/**
 * Store the two codes from the shop.
 *
 * The Pi checks them against itself before saving, so a permit issued for
 * different hardware is refused here rather than discovered later when a chart
 * will not build.
 */
export async function saveS63Permits(userPermit: string, installPermit: string): Promise<S63Status> {
    const res = await pinnedPiRequest({
        url: `${piBaseOrThrow()}/api/enc/s63/permits`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: { userPermit: userPermit.trim(), installPermit: installPermit.trim() },
        connectTimeout: 5000,
        readTimeout: 60000,
        responseType: 'text',
    });
    if (res.status < 200 || res.status >= 300) throw new Error(errorFrom(res, 'The Pi rejected those permits'));
    return parse<S63Status>(res.data);
}
