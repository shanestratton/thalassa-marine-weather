/** Manual read-only evidence. No activation flags, credentials, publication or provider cache. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { decode } from 'fast-png';
import {
    SATELLITE_VIEW_PRODUCTS,
    SATELLITE_IMAGE_MAX,
    SATELLITE_METADATA_MAX,
    satelliteMetadataUrl,
    satelliteImageTarget,
    parseSatelliteTimes,
    validateSatelliteViewTimes,
    satelliteViewCredit,
} from '../services/weather/satelliteViewContract.ts';
import {
    readSatelliteResponse,
    validateSatellitePng,
    satelliteViewportAlphaFraction,
} from '../services/weather/satelliteViewBytes.ts';

export const SATELLITE_SOURCE_PROOF_LIMITS = Object.freeze({
    products: 6,
    framesPerProduct: 2,
    edge: 256,
    requests: 30,
    imageBytes: SATELLITE_IMAGE_MAX,
    metadataBytes: SATELLITE_METADATA_MAX,
    consumedBytes: 32 * 1024 * 1024,
    directoryBytes: 32 * 1024 * 1024,
    seconds: 600,
    readSeconds: 25,
});
/** Small fixed windows within the intended disks/swaths; none assert worldwide coverage. */
export const SATELLITE_SOURCE_PROOF_BOXES = Object.freeze({
    'himawari-ir': Object.freeze([140, -35, 160, -15]),
    'goes-east-ir': Object.freeze([-85, 10, -65, 30]),
    'goes-west-ir': Object.freeze([-160, 10, -140, 30]),
    'meteosat-ir': Object.freeze([-10, -10, 10, 10]),
    'viirs-night': Object.freeze([0, 65, 30, 80]),
    'water-vapour': Object.freeze([-85, 10, -65, 30]),
});
export const OLDER_GIBS_SOURCE_PROOF_PRODUCTS = Object.freeze(['himawari-ir', 'goes-west-ir', 'goes-east-ir']);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failure = (error) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/** Bound IDAT inflation before the existing CRC-checking decoder, excluding compressed ancillary data. */
export function inspectSatelliteProofPng(input) {
    const bytes = Buffer.from(input);
    const edge = SATELLITE_SOURCE_PROOF_LIMITS.edge;
    validateSatellitePng(bytes, edge, edge);
    const colour = bytes[25],
        channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
    if (bytes[24] !== 8 || !channels || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0)
        throw Error('Proof decoder holds unsupported PNG depth/compression/interlace');
    const critical = [bytes.subarray(0, 8)],
        compressed = [],
        text = [];
    let at = 8,
        chunks = 0,
        ended = false;
    const unique = new Set();
    while (at < bytes.length) {
        if (++chunks > 4096 || at + 12 > bytes.length) throw Error('Proof PNG chunk bound');
        const length = bytes.readUInt32BE(at),
            end = at + 12 + length,
            name = bytes.toString('ascii', at + 4, at + 8);
        if (end > bytes.length || !/^[A-Za-z]{4}$/.test(name)) throw Error('Proof PNG chunk invalid');
        if (['IHDR', 'PLTE', 'tRNS', 'IEND'].includes(name)) {
            if (unique.has(name)) throw Error('Proof PNG duplicate critical data');
            unique.add(name);
        }
        if (name === 'IHDR' && (at !== 8 || length !== 13)) throw Error('Proof PNG original header invalid');
        if ((name === 'PLTE' && length > 768) || (name === 'tRNS' && length > 256))
            throw Error('Proof PNG palette bound');
        if (compressed.length && ['PLTE', 'tRNS'].includes(name)) throw Error('Proof PNG palette order invalid');
        if (['acTL', 'fcTL', 'fdAT'].includes(name)) throw Error('Animated PNG is outside this proof');
        if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(name)) critical.push(bytes.subarray(at, end));
        else if (name[0] === name[0].toUpperCase()) throw Error('Unknown critical PNG chunk');
        if (name === 'IDAT') compressed.push(bytes.subarray(at + 8, end - 4));
        // Informational only: uncompressed text is not an independent image-clock proof.
        if (name === 'tEXt' && length <= 2048 && text.length < 8) text.push(bytes.toString('utf8', at + 8, end - 4));
        at = end;
        if (name === 'IEND') {
            if (length !== 0 || at !== bytes.length) throw Error('Proof PNG trailing data');
            ended = true;
            break;
        }
    }
    if (!ended || !compressed.length) throw Error('Proof PNG incomplete');
    const expected = (edge * channels + 1) * edge;
    const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
    if (raw.length !== expected) throw Error('Proof PNG inflated dimensions differ');
    const image = decode(Buffer.concat(critical), { checkCrc: true });
    if (image.width !== edge || image.height !== edge || image.data.length !== edge * edge * channels)
        throw Error('Proof PNG decoded dimensions differ');
    let visible = 0;
    const colours = new Set();
    const rgba = new Uint8ClampedArray(edge * edge * 4);
    for (let index = 0; index < edge * edge; index++) {
        const offset = index * channels,
            values = Array.from(image.data.subarray(offset, offset + channels));
        let alpha = channels === 2 || channels === 4 ? values.at(-1) : 255;
        let rgb;
        if (image.palette) {
            const entry = image.palette[values[0]];
            if (!entry) throw Error('Proof PNG palette index invalid');
            alpha = entry[3] ?? 255;
            rgb = entry;
        } else if (image.transparency?.length && image.transparency.every((value, i) => value === values[i])) alpha = 0;
        const pixel = index * 4;
        rgba[pixel] = rgb?.[0] ?? values[0];
        rgba[pixel + 1] = rgb?.[1] ?? (colour === 0 || colour === 4 ? values[0] : values[1]);
        rgba[pixel + 2] = rgb?.[2] ?? (colour === 0 || colour === 4 ? values[0] : values[2]);
        rgba[pixel + 3] = alpha;
        if (alpha > 0) {
            visible++;
            if (colours.size < 512) colours.add(values.join(','));
        }
    }
    let clientDetailStatus = 'held',
        clientDetailAlphaFraction = null,
        clientDetailError = null;
    try {
        clientDetailAlphaFraction = satelliteViewportAlphaFraction(rgba);
        clientDetailStatus = 'usable';
    } catch (error) {
        clientDetailError = failure(error);
    }
    return {
        width: edge,
        height: edge,
        depth: image.depth,
        channels,
        crcCheckedCriticalChunks: true,
        decodedVisiblePixels: visible,
        totalPixels: edge * edge,
        visibleFraction: visible / (edge * edge),
        distinctVisibleEncodedValuesCapped512: colours.size,
        uncompressedText: text,
        independentAcquisitionClock: 'unknown',
        ancillaryChunksNotDecoded: true,
        clientDetailStatus,
        clientDetailAlphaFraction,
        clientDetailError,
    };
}

/** Count even failing streamed bodies; the normal byte reader still enforces each original MIME/size cap. */
export function satelliteProofFetch(nativeFetch, controller, record, limits = SATELLITE_SOURCE_PROOF_LIMITS) {
    let requests = 0,
        consumed = 0,
        expectedUrl = null;
    return {
        expect: (url) => {
            expectedUrl = url;
        },
        totals: () => ({ requests, consumedBytes: consumed }),
        fetch: async (input, init) => {
            controller.signal.throwIfAborted();
            const url = typeof input === 'string' ? input : String(input);
            if (
                !expectedUrl ||
                url !== expectedUrl ||
                init?.redirect !== 'error' ||
                init?.credentials !== 'omit' ||
                init?.cache !== 'no-store'
            )
                throw Error('Unexpected proof request');
            expectedUrl = null;
            if (++requests > limits.requests) throw Error('Proof request quota exceeded');
            const response = await nativeFetch(input, init);
            record({ url, status: response.status, headers: Object.fromEntries(response.headers) });
            const reader = response.body?.getReader();
            if (!reader) return response;
            return new Response(
                new globalThis.ReadableStream({
                    async pull(stream) {
                        try {
                            const result = await reader.read();
                            if (result.done) return stream.close();
                            consumed += result.value.byteLength;
                            if (consumed > limits.consumedBytes) {
                                controller.abort(Error('Proof aggregate byte quota exceeded'));
                                void reader.cancel().catch(() => undefined);
                                throw Error('Proof aggregate byte quota exceeded');
                            }
                            stream.enqueue(result.value);
                        } catch (error) {
                            stream.error(error);
                        }
                    },
                    cancel: (reason) => reader.cancel(reason),
                }),
                { status: response.status, statusText: response.statusText, headers: response.headers },
            );
        },
    };
}

export async function runSatelliteSourceProof({
    allowSourceReads,
    save,
    signal,
    read = readSatelliteResponse,
    mode = 'recent',
}) {
    if (allowSourceReads !== true) throw Error('Source reads require explicit reviewed admission');
    if (!['recent', 'older-gibs'].includes(mode)) throw Error('Unknown source proof mode');
    const selectedProducts =
        mode === 'older-gibs' ? OLDER_GIBS_SOURCE_PROOF_PRODUCTS : Object.keys(SATELLITE_SOURCE_PROOF_BOXES);
    const maxRequests = mode === 'older-gibs' ? 15 : SATELLITE_SOURCE_PROOF_LIMITS.requests;
    const products = [];
    let readNumber = 0;
    const readOne = async (url, mime, max, filename) => {
        signal.throwIfAborted();
        if (++readNumber > maxRequests) throw Error('Proof request quota exceeded');
        const bounded = globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(25_000)]);
        const { response, bytes } = await read(url, mime, max, bounded);
        signal.throwIfAborted();
        await save(filename, bytes);
        return {
            bytes,
            response,
            receipt: {
                file: filename,
                url,
                bytes: bytes.byteLength,
                sha256: sha256(bytes),
                readAt: new Date().toISOString(),
            },
        };
    };
    for (const product of selectedProducts) {
        const result = {
            product,
            box: SATELLITE_SOURCE_PROOF_BOXES[product],
            source: SATELLITE_VIEW_PRODUCTS[product],
            metadata: [],
            frames: [],
            status: 'held',
            selectionMode:
                mode === 'older-gibs'
                    ? 'two-oldest-current-last-six-excluding-newest-two'
                    : 'two-newest-current-listed',
        };
        products.push(result);
        let metadataIndex = 0;
        const metadata = async () => {
            const now = Date.now(),
                url = satelliteMetadataUrl(product, now),
                read = await readOne(url, 'xml', SATELLITE_METADATA_MAX, `${product}-metadata-${metadataIndex++}.xml`);
            const times = validateSatelliteViewTimes(
                parseSatelliteTimes(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes), product, now),
                product,
                Date.now(),
            );
            result.metadata.push({ ...read.receipt, advertised: times.frames });
            return times;
        };
        try {
            let current = await metadata();
            const selected = mode === 'older-gibs' ? current.frames.slice(0, -2).slice(0, 2) : current.frames.slice(-2);
            if (!selected.length)
                throw Error('No older advertised frame remains under the original currentness bounds');
            for (const frame of selected) {
                const item = {
                    listedTime: frame.iso,
                    listedTimeMs: frame.timeMs,
                    dailyComposite: frame.daily,
                    credit: satelliteViewCredit(product, frame.timeMs),
                    independentAcquisitionClock: 'unknown',
                    status: 'held',
                };
                result.frames.push(item);
                try {
                    signal.throwIfAborted();
                    const now = Date.now();
                    if (now - current.readAtMs > 120000 || !current.frames.some((value) => value.iso === frame.iso))
                        throw Error('Selected frame no longer in the current original metadata');
                    const target = satelliteImageTarget(product, frame, result.box, 256, 256);
                    const image = await readOne(
                        target,
                        'image/png',
                        SATELLITE_IMAGE_MAX,
                        `${product}-${item.listedTime.replace(/[:]/g, '')}.png`,
                    );
                    item.image = image.receipt;
                    item.png = inspectSatelliteProofPng(image.bytes);
                    // Actual image availability cannot be inferred from old metadata alone.
                    current = await metadata();
                    if (!current.frames.some((value) => value.iso === frame.iso))
                        throw Error('Original frame disappeared after image read');
                    if (!item.png.decodedVisiblePixels)
                        throw Error('Image has no visible source pixels in this window');
                    item.status = 'observed-valid-png';
                } catch (error) {
                    item.error = failure(error);
                }
            }
            result.observedFrames = result.frames.filter((frame) => frame.status === 'observed-valid-png').length;
            result.clientUsableFrames = result.frames.filter(
                (frame) => frame.status === 'observed-valid-png' && frame.png.clientDetailStatus === 'usable',
            ).length;
            if (result.observedFrames > 0) result.status = 'observed-valid-png';
            result.twoAdvertisedImageHashesDiffer =
                result.observedFrames === 2 && result.frames[0].image.sha256 !== result.frames[1].image.sha256;
        } catch (error) {
            result.error = failure(error);
        }
    }
    return {
        products,
        mode,
        completeSixProductObservation:
            mode === 'recent' ? products.every((product) => product.status === 'observed-valid-png') : null,
        completeSelectedProductsWithUsableDetail: products.every((product) => product.clientUsableFrames > 0),
        claims: [
            'Read-only fixed-provider small-window evidence; at most two originally advertised images per product',
            'Original metadata plus strict image MIME/byte/dimension/critical CRC/bounded decode and post-read membership checks',
            'Visible PNG pixels and differing bytes do not prove independent acquisition clocks or physical clear sky',
            'No feature flags, publication, deployment, provider credentials, durable app cache or schedules changed',
        ],
        unknown: [
            'Independent image acquisition clock, nearest-value response identity and scan timing',
            'World coverage and availability outside the selected small windows and this read time',
            'No source palette is decoded as physical weather, fog or visibility',
        ],
    };
}

const SOURCE_INPUTS = [
    'scripts/prove-sharper-satellite-source.mjs',
    '.github/workflows/sharper-satellite-source-proof.yml',
    'services/weather/satelliteViewContract.ts',
    'services/weather/satelliteViewBytes.ts',
    'services/weather/api/cmemsGridTrust.ts',
    'services/weather/api/marineManifestContract.ts',
    'services/native/apiBase.ts',
    'utils/createLogger.ts',
    'api/satellite-view.ts',
    'tests/SatelliteSourceProof141.test.ts',
    'docs/build141/sharper-satellite-source-proof.md',
    '.github/workflows/sharper-satellite-older-gibs-proof.yml',
    'docs/build141/sharper-satellite-older-gibs-proof.md',
    'tests/fixtures/satellite141/first-observation-transparent.png',
    'tests/fixtures/satellite141/first-observation-opaque-uniform.png',
    'package.json',
    'package-lock.json',
];
async function main() {
    // The default path cannot perform even a metadata request or create an evidence directory.
    const mode =
        process.argv[2] === '--read-reviewed-sources'
            ? 'recent'
            : process.argv[2] === '--read-reviewed-older-gibs'
              ? 'older-gibs'
              : null;
    if (!mode || process.argv.length !== 4)
        throw Error(
            'Usage after review only: node --import tsx scripts/prove-sharper-satellite-source.mjs [--read-reviewed-sources|--read-reviewed-older-gibs] NEW_OUTPUT_DIR',
        );
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (!/^[a-f0-9]{40}$/.test(process.env.SOURCE_SHA ?? '') || sourceSha !== process.env.SOURCE_SHA)
        throw Error('Exact reviewed source SHA required');
    const output = path.resolve(process.argv[3]);
    // Exclusive new directory: no stale success files, recursive removal, writes through existing symlinks or overwrites.
    await mkdir(output);
    let directoryBytes = 0;
    const save = async (filename, value) => {
        const bytes = typeof value === 'string' ? Buffer.from(value) : value;
        if (!/^[A-Za-z0-9_.-]{1,160}$/.test(filename)) throw Error('Proof filename refused');
        const next = directoryBytes + bytes.byteLength;
        const receipt = ['source-proof.json', 'failure.json', 'process-exit.txt'].includes(filename);
        const cap = SATELLITE_SOURCE_PROOF_LIMITS.directoryBytes - (receipt ? 0 : 512 * 1024);
        if (next > cap) throw Error('Proof directory quota exceeded');
        directoryBytes = next;
        await writeFile(path.join(output, filename), bytes, { flag: 'wx' });
    };
    const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(Error('Proof overall deadline')), 600000),
        nativeFetch = globalThis.fetch,
        requests = [],
        limits =
            mode === 'older-gibs'
                ? { ...SATELLITE_SOURCE_PROOF_LIMITS, products: 3, requests: 15 }
                : SATELLITE_SOURCE_PROOF_LIMITS,
        budget = satelliteProofFetch(nativeFetch, controller, (record) => requests.push(record), limits);
    globalThis.fetch = budget.fetch;
    const read = (url, mime, max, signal) => {
        budget.expect(url);
        return readSatelliteResponse(url, mime, max, signal);
    };
    let exitCode = 1;
    try {
        const inputs = [];
        for (const filename of SOURCE_INPUTS) {
            const bytes = await readFile(filename),
                gitBytes = execFileSync('git', ['show', `${sourceSha}:${filename}`], { maxBuffer: 8 * 1024 * 1024 });
            if (!bytes.equals(gitBytes)) throw Error(`Dirty proof input: ${filename}`);
            inputs.push({ path: filename, bytes: bytes.byteLength, sha256: sha256(bytes) });
        }
        const startedAt = new Date().toISOString();
        const result = await runSatelliteSourceProof({
            allowSourceReads: true,
            signal: controller.signal,
            save,
            read,
            mode,
        });
        exitCode = (
            mode === 'older-gibs'
                ? result.completeSelectedProductsWithUsableDetail
                : result.completeSixProductObservation
        )
            ? 0
            : 1;
        await save(
            'source-proof.json',
            JSON.stringify(
                {
                    sourceSha,
                    startedAt,
                    finishedAt: new Date().toISOString(),
                    limits,
                    inputs,
                    requests,
                    totals: budget.totals(),
                    ...result,
                },
                null,
                2,
            ) + '\n',
        );
        console.log(
            JSON.stringify({
                sourceSha,
                mode,
                completeSixProductObservation: result.completeSixProductObservation,
                completeSelectedProductsWithUsableDetail: result.completeSelectedProductsWithUsableDetail,
                totals: budget.totals(),
                products: result.products.map(({ product, status, observedFrames, clientUsableFrames }) => ({
                    product,
                    status,
                    observedFrames,
                    clientUsableFrames,
                })),
            }),
        );
    } catch (error) {
        await save(
            'failure.json',
            JSON.stringify({ sourceSha, error: failure(error), requests, totals: budget.totals() }, null, 2) + '\n',
        );
        throw error;
    } finally {
        clearTimeout(timer);
        controller.abort();
        globalThis.fetch = nativeFetch;
        await save('process-exit.txt', String(exitCode) + '\n');
    }
    process.exitCode = exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
    main().catch((error) => {
        console.error(failure(error));
        process.exitCode = 1;
    });
