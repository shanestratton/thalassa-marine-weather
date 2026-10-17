import { gzipSync } from 'node:zlib';
import { AROME_DOMAINS } from '../../services/weather/aromeDomains';
import {
    AROME_BINARY_MAGIC,
    AROME_STATIC_FIELDS,
    AROME_STATIC_UNITS,
    AROME_STATIC_ORIGIN,
    aromeSha256,
    aromeTileShape,
    type AromeSlot,
    type AromeStaticManifest,
} from '../../services/weather/aromeStaticContract';
import { AROME_TEST_MODEL as model, AROME_TEST_POINT as point } from './arome142';

/** Fictional storage response only. Never a native Météo-France proof. */
export async function aromeStaticFixture(
    options: {
        mask?: (i: number, j: number) => number;
        sample?: (field: number, hour: number, i: number, j: number) => number;
    } = {},
) {
    const domain = AROME_DOMAINS[0];
    const nx = Math.ceil(domain.width / 32);
    const ny = Math.ceil(domain.height / 32);
    const target = aromeTileShape(model, Math.floor(400 / 32), Math.floor(400 / 32))!;
    const cells = target.width * target.height;
    const manifest: AromeStaticManifest = {
        schema: 1,
        model,
        runUtc: '2026-10-17T00:00:00Z',
        provider: 'Météo-France',
        product: 'AROME-OM',
        licence: 'Etalab-2.0',
        width: domain.width,
        height: domain.height,
        bounds: domain.region,
        stepDegrees: 0.025,
        hours: 49,
        fields: AROME_STATIC_FIELDS,
        units: AROME_STATIC_UNITS,
        encoding: 'gzip-f64le-v1',
        core: 32,
        halo: 3,
        maskSha256: 'b'.repeat(64),
        nativeProofSha256: 'c'.repeat(64),
        catalogueSha256: 'd'.repeat(64),
        packets: Array.from({ length: 49 }, (_, offsetHours) => ({ offsetHours, sha256: 'e'.repeat(64), bytes: 100 })),
        tiles: Array.from({ length: nx * ny }, (_, index) => ({
            ...aromeTileShape(model, index % nx, Math.floor(index / nx))!,
            sha256: 'f'.repeat(64),
            rawSha256: 'a'.repeat(64),
            bytes: 100,
            rawBytes:
                512 +
                aromeTileShape(model, index % nx, Math.floor(index / nx))!.width *
                    aromeTileShape(model, index % nx, Math.floor(index / nx))!.height *
                    246 *
                    8,
        })),
    };
    const header = new TextEncoder().encode(
        JSON.stringify({
            schema: 1,
            model,
            runUtc: manifest.runUtc,
            maskSha256: manifest.maskSha256,
            nativeProofSha256: manifest.nativeProofSha256,
            ...target,
            hours: 49,
            fields: AROME_STATIC_FIELDS,
            units: AROME_STATIC_UNITS,
        }),
    );
    const raw = new Uint8Array(12 + header.length + cells * (1 + 49 * 5) * 8);
    raw.set(new TextEncoder().encode(AROME_BINARY_MAGIC));
    const view = new DataView(raw.buffer);
    view.setUint32(8, header.length, true);
    raw.set(header, 12);
    const start = 12 + header.length;
    for (let index = 0; index < cells; index++) {
        const i = target.i0 + (index % target.width);
        const j = target.j0 + Math.floor(index / target.width);
        view.setFloat64(start + index * 8, options.mask?.(i, j) ?? (i === 400 && j === 400 ? 0 : 1), true);
        for (let field = 0; field < 5; field++)
            for (let hour = 0; hour < 49; hour++) {
                const fallback = [-5.144444444444445, 0, 101234.567891, 290.123456789, 72.3456789][field];
                view.setFloat64(
                    start + (cells + (field * 49 + hour) * cells + index) * 8,
                    options.sample?.(field, hour, i, j) ?? fallback,
                    true,
                );
            }
    }
    const packed = Uint8Array.from(gzipSync(raw));
    const tile = manifest.tiles.find((entry) => entry.id === target.id)!;
    Object.assign(tile, {
        sha256: await aromeSha256(packed),
        rawSha256: await aromeSha256(raw),
        bytes: packed.length,
        rawBytes: raw.length,
    });
    const manifestRaw = new TextEncoder().encode(JSON.stringify(manifest));
    const slot: AromeSlot = {
        schema: 1,
        model,
        runUtc: manifest.runUtc,
        manifestBytes: manifestRaw.length,
        manifestSha256: await aromeSha256(manifestRaw),
    };
    const objects = new Map<string, Uint8Array>([
        [`${AROME_STATIC_ORIGIN}/${model}/current-0.json`, new TextEncoder().encode(JSON.stringify(slot))],
        [`${AROME_STATIC_ORIGIN}/${model}/cohorts/${slot.manifestSha256}/manifest.json`, manifestRaw],
        [`${AROME_STATIC_ORIGIN}/${model}/tiles/${tile.sha256}.bin.gz`, packed],
    ]);
    return { manifest, manifestRaw, slot, tile, raw, packed, objects, point, model };
}
