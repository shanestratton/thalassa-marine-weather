import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { currentRegionBounds, type CurrentRegionalManifest } from '../../services/weather/api/currentRegionalContract';

/** Deterministic synthetic Ed25519 seed for generated fixtures only; never a release signing key. */
const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]),
    format: 'der',
    type: 'pkcs8',
});
export const fixturePublicKey = new Uint8Array(
    createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32),
);
export const fixtureKeyId = 'generated-fixture';
export function signedCurrentManifest(payload: unknown): Uint8Array {
    const bytes = Buffer.from(JSON.stringify(payload));
    return new Uint8Array(
        new TextEncoder().encode(
            JSON.stringify({
                algorithm: 'Ed25519',
                keyId: fixtureKeyId,
                payload: bytes.toString('base64url'),
                signature: sign(null, bytes, privateKey).toString('base64url'),
            }),
        ),
    );
}

export function currentRegionalFixture(regionId: string, nowMs: number, steps = 2, width = 2) {
    const generation = 'g-' + 'a'.repeat(24);
    const bounds = currentRegionBounds(regionId)!;
    const header = {
        schema: 1,
        model: 'CMEMS',
        dataset: 'generated-public-current',
        generation,
        sourceSha256: 'b'.repeat(64),
        runMs: nowMs,
        expiresMs: nowMs + 120 * 3_600_000,
        units: 'm/s',
        vectorBasis: 'true-east-north',
        depthM: 0,
        crs: 'EPSG:4326',
        layout: 'north-south-west-east',
        tile: {
            id: regionId,
            ...bounds,
            width,
            height: width,
            ocean: { cadenceHours: 1, times: Array.from({ length: steps }, (_, i) => nowMs + i * 3_600_000) },
        },
    };
    const metadata = new TextEncoder().encode(JSON.stringify(header));
    const bytes = new Uint8Array(12 + metadata.byteLength + width * width * steps * 9);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x53434854, true);
    view.setUint16(4, 1, true);
    view.setUint32(8, metadata.byteLength, true);
    bytes.set(metadata, 12);
    let offset = 12 + metadata.byteLength;
    for (let step = 0; step < steps; step++) {
        for (const value of [steps === 2 ? step + 1 : 1 + step / 121, 0]) {
            for (let i = 0; i < width * width; i++) view.setFloat32(offset + i * 4, value, true);
            offset += width * width * 4;
        }
        bytes.fill(1, offset, offset + width * width);
        offset += width * width;
    }
    const manifest: CurrentRegionalManifest = {
        schema: 1,
        regionId,
        generation,
        issuedMs: nowMs,
        expiresMs: header.expiresMs,
        models: {
            CMEMS: {
                filename: `${generation}-cmems-${regionId}.thcs`,
                bytes: bytes.byteLength,
                sha256: '0'.repeat(64),
            },
        },
    };
    return { bytes, manifest, header };
}
