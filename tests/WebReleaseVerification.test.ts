import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    DOCUMENT_CACHE_CONTROL,
    ENABLED_HOSTED_MARINE_DATASETS,
    HOSTED_MARINE_DATASET_SPECS,
    IMMUTABLE_ASSET_CACHE_CONTROL,
    RETIRED_LEGACY_MARINE_PATHS,
    hostedMarineManifestFailures,
    localRouteExpectation,
    verifyHostedMarineDataset,
    validatePublicBetaFeatureManifest,
    validateHtmlSurface,
    validateVercelConfig,
    sameOriginVercelRequestHeaders,
} from '../scripts/verify-web-release.mjs';
import {
    createPublicBetaFeatureArtifact,
    readPublicBetaFeatureProfile,
} from '../scripts/public-beta-feature-profile.mjs';
import { MARINE_DATASET_CONTRACTS, canonicalMarineGeneration } from '../services/weather/api/marineManifestContract';
import { isTrustedThalassaVercelPreviewOrigin } from '../utils/vercelPreviewTrust';

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');

const HOSTED_TEST_NOW = Date.parse('2026-08-05T12:00:00Z');
const TEST_WIDTH = 1440;
const TEST_HEIGHT = 630;
const TEST_ASSET_BYTES = 30 + TEST_WIDTH * TEST_HEIGHT * 9;

function sha256Bytes(bytes: Uint8Array | Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function integrityHeaders(bytes: Uint8Array | Buffer): Record<string, string> {
    const digest = sha256Bytes(bytes);
    return {
        'access-control-allow-origin': '*',
        'content-digest': `sha-256=:${Buffer.from(digest, 'hex').toString('base64')}:`,
        etag: `"${digest}"`,
        'x-content-sha256': digest,
        'x-content-type-options': 'nosniff',
    };
}

function sstHostedFixture(dataStart: string, publishedAt: string, asset: Uint8Array) {
    const spec = MARINE_DATASET_CONTRACTS.sst;
    const digest = sha256Bytes(asset);
    const hashes = Array.from({ length: spec.steps }, () => digest);
    const generation = canonicalMarineGeneration(dataStart, 'sst', hashes);
    const startMs = Date.parse(dataStart);
    const canonical = (milliseconds: number) => new Date(milliseconds).toISOString().replace('.000Z', 'Z');
    return {
        schema_version: 2,
        dataset: { key: 'sst', id: spec.id },
        generation,
        generated_at: '2026-08-05T10:00:00Z',
        published_at: publishedAt,
        data_start: dataStart,
        data_end: canonical(startMs + (spec.steps - 1) * 24 * 60 * 60 * 1000),
        cadence_hours: 24,
        dimensions: { width: TEST_WIDTH, height: TEST_HEIGHT },
        bounds: { north: 89.875, south: -79.875, west: -179.875, east: 179.875 },
        producer: { commit: 'a'.repeat(40), run_id: 42, run_attempt: 1 },
        files: hashes.map((sha256, step) => ({
            step,
            offset_hours: step * 24,
            data_time: canonical(startMs + step * 24 * 60 * 60 * 1000),
            filename: `${generation}-h${String(step).padStart(3, '0')}.bin`,
            bytes: asset.byteLength,
            sha256,
            content_type: 'application/octet-stream',
        })),
        metadata: { attribution: 'Copernicus Marine Service' },
    };
}

function hostedMarineFetchMock({
    slotA,
    slotB,
    asset,
    missingFilename,
}: {
    slotA: ReturnType<typeof sstHostedFixture>;
    slotB: ReturnType<typeof sstHostedFixture>;
    asset: Uint8Array;
    missingFilename: string;
}) {
    const rawBodies = {
        'manifest-v2-a.json': Buffer.from(JSON.stringify(slotA)),
        'manifest-v2-b.json': Buffer.from(JSON.stringify(slotB)),
    };
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = new URL(String(input));
        for (const slot of ['manifest-v2-a.json', 'manifest-v2-b.json'] as const) {
            if (url.pathname.endsWith(`/${slot}`)) {
                return new Response(rawBodies[slot], {
                    status: 200,
                    headers: { 'content-type': 'application/octet-stream' },
                });
            }
        }
        if (url.pathname === '/api/sst/manifest-v2.json') {
            const body = rawBodies['manifest-v2-b.json'];
            return new Response(body, {
                status: 200,
                headers: {
                    ...integrityHeaders(body),
                    'access-control-expose-headers':
                        'Content-Digest, ETag, X-Content-SHA256, X-Thalassa-Generation, X-Thalassa-Selected-Manifest-Slot, X-Thalassa-Valid-Manifest-Slots',
                    'cache-control': 'no-store',
                    'content-type': 'application/json; charset=utf-8',
                    'x-thalassa-generation': slotB.generation,
                    'x-thalassa-selected-manifest-slot': 'manifest-v2-b.json',
                    'x-thalassa-valid-manifest-slots': '2',
                },
            });
        }
        const filename = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        if (filename === missingFilename) return new Response('missing', { status: 404 });
        const generation = filename.match(/^(g-\d{8}T\d{6}Z-[0-9a-f]{12})-/)?.[1] ?? '';
        return new Response(asset.slice(), {
            status: 200,
            headers: {
                ...integrityHeaders(asset),
                'accept-ranges': 'none',
                'cache-control': 'public, max-age=31536000, s-maxage=31536000, immutable',
                'content-type': 'application/octet-stream',
                'x-thalassa-generation': generation,
            },
        });
    });
}

describe('web release verification', () => {
    afterEach(() => vi.restoreAllMocks());
    it('adds a trimmed Vercel bypass only to explicitly same-origin request headers', () => {
        expect(sameOriginVercelRequestHeaders({ accept: 'text/html' }, '  release-token  ')).toEqual({
            accept: 'text/html',
            'x-vercel-protection-bypass': 'release-token',
        });
        expect(sameOriginVercelRequestHeaders({ accept: 'text/html' }, '   ')).toEqual({ accept: 'text/html' });
    });
    it('pins a Vercel automation bypass to the Thalassa preview host family', () => {
        expect(isTrustedThalassaVercelPreviewOrigin('https://thalassa-2qzyf82kr-serene-summer.vercel.app')).toBe(true);
        expect(isTrustedThalassaVercelPreviewOrigin('https://thalassa-git-beta-serene-summer.vercel.app')).toBe(true);
        expect(isTrustedThalassaVercelPreviewOrigin('https://thalassa.example.com')).toBe(false);
        expect(isTrustedThalassaVercelPreviewOrigin('https://thalassa-a-serene-summer.vercel.app.evil.test')).toBe(
            false,
        );
        expect(isTrustedThalassaVercelPreviewOrigin('https://thalassa-a-serene-summer.vercel.app/path')).toBe(false);
    });
    it('accepts only the canonical, credential-complete public-beta feature manifest', () => {
        const profile = readPublicBetaFeatureProfile(process.cwd());
        const presence = Object.fromEntries(profile.requiredCredentialPresence.map((name: string) => [name, true]));
        const artifact = createPublicBetaFeatureArtifact(profile, presence);

        expect(validatePublicBetaFeatureManifest(artifact)).toEqual([]);
        artifact.featureFlags.VITE_MPA_ENABLED = true;
        expect(validatePublicBetaFeatureManifest(artifact)).toEqual(
            expect.arrayContaining([
                'VITE_MPA_ENABLED must equal false',
                'feature manifest fingerprint does not match',
            ]),
        );
    });

    it('enables only cut-over feeds while retaining schema-v2 validation and legacy retirement contracts', () => {
        const now = Date.parse('2026-08-05T12:00:00Z');
        const spec = HOSTED_MARINE_DATASET_SPECS.currents;
        const hashes = Array.from({ length: 13 }, () => 'b'.repeat(64));
        const generation = canonicalMarineGeneration('2026-08-05T06:00:00Z', 'currents', hashes);
        const exactBytes = 30 + 1440 * 721 * 9;
        const manifest = {
            schema_version: 2,
            dataset: { key: 'currents', id: spec.id },
            generation,
            generated_at: '2026-08-05T11:00:00Z',
            published_at: '2026-08-05T11:05:00Z',
            data_start: '2026-08-05T06:00:00Z',
            data_end: '2026-08-05T18:00:00Z',
            cadence_hours: 1,
            dimensions: { width: 1440, height: 721 },
            bounds: { north: 90, south: -90, west: -180, east: 180 },
            producer: { commit: 'a'.repeat(40), run_id: 1, run_attempt: 1 },
            files: hashes.map((sha256, step) => ({
                step,
                offset_hours: step,
                data_time: `2026-08-05T${String(step + 6).padStart(2, '0')}:00:00Z`,
                filename: `${generation}-h${String(step).padStart(3, '0')}.bin`,
                bytes: exactBytes,
                sha256,
                content_type: 'application/octet-stream',
            })),
        };

        // Cut over 2026-08-07 once their manifest-v2 endpoints actually
        // served. Waves/seaice/mld remain held (and are separately parked from
        // the pickers); mpa's pipeline has not re-run since the publisher fix.
        expect(ENABLED_HOSTED_MARINE_DATASETS).toEqual(['currents', 'sst', 'chl']);
        expect(RETIRED_LEGACY_MARINE_PATHS).toHaveLength(62);
        for (const dataset of ['currents', 'waves', 'sst', 'chl', 'seaice', 'mld'] as const) {
            expect(RETIRED_LEGACY_MARINE_PATHS).toContain(`/api/${dataset}/manifest.json`);
            for (let step = 0; step < HOSTED_MARINE_DATASET_SPECS[dataset].steps; step += 1) {
                expect(RETIRED_LEGACY_MARINE_PATHS).toContain(`/api/${dataset}/h${String(step).padStart(2, '0')}.bin`);
            }
        }
        expect(RETIRED_LEGACY_MARINE_PATHS).toContain('/api/mpa/manifest.json');
        expect(RETIRED_LEGACY_MARINE_PATHS).toContain('/api/mpa/mpa.geojson');
        expect(hostedMarineManifestFailures(manifest, 'currents', now)).toEqual([]);
        expect(hostedMarineManifestFailures({ ...manifest, schema_version: 1 }, 'currents', now)).toContain(
            'currents: manifest schema_version must be exactly 2',
        );
        const noncanonical = structuredClone(manifest);
        noncanonical.generation = 'g-20260805T060000Z-0123456789ab';
        noncanonical.files.forEach((file, step) => {
            file.filename = `${noncanonical.generation}-h${String(step).padStart(3, '0')}.bin`;
        });
        expect(hostedMarineManifestFailures(noncanonical, 'currents', now)).toContain(
            'currents: generation digest does not match source time and ordered asset hashes',
        );
        expect(hostedMarineManifestFailures({ ...manifest, metadata: 'not-an-object' }, 'currents', now)).toContain(
            'currents: manifest metadata must be an object',
        );
        expect(
            hostedMarineManifestFailures(
                {
                    ...manifest,
                    data_start: '2026-08-04T06:00:00Z',
                    data_end: '2026-08-04T18:00:00Z',
                    generation: canonicalMarineGeneration('2026-08-04T06:00:00Z', 'currents', hashes),
                    files: manifest.files.map((file, step) => ({
                        ...file,
                        data_time: `2026-08-04T${String(step + 6).padStart(2, '0')}:00:00Z`,
                        filename: `${canonicalMarineGeneration('2026-08-04T06:00:00Z', 'currents', hashes)}-h${String(step).padStart(3, '0')}.bin`,
                    })),
                },
                'currents',
                now,
            ),
        ).toContain('currents: dataset does not cover the current time');

        const mpaSha = 'c'.repeat(64);
        const mpaGeneration = canonicalMarineGeneration('2024-06-30T00:00:00Z', 'mpa', [mpaSha]);
        const oneByteMpa = {
            ...manifest,
            dataset: { key: 'mpa', id: HOSTED_MARINE_DATASET_SPECS.mpa.id },
            generation: mpaGeneration,
            generated_at: '2026-08-05T10:00:00Z',
            published_at: '2026-08-05T11:00:00Z',
            data_start: '2024-06-30T00:00:00Z',
            data_end: '2024-06-30T00:00:00Z',
            cadence_hours: null,
            dimensions: { feature_count: 4541 },
            bounds: { west: 70.717, east: 170.3667, south: -58.4488, north: -8.4738 },
            files: [
                {
                    step: 0,
                    filename: `${mpaGeneration}-mpa.geojson`,
                    bytes: 1,
                    sha256: mpaSha,
                    content_type: 'application/geo+json',
                },
            ],
        };
        expect(hostedMarineManifestFailures(oneByteMpa, 'mpa', now)[0]).toMatch(/byte count is invalid/i);
    });

    it('fails when a later immutable frame referenced by both independently valid slots is missing', async () => {
        const asset = new Uint8Array(TEST_ASSET_BYTES);
        const manifest = sstHostedFixture('2026-08-05T00:00:00Z', '2026-08-05T11:00:00Z', asset);
        const missingFilename = manifest.files[1].filename;
        const fetchSpy = hostedMarineFetchMock({ slotA: manifest, slotB: manifest, asset, missingFilename });

        const failures = await verifyHostedMarineDataset('https://thalassa.test', 'sst', HOSTED_TEST_NOW);

        expect(failures).toEqual(expect.arrayContaining([expect.stringContaining(`${missingFilename}: HTTP 404`)]));
        const assetCalls = fetchSpy.mock.calls
            .map(([input]) => new URL(String(input)).pathname)
            .filter((pathname) => pathname.startsWith('/api/sst/g-'));
        expect(new Set(assetCalls).size).toBe(6);
    });

    it('fails when an immutable asset referenced only by the inactive raw slot is missing', async () => {
        const asset = new Uint8Array(TEST_ASSET_BYTES);
        const inactive = sstHostedFixture('2026-08-04T00:00:00Z', '2026-08-05T10:30:00Z', asset);
        const selected = sstHostedFixture('2026-08-05T00:00:00Z', '2026-08-05T11:00:00Z', asset);
        const missingFilename = inactive.files[0].filename;
        const fetchSpy = hostedMarineFetchMock({ slotA: inactive, slotB: selected, asset, missingFilename });

        const failures = await verifyHostedMarineDataset('https://thalassa.test', 'sst', HOSTED_TEST_NOW);

        expect(failures).toEqual(expect.arrayContaining([expect.stringContaining(`${missingFilename}: HTTP 404`)]));
        const assetCalls = fetchSpy.mock.calls
            .map(([input]) => new URL(String(input)).pathname)
            .filter((pathname) => pathname.startsWith('/api/sst/g-'));
        expect(new Set(assetCalls).size).toBe(12);
    });

    it('accepts the complete Vercel routing, security, and cache contract', () => {
        const config = JSON.parse(read('vercel.json'));

        expect(validateVercelConfig(config)).toEqual([]);
        expect(DOCUMENT_CACHE_CONTROL).toBe('public, max-age=0, must-revalidate');
        expect(IMMUTABLE_ASSET_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
    });

    it('fails closed when an edge redirect, security header, or cache rule drifts', () => {
        const config = JSON.parse(read('vercel.json'));
        config.redirects = config.redirects.filter((rule: { source: string }) => rule.source !== '/float/:path*');
        const globalHeaders = config.headers.find((rule: { source: string }) => rule.source === '/(.*)').headers;
        globalHeaders.find((header: { key: string }) => header.key === 'X-Frame-Options').value = 'SAMEORIGIN';
        const assetHeaders = config.headers.find((rule: { source: string }) => rule.source === '/assets/(.*)').headers;
        assetHeaders.find((header: { key: string }) => header.key === 'Cache-Control').value = 'max-age=60';

        expect(validateVercelConfig(config)).toEqual(
            expect.arrayContaining([
                '/float/:path* must have one temporary redirect to /logs',
                'global x-frame-options must equal DENY',
                `/assets/(.*) must use ${IMMUTABLE_ASSET_CACHE_CONTROL}`,
            ]),
        );
    });

    it('maps every critical preview route to the intended document or redirect', () => {
        expect(localRouteExpectation('/')).toEqual({ kind: 'document', file: 'index.html', surface: 'main' });
        expect(localRouteExpectation('/plan/passage?from=test')).toEqual({
            kind: 'document',
            file: 'index.html',
            surface: 'main',
        });
        expect(localRouteExpectation('/settings/deep-link')).toEqual({
            kind: 'document',
            file: 'index.html',
            surface: 'main',
        });
        expect(localRouteExpectation('/logs/demo-vessel')).toEqual({
            kind: 'document',
            file: 'logs.html',
            surface: 'logs',
        });
        expect(localRouteExpectation('/float/legacy-plan')).toEqual({ kind: 'redirect', destination: '/logs' });
        expect(localRouteExpectation('/assets/main-hash.js')).toEqual({ kind: 'asset' });
    });

    it('rejects a nonempty impostor page instead of treating it as the real app shell', () => {
        const realShell = `
            <title>Thalassa — Marine Weather & Passage Planning</title>
            <div id="root"></div>
            <script type="module" src="/assets/main-release123.js"></script>
        `;

        expect(validateHtmlSurface(realShell, 'main')).toEqual([]);
        expect(validateHtmlSurface('<html><body>Deployment ready</body></html>', 'main')).toEqual(
            expect.arrayContaining([
                expect.stringContaining('root'),
                expect.stringContaining('production JavaScript asset'),
            ]),
        );
    });

    it('wires local verification after build and hosted verification after deployment', () => {
        const pkg = JSON.parse(read('package.json'));
        const ci = read('.github/workflows/ci.yml');
        const preview = read('.github/workflows/preview-smoke.yml');
        const verifier = read('scripts/verify-web-release.mjs');

        expect(pkg.scripts['check:web-release']).toBe('node scripts/verify-web-release.mjs');
        expect(pkg.scripts['ship:beta']).toContain('npm run build && npm run check:web-release');
        expect(ci.indexOf('npm run build')).toBeLessThan(ci.indexOf('npm run check:web-release'));
        expect(preview).toContain('npm run check:web-release -- --hosted "$PREVIEW_URL"');
        expect(preview.indexOf('npm run check:web-release')).toBeLessThan(preview.indexOf('npx playwright test'));
        expect(verifier).toContain('for (const dataset of ENABLED_HOSTED_MARINE_DATASETS)');
        expect(verifier).toContain(
            'await verifyHostedMarineDataset(origin, dataset, Date.now(), protectionBypassSecret)',
        );
        expect(verifier).toContain('fetchRawManifestSlot(dataset, slot, nowMs)');
        expect(verifier).toContain('RAW_MANIFEST_SLOTS.map((slot) => fetchRawManifestSlot(dataset, slot, nowMs))');
        expect(verifier).toContain('HOSTED_ASSET_CONCURRENCY = 2');
        expect(verifier).toContain('verifyHostedMarineAsset(origin, dataset, asset, protectionBypassSecret)');
        expect(verifier).toContain('same-generation discovery slots disagree on immutable manifest content');
        expect(verifier).toContain('/manifest-v2.json?release-verifier=${nowMs}');
        expect(verifier).toContain('virtual discovery manifest must use Cache-Control: no-store');
        expect(verifier).toContain("headers.get('x-thalassa-valid-manifest-slots') !== '2'");
        expect(verifier).toContain('both validated discovery slots must be populated before cutover');
        expect(verifier).toContain('for (const pathname of RETIRED_LEGACY_MARINE_PATHS)');
        expect(verifier).toContain('Array.from({ length: steps }');
        expect(verifier).toContain('expected 410 Gone');
    });
});
