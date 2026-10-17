/** Reviewed one-shot public read only. Default/import paths perform no network or writes. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SATELLITE_VIEW_URL } from '../services/weather/satelliteViewEndpoint.ts';
import {
    SATELLITE_VIEW_PRODUCTS,
    SATELLITE_IMAGE_MAX,
    SATELLITE_METADATA_MAX,
    validateSatelliteViewTimes,
} from '../services/weather/satelliteViewContract.ts';
import { readSatelliteResponse } from '../services/weather/satelliteViewBytes.ts';
import {
    SATELLITE_SOURCE_PROOF_BOXES,
    inspectSatelliteProofPng,
    satelliteProofFetch,
} from './prove-sharper-satellite-source.mjs';
export const PUBLIC_SATELLITE_PROOF_LIMITS = Object.freeze({
    requests: 18,
    consumedBytes: 32 * 1024 * 1024,
    directoryBytes: 32 * 1024 * 1024,
    edge: 256,
    seconds: 600,
    readSeconds: 25,
    providerRequestsMaximumInsideReviewedEdge: 42,
});
const SOURCE_INPUTS = [
    '.github/workflows/public-satellite141-proof.yml',
    'scripts/prove-public-satellite141.mjs',
    'scripts/prove-sharper-satellite-source.mjs',
    'api/satellite-view.ts',
    'services/weather/satelliteViewEndpoint.ts',
    'services/weather/satelliteViewContract.ts',
    'services/weather/satelliteViewBytes.ts',
    'services/weather/api/boundedPublisherResponse.ts',
    'supabase/functions/satellite-view/index.ts',
    'supabase/functions/satellite-view/handler.ts',
    'supabase/functions/_shared/auth-rate-limit.ts',
    'supabase/functions/_shared/http-security.ts',
    'supabase/config.toml',
    'package.json',
    'package-lock.json',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** @param {{allowPublicReads:boolean,save:(filename:string,value:Uint8Array|string)=>Promise<void>,signal:AbortSignal,read?:typeof readSatelliteResponse}} options */
export async function runPublicSatelliteProof({ allowPublicReads, save, signal, read = readSatelliteResponse }) {
    if (!allowPublicReads) throw Error('Explicit reviewed public reads required');
    const products = [];
    for (const product of Object.keys(SATELLITE_VIEW_PRODUCTS)) {
        signal.throwIfAborted();
        const metadata = await read(
            `${SATELLITE_VIEW_URL}?action=times&product=${product}`,
            'application/json',
            SATELLITE_METADATA_MAX,
            signal,
        );
        signal.throwIfAborted();
        const listed = validateSatelliteViewTimes(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata.bytes)),
            product,
            Date.now(),
        );
        await save(`${product}-public-times.json`, metadata.bytes);
        // Always test newest/default. A second originally listed frame tests
        // manual older selection without hiding a newest missing/detail hold.
        const frames = [listed.frames.at(-1)];
        const older =
            SATELLITE_VIEW_PRODUCTS[product].provider === 'gibs' && !SATELLITE_VIEW_PRODUCTS[product].daily
                ? listed.frames[0]
                : listed.frames.at(-2);
        if (older && older !== frames[0]) frames.push(older);
        const observations = [];
        for (const frame of frames) {
            validateSatelliteViewTimes(listed, product, Date.now());
            const box = SATELLITE_SOURCE_PROOF_BOXES[product];
            const params = new URLSearchParams({
                action: 'image',
                product,
                time: frame.iso,
                bbox: box.join(','),
                width: '256',
                height: '256',
            });
            const url = `${SATELLITE_VIEW_URL}?${params}`;
            try {
                const image = await read(url, 'image/png', SATELLITE_IMAGE_MAX, signal);
                signal.throwIfAborted();
                if (
                    image.response.headers.get('x-thalassa-listed-time') !== frame.iso ||
                    image.response.headers.get('x-thalassa-satellite-product') !== product ||
                    image.response.headers.get('x-thalassa-satellite-window') !== `${box.join(',')}:256x256`
                )
                    throw Error('Public image provenance differs');
                validateSatelliteViewTimes(listed, product, Date.now());
                const filename = `${product}-${frame.iso.replaceAll(':', '')}.png`;
                await save(filename, image.bytes);
                observations.push({
                    listedTime: frame.iso,
                    defaultNewest: frame === listed.frames.at(-1),
                    bytes: image.bytes.length,
                    sha256: hash(image.bytes),
                    file: filename,
                    png: inspectSatelliteProofPng(image.bytes),
                    acquisitionClock: 'unknown',
                });
            } catch (error) {
                signal.throwIfAborted();
                observations.push({
                    listedTime: frame.iso,
                    defaultNewest: frame === listed.frames.at(-1),
                    error: String(error?.message ?? error).slice(0, 500),
                });
            }
        }
        products.push({
            product,
            originalMetadataReadAt: listed.readAtMs,
            box: SATELLITE_SOURCE_PROOF_BOXES[product],
            metadataSha256: hash(metadata.bytes),
            observations,
        });
    }
    return {
        products,
        completeAllProductsWithUsableDetail: products.every((p) =>
            p.observations.some((f) => f.png?.clientDetailStatus === 'usable'),
        ),
        currentClockAltered: false,
        providerDirectReads: 0,
        flagsChanged: false,
        publication: false,
        limitations: [
            'Only these small windows/current public responses are observed; no worldwide completeness.',
            'Listed time/post-read membership are not independent image acquisition clocks.',
            'Newest/default and older manual selection are reported separately; no silent fallback claim.',
        ],
    };
}
async function main() {
    if (process.argv.length !== 4 || process.argv[2] !== '--read-reviewed-public')
        throw Error(
            'Reviewed use only: node --import tsx scripts/prove-public-satellite141.mjs --read-reviewed-public NEW_OUTPUT_DIR',
        );
    const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (
        !/^[a-f0-9]{40}$/.test(process.env.SOURCE_SHA ?? '') ||
        process.env.SOURCE_SHA !== source ||
        execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
    )
        throw Error('Exact clean reviewed source required');
    const output = path.resolve(process.argv[3]);
    await mkdir(output);
    let directoryBytes = 0;
    const save = async (filename, value) => {
        const bytes = typeof value === 'string' ? Buffer.from(value) : value;
        if (!/^[A-Za-z0-9_.-]{1,160}$/.test(filename)) throw Error('Proof filename');
        directoryBytes += bytes.length;
        if (directoryBytes > PUBLIC_SATELLITE_PROOF_LIMITS.directoryBytes - 512 * 1024)
            throw Error('Proof directory bound');
        await writeFile(path.join(output, filename), bytes, { flag: 'wx' });
    };
    const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(Error('Public proof deadline')), 600000),
        nativeFetch = globalThis.fetch,
        requests = [];
    const budget = satelliteProofFetch(
        nativeFetch,
        controller,
        (record) => requests.push(record),
        PUBLIC_SATELLITE_PROOF_LIMITS,
    );
    globalThis.fetch = budget.fetch;
    let exit = 1;
    try {
        const inputs = [];
        for (const file of SOURCE_INPUTS) {
            const bytes = await readFile(file),
                original = execFileSync('git', ['show', `${source}:${file}`], { maxBuffer: 8 * 1024 * 1024 });
            if (!bytes.equals(original)) throw Error('Dirty proof input: ' + file);
            inputs.push({ file, bytes: bytes.length, sha256: hash(bytes) });
        }
        const result = await runPublicSatelliteProof({
            allowPublicReads: true,
            save,
            signal: controller.signal,
            read: async (url, mime, max, signal) => {
                budget.expect(url);
                const readController = new AbortController(),
                    abort = () => readController.abort(signal.reason);
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
                const deadline = setTimeout(() => readController.abort(Error('Public read deadline')), 25000);
                try {
                    return await readSatelliteResponse(url, mime, max, readController.signal);
                } finally {
                    clearTimeout(deadline);
                    signal.removeEventListener('abort', abort);
                }
            },
        });
        await save(
            'public-proof.json',
            JSON.stringify(
                {
                    source,
                    inputs,
                    at: new Date().toISOString(),
                    limits: PUBLIC_SATELLITE_PROOF_LIMITS,
                    requests,
                    totals: budget.totals(),
                    ...result,
                },
                null,
                2,
            ) + '\n',
        );
        exit = result.completeAllProductsWithUsableDetail ? 0 : 1;
    } catch (error) {
        await save(
            'failure.json',
            JSON.stringify(
                { source, error: String(error?.message ?? error), requests, totals: budget.totals() },
                null,
                2,
            ) + '\n',
        );
    } finally {
        clearTimeout(timer);
        controller.abort();
        globalThis.fetch = nativeFetch;
        await writeFile(path.join(output, 'process-exit.txt'), String(exit) + '\n', { flag: 'wx' });
    }
    process.exitCode = exit;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
    main().catch((error) => {
        console.error(String(error?.message ?? error));
        process.exitCode = 1;
    });
