/** Server-only deterministic producer. No provider/storage/network access. */
import { createHash } from 'node:crypto';
import {
    NOAA_PART_BYTES,
    noaaFeatureBounds,
    parseNoaaPackage,
    parseNoaaPart,
    type NoaaPackage,
    type NoaaPart,
} from '../../services/enc/noaaPackageContract';
import type { EncConversionResult } from '../../services/enc/types';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
export function partitionNoaaRecords(
    source: EncConversionResult,
    zipSha256: string,
    cap = NOAA_PART_BYTES,
): { manifest: NoaaPackage; parts: string[] } {
    if (cap > NOAA_PART_BYTES || cap < 512) throw Error('Invalid NOAA part bound.');
    const { layers, ...metadata } = source;
    const manifest: NoaaPackage = {
        kind: 'noaa-record-package',
        schema: 1,
        metadata,
        zipSha256,
        sourceSha256: hash(JSON.stringify(source)),
        layers: [],
        parts: [],
        bytes: 0,
        features: 0,
    };
    const parts: string[] = [];
    let part: NoaaPart = { kind: 'noaa-record-part', schema: 1, cellId: source.cellId, sequence: 0, records: [] };
    let size = Buffer.byteLength(JSON.stringify(part)),
        bbox: [number, number, number, number] = [180, 90, -180, -90];
    const flush = (): void => {
        if (!part.records.length) return;
        const text = JSON.stringify(part),
            bytes = Buffer.byteLength(text),
            sha256 = hash(text);
        if (bytes > cap) throw Error('A complete NOAA feature exceeds the bounded part format.');
        manifest.parts.push({
            key: `objects/${sha256}.json`,
            sha256,
            bytes,
            sequence: part.sequence,
            bbox,
            spans: part.records.map(({ layer, first, count }) => ({ layer, first, count })),
        });
        manifest.bytes += bytes;
        parts.push(text);
        part = { kind: 'noaa-record-part', schema: 1, cellId: source.cellId, sequence: parts.length, records: [] };
        size = Buffer.byteLength(JSON.stringify(part));
        bbox = [180, 90, -180, -90];
    };
    for (const [layer, fc] of Object.entries(layers)) {
        if (!fc || !Array.isArray(fc.features)) throw Error('Incomplete source layer.');
        const { features, ...collection } = fc;
        manifest.layers.push({ name: layer, count: features.length, collection });
        for (let ordinal = 0; ordinal < features.length; ordinal++) {
            const feature = features[ordinal],
                text = JSON.stringify(feature),
                featureBytes = Buffer.byteLength(text);
            let record = part.records.at(-1);
            const extra =
                record?.layer === layer
                    ? featureBytes + 2
                    : featureBytes +
                      Buffer.byteLength(
                          JSON.stringify({ layer, first: ordinal, count: features.length, features: [] }),
                      ) +
                      3;
            // count/sequence digit growth is reserved, then exact size is checked.
            if (size + extra + 64 > cap) {
                flush();
                record = undefined;
            }
            if (!record || record.layer !== layer) {
                record = { layer, first: ordinal, count: 0, features: [] };
                part.records.push(record);
            }
            record.features.push(feature);
            record.count++;
            manifest.features++;
            size += extra;
            const b = noaaFeatureBounds(feature);
            bbox = [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]), Math.max(bbox[2], b[2]), Math.max(bbox[3], b[3])];
        }
    }
    flush();
    parseNoaaPackage(manifest);
    parts.forEach((text, i) => parseNoaaPart(JSON.parse(text), manifest, manifest.parts[i]));
    return { manifest, parts };
}
