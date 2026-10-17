/** Original dated observations, fetched only while an owned Obs layer needs them. No durable cache. */
import { FORECAST_ASSETS_URL } from './forecastAssetsEndpoint';
import type { ScalarGrid } from '../scalarGridImage';
import { decodeUtf8Json, fetchBoundedPublisherBytes, verifyPublisherAsset } from './cmemsGridTrust';
import {
    parseSshManifest,
    SSH_BOUNDS,
    SSH_CELLS,
    SSH_FILE_BYTES,
    SSH_HEIGHT,
    SSH_WIDTH,
    type SshManifest,
} from './sshManifestContract';

export interface SshObservation {
    readonly generation: string;
    readonly sourceTimeMs: number;
    readonly validUntilMs: number;
    readonly adt: ScalarGrid;
    readonly sla: ScalarGrid;
    readonly eastward: ScalarGrid;
    readonly northward: ScalarGrid;
}
export function decodeSshObservation(bytes: Uint8Array, manifest: SshManifest): SshObservation {
    if (bytes.byteLength !== SSH_FILE_BYTES) throw new Error('SSH exact binary length');
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
        data.getUint32(0, true) !== 0x53534854 ||
        data.getUint8(4) !== 1 ||
        data.getUint8(5) !== 4 ||
        data.getUint8(6) !== 0 ||
        data.getUint8(7) !== 0 ||
        data.getUint16(8, true) !== SSH_WIDTH ||
        data.getUint16(10, true) !== SSH_HEIGHT
    ) {
        throw new Error('SSH protocol identity');
    }
    for (const [i, expected] of Object.values(SSH_BOUNDS).entries())
        if (data.getFloat64(12 + i * 8, true) !== expected) throw new Error('SSH grid bounds');
    if (data.getBigInt64(44, true) !== BigInt(manifest.sourceTimeMs))
        throw new Error('SSH original date differs from manifest');
    for (let i = 52; i < 64; i++) if (data.getUint8(i) !== 0) throw new Error('SSH reserved header');
    const mask = bytes.slice(64 + SSH_CELLS * 16);
    let wet = 0;
    for (const valid of mask) {
        if (valid !== 0 && valid !== 1) throw new Error('SSH unknown mask');
        wet += valid;
    }
    if (wet < SSH_CELLS / 10 || wet > SSH_CELLS * 0.9) throw new Error('SSH global wet coverage');
    const grids = [5, 3, 5, 5].map((limit, channel): ScalarGrid => {
        const values = new Float32Array(SSH_CELLS);
        for (let i = 0; i < SSH_CELLS; i++) {
            const value = data.getFloat32(64 + (channel * SSH_CELLS + i) * 4, true);
            if (!Number.isFinite(value) || Math.abs(value) > limit || (mask[i] === 0 && value !== 0))
                throw new Error('SSH masked/nonphysical channel');
            values[i] = value;
        }
        return {
            width: SSH_WIDTH,
            height: SSH_HEIGHT,
            west: SSH_BOUNDS.west,
            south: SSH_BOUNDS.south,
            dx: 0.5,
            dy: 0.5,
            values,
            validMask: mask,
            wrapLongitude: true,
        };
    });
    return {
        generation: manifest.generation,
        sourceTimeMs: manifest.sourceTimeMs,
        validUntilMs: manifest.validUntilMs,
        adt: grids[0],
        sla: grids[1],
        eastward: grids[2],
        northward: grids[3],
    };
}
/** Caller owns cancellation and must recheck its map/source lease after this resolves. */
export async function fetchSshObservation(signal: AbortSignal): Promise<SshObservation> {
    signal.throwIfAborted();
    const manifestBytes = await fetchBoundedPublisherBytes(
        `${FORECAST_ASSETS_URL}/ssh/manifest-v2.json`,
        32 * 1024,
        'application/json',
        signal,
    );
    signal.throwIfAborted();
    const manifest = parseSshManifest(decodeUtf8Json(manifestBytes));
    const bytes = await fetchBoundedPublisherBytes(
        `${FORECAST_ASSETS_URL}/ssh/${manifest.filename}`,
        SSH_FILE_BYTES,
        'application/octet-stream',
        signal,
        'force-cache',
    );
    signal.throwIfAborted();
    await verifyPublisherAsset(bytes, SSH_FILE_BYTES, manifest.sha256, 'daily SSH');
    signal.throwIfAborted();
    // Currentness is checked again after I/O, without changing the source date.
    parseSshManifest(decodeUtf8Json(manifestBytes));
    return decodeSshObservation(bytes, manifest);
}
