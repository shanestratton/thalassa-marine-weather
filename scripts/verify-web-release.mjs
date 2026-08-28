#!/usr/bin/env node

/**
 * Deterministic web-release verification.
 *
 * Local (default): audits the Vercel route/header contract, inspects the
 * freshly-built `dist`, starts Vite's production preview, and proves that the
 * real built documents and hashed assets are served on critical deep routes.
 *
 * Hosted (`--hosted https://…`): probes the actual deployment with redirects
 * disabled and proves that Vercel enforced the declared rewrites, redirects,
 * security headers, cache policy, both raw discovery slots and every distinct
 * immutable asset they reference for every enabled marine feed. It also proves the bare and cache-busted
 * legacy marine paths are retired. A local preview cannot prove those edge and
 * hosted-data boundaries, so the deployment workflow always runs this mode.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    PUBLIC_BETA_FEATURE_ARTIFACT_FILE,
    publicBetaFeatureArtifactFailures,
    readPublicBetaFeatureProfile,
} from './public-beta-feature-profile.mjs';
import {
    MARINE_DATASET_CONTRACTS,
    marineAssetShardTag,
    validateMarineManifest,
} from '../services/weather/api/marineManifestContract.ts';
import { isTrustedThalassaVercelPreviewOrigin } from '../utils/vercelPreviewTrust.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const LOCAL_HOST = '127.0.0.1';
const LOCAL_PORT = 4173;
const LOCAL_ORIGIN = `http://${LOCAL_HOST}:${LOCAL_PORT}`;
const DEFAULT_RESPONSE_MAX_BYTES = 20 * 1024 * 1024;
const MARINE_MANIFEST_MAX_BYTES = 256 * 1024;
const MARINE_ASSET_MAX_BYTES = 16 * 1024 * 1024;
const RELEASE_OWNER_REPO = 'shanestratton/thalassa-marine-weather';
const RELEASE_REDIRECT_LIMIT = 2;
const TRUSTED_RELEASE_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com']);
const HOSTED_ASSET_CONCURRENCY = 2;
const VERCEL_AUTOMATION_BYPASS_HEADER = 'x-vercel-protection-bypass';
const publicBetaFeatureProfile = readPublicBetaFeatureProfile(ROOT);
const expectedPublicBetaCredentialPresence = Object.fromEntries(
    publicBetaFeatureProfile.requiredCredentialPresence.map((name) => [name, true]),
);

export const DOCUMENT_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const MARINE_FEATURE_FLAGS = Object.freeze({
    currents: 'VITE_CMEMS_CURRENTS_ENABLED',
    waves: 'VITE_CMEMS_WAVES_ENABLED',
    sst: 'VITE_CMEMS_SST_ENABLED',
    chl: 'VITE_CMEMS_CHL_ENABLED',
    seaice: 'VITE_CMEMS_SEAICE_ENABLED',
    mld: 'VITE_CMEMS_MLD_ENABLED',
    mpa: 'VITE_MPA_ENABLED',
});

export const HOSTED_MARINE_DATASET_SPECS = Object.freeze(
    Object.fromEntries(
        Object.entries(MARINE_DATASET_CONTRACTS).map(([dataset, spec]) => [
            dataset,
            Object.freeze({ ...spec, flag: MARINE_FEATURE_FLAGS[dataset] }),
        ]),
    ),
);

export const ENABLED_HOSTED_MARINE_DATASETS = Object.freeze(
    Object.entries(HOSTED_MARINE_DATASET_SPECS)
        .filter(([, spec]) => publicBetaFeatureProfile.featureFlags[spec.flag] === true)
        .map(([dataset]) => dataset),
);

export const RETIRED_LEGACY_MARINE_PATHS = Object.freeze([
    ...['currents', 'waves', 'sst', 'chl', 'seaice', 'mld'].flatMap((dataset) => {
        const steps = MARINE_DATASET_CONTRACTS[dataset].steps;
        return [
            `/api/${dataset}/manifest.json`,
            ...Array.from({ length: steps }, (_, step) => `/api/${dataset}/h${String(step).padStart(2, '0')}.bin`),
        ];
    }),
    '/api/mpa/manifest.json',
    '/api/mpa/mpa.geojson',
]);

export const REQUIRED_SECURITY_HEADERS = Object.freeze({
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'x-xss-protection': '1; mode=block',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(self), microphone=(self), payment=(self), usb=()',
    'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
});

/* frame-ancestors is an allow-list of exactly two origins, not 'none':
   Thalassa itself, and the Serene Summer instrument panel, which embeds
   the plan and public pages so the boat's touchscreen never has to leave
   the dashboard (a fullscreen kiosk has no back button). That host only
   resolves on the owner's private Tailscale network, so the permission
   cannot be reached from the public internet.

   X-Frame-Options: DENY is deliberately kept in REQUIRED_SECURITY_HEADERS.
   Per CSP Level 2 a browser that understands frame-ancestors must ignore
   X-Frame-Options, so the modern path honours this narrow allow-list while
   older browsers still refuse framing outright.

   This stays an exact-match check: widening it further should require
   editing this line and thinking about why. */
const PANEL_FRAME_ANCESTOR = 'https://pi5.tail65c605.ts.net';

const REQUIRED_CSP_DIRECTIVES = Object.freeze([
    "default-src 'self'",
    "frame-src 'none'",
    `frame-ancestors 'self' ${PANEL_FRAME_ANCESTOR}`,
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
]);

const DOCUMENT_HEADER_SOURCES = Object.freeze([
    '/((?!.*\\..*).*)',
    '/index.html',
    '/logs.html',
    '/beta.html',
    '/terms.html',
    '/voyage-log-api.html',
]);

const REQUIRED_REWRITES = Object.freeze([
    ['/terms', '/terms.html'],
    ['/logs', '/logs.html'],
    ['/logs/:path*', '/logs.html'],
    ['/plan', '/index.html'],
    ['/plan/:path*', '/index.html'],
    ['/voyage-log-api', '/voyage-log-api.html'],
    ['/beta', '/beta.html'],
    ['/((?!.*\\..*).*)', '/index.html'],
]);

const REQUIRED_REDIRECTS = Object.freeze([
    ['/float', '/logs'],
    ['/float/:path*', '/logs'],
]);

const SURFACE_MARKERS = Object.freeze({
    main: ['<div id="root"></div>', '<title>Thalassa — Marine Weather & Passage Planning</title>'],
    logs: ['<div id="root"></div>', '<title>Voyage Log — Thalassa</title>'],
    beta: ['<div id="root"></div>', '<title>Founding Skippers — Thalassa</title>'],
    terms: ['<title>Thalassa Marine Weather — Terms & Privacy</title>'],
    api: ['<title>Voyage Log API — Thalassa</title>', '<h1>Voyage Log API</h1>'],
});

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

/**
 * Add Vercel's automation credential only to a caller-controlled same-origin
 * request. Callers must never use this for redirected or third-party asset
 * requests because the bypass value is a repository secret.
 */
export function sameOriginVercelRequestHeaders(headers, rawSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    const secret = rawSecret?.trim();
    if (!secret) return { ...headers };
    return { ...headers, [VERCEL_AUTOMATION_BYPASS_HEADER]: secret };
}

/** Validate the live discovery contract that a released client will consume. */
export function hostedMarineManifestFailures(value, dataset, nowMs = Date.now()) {
    if (!Object.hasOwn(MARINE_DATASET_CONTRACTS, dataset)) return [`unknown hosted marine dataset: ${dataset}`];
    try {
        validateMarineManifest(value, dataset, nowMs, true);
        return [];
    } catch (error) {
        return [`${dataset}: ${error instanceof Error ? error.message : 'manifest contract failed'}`];
    }
}

function headerMap(rule) {
    if (!Array.isArray(rule?.headers)) return new Map();
    return new Map(
        rule.headers
            .filter((header) => typeof header?.key === 'string' && typeof header?.value === 'string')
            .map((header) => [header.key.toLowerCase(), header.value]),
    );
}

function exactlyOneRule(rules, source) {
    return Array.isArray(rules) ? rules.filter((rule) => rule?.source === source) : [];
}

/** Return every source-level error in the selected Vercel hosting contract. */
export function validateVercelConfig(config) {
    const failures = [];
    if (!config || typeof config !== 'object') return ['vercel.json must contain a JSON object'];

    for (const [source, destination] of REQUIRED_REDIRECTS) {
        const matches = exactlyOneRule(config.redirects, source);
        if (matches.length !== 1 || matches[0]?.destination !== destination || matches[0]?.permanent !== false) {
            failures.push(`${source} must have one temporary redirect to ${destination}`);
        }
    }

    for (const [source, destination] of REQUIRED_REWRITES) {
        const matches = exactlyOneRule(config.rewrites, source);
        if (matches.length !== 1 || matches[0]?.destination !== destination) {
            failures.push(`${source} must have one rewrite to ${destination}`);
        }
    }

    const catchAllRewriteIndex = Array.isArray(config.rewrites)
        ? config.rewrites.findIndex((rule) => rule?.source === '/((?!.*\\..*).*)')
        : -1;
    if (catchAllRewriteIndex !== (config.rewrites?.length ?? 0) - 1) {
        failures.push('the dotless SPA fallback must remain the last rewrite');
    }

    const globalHeaderRules = exactlyOneRule(config.headers, '/(.*)');
    if (globalHeaderRules.length !== 1) {
        failures.push('/(.*) must have exactly one global security-header rule');
    } else {
        const headers = headerMap(globalHeaderRules[0]);
        for (const [key, expected] of Object.entries(REQUIRED_SECURITY_HEADERS)) {
            if (headers.get(key) !== expected) failures.push(`global ${key} must equal ${expected}`);
        }
        const csp = headers.get('content-security-policy') ?? '';
        for (const directive of REQUIRED_CSP_DIRECTIVES) {
            if (!csp.includes(directive)) failures.push(`global content-security-policy must include ${directive}`);
        }
    }

    const assetRules = exactlyOneRule(config.headers, '/assets/(.*)');
    if (assetRules.length !== 1 || headerMap(assetRules[0]).get('cache-control') !== IMMUTABLE_ASSET_CACHE_CONTROL) {
        failures.push(`/assets/(.*) must use ${IMMUTABLE_ASSET_CACHE_CONTROL}`);
    }

    const serviceWorkerRules = exactlyOneRule(config.headers, '/sw.js');
    if (
        serviceWorkerRules.length !== 1 ||
        headerMap(serviceWorkerRules[0]).get('cache-control') !== DOCUMENT_CACHE_CONTROL
    ) {
        failures.push(`/sw.js must use ${DOCUMENT_CACHE_CONTROL}`);
    }

    for (const source of DOCUMENT_HEADER_SOURCES) {
        const matches = exactlyOneRule(config.headers, source);
        if (matches.length !== 1 || headerMap(matches[0]).get('cache-control') !== DOCUMENT_CACHE_CONTROL) {
            failures.push(`${source} must use ${DOCUMENT_CACHE_CONTROL}`);
        }
    }

    return failures;
}

/**
 * Identify the expected document without relying on a weak "body is nonempty"
 * smoke test. Vite HTML transforms `&` in titles, hence the explicit markers.
 */
export function validateHtmlSurface(html, surface) {
    const markers = SURFACE_MARKERS[surface];
    if (!markers) return [`unknown HTML surface: ${surface}`];
    const failures = [];
    for (const marker of markers) {
        if (!html.includes(marker)) failures.push(`${surface} document is missing ${marker}`);
    }
    if (
        (surface === 'main' || surface === 'logs' || surface === 'beta') &&
        !/\bsrc=["']\/assets\/[^"']+\.js["']/.test(html)
    ) {
        failures.push(`${surface} document does not boot a hashed production JavaScript asset`);
    }
    if (/\bsrc=["']\/src\//.test(html)) failures.push(`${surface} document still references a source module`);
    return failures;
}

export function localRouteExpectation(pathname) {
    const normalized = pathname.split('?')[0].replace(/\/+$/, '') || '/';
    if (normalized === '/float' || normalized.startsWith('/float/')) {
        return { kind: 'redirect', destination: '/logs' };
    }
    if (normalized === '/terms') return { kind: 'document', file: 'terms.html', surface: 'terms' };
    if (normalized === '/voyage-log-api') {
        return { kind: 'document', file: 'voyage-log-api.html', surface: 'api' };
    }
    if (normalized === '/beta') return { kind: 'document', file: 'beta.html', surface: 'beta' };
    if (normalized === '/logs' || normalized.startsWith('/logs/')) {
        return { kind: 'document', file: 'logs.html', surface: 'logs' };
    }
    if (
        normalized === '/' ||
        normalized === '/plan' ||
        normalized.startsWith('/plan/') ||
        !normalized.split('/').pop()?.includes('.')
    ) {
        return { kind: 'document', file: 'index.html', surface: 'main' };
    }
    return { kind: 'asset' };
}

function extractAssetPaths(html) {
    const assets = new Set();
    for (const match of html.matchAll(/\b(?:src|href)=["'](\/assets\/[^"'#?]+)(?:[?#][^"']*)?["']/g)) {
        assets.add(match[1]);
    }
    return [...assets].sort();
}

function readJson(relative) {
    const file = path.join(ROOT, relative);
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`${relative} is missing or invalid JSON: ${error instanceof Error ? error.message : error}`);
    }
}

export function validatePublicBetaFeatureManifest(value) {
    return publicBetaFeatureArtifactFailures(value, publicBetaFeatureProfile, expectedPublicBetaCredentialPresence);
}

function validateBuiltArtifacts() {
    const failures = [];
    const documents = new Map();
    const specs = [
        ['index.html', 'main'],
        ['logs.html', 'logs'],
        ['beta.html', 'beta'],
        ['terms.html', 'terms'],
        ['voyage-log-api.html', 'api'],
    ];

    for (const [file, surface] of specs) {
        const target = path.join(DIST, file);
        if (!fs.existsSync(target)) {
            failures.push(`dist/${file} is missing; run the production build first`);
            continue;
        }
        const html = fs.readFileSync(target, 'utf8');
        documents.set(file, html);
        failures.push(...validateHtmlSurface(html, surface).map((failure) => `dist/${file}: ${failure}`));
    }

    const assetPaths = [...documents.values()].flatMap(extractAssetPaths);
    if (!assetPaths.some((asset) => asset.endsWith('.js'))) {
        failures.push('built document set has no hashed JavaScript asset');
    }
    for (const asset of new Set(assetPaths)) {
        const decoded = decodeURIComponent(asset).replace(/^\//, '');
        const target = path.resolve(DIST, decoded);
        if (!target.startsWith(`${DIST}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
            failures.push(`built document references a missing or unsafe asset: ${asset}`);
        }
    }

    const featureManifestPath = path.join(DIST, PUBLIC_BETA_FEATURE_ARTIFACT_FILE);
    if (!fs.existsSync(featureManifestPath)) {
        failures.push(`dist/${PUBLIC_BETA_FEATURE_ARTIFACT_FILE} is missing`);
    } else {
        try {
            const manifest = JSON.parse(fs.readFileSync(featureManifestPath, 'utf8'));
            failures.push(
                ...validatePublicBetaFeatureManifest(manifest).map(
                    (failure) => `dist/${PUBLIC_BETA_FEATURE_ARTIFACT_FILE}: ${failure}`,
                ),
            );
        } catch (error) {
            failures.push(
                `dist/${PUBLIC_BETA_FEATURE_ARTIFACT_FILE} is invalid JSON: ${
                    error instanceof Error ? error.message : error
                }`,
            );
        }
    }

    return { failures, documents, assetPaths: [...new Set(assetPaths)].sort() };
}

function throwFailures(label, failures) {
    if (failures.length === 0) return;
    throw new Error(`${label} failed:\n${failures.map((failure) => `  - ${failure}`).join('\n')}`);
}

async function readBoundedResponse(response, label, maxBytes) {
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
        if (
            !/^\d+$/.test(declaredLength) ||
            !Number.isSafeInteger(Number(declaredLength)) ||
            Number(declaredLength) > maxBytes
        ) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`${label} declared an unsafe content length`);
        }
    }
    const chunks = [];
    let total = 0;
    if (response.body) {
        const reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel('release verifier response limit exceeded').catch(() => undefined);
                throw new Error(`${label} exceeded its response byte limit`);
            }
            chunks.push(Buffer.from(value));
        }
    }
    const bytes = Buffer.concat(chunks, total);
    return { bytes, text: bytes.toString('utf8') };
}

async function getResponse(
    origin,
    pathname,
    redirect = 'manual',
    maxBytes = DEFAULT_RESPONSE_MAX_BYTES,
    protectionBypassSecret,
) {
    const url = new URL(pathname, origin);
    const response = await fetch(url, {
        redirect,
        headers: sameOriginVercelRequestHeaders(
            {
                accept: 'text/html,application/xhtml+xml,application/javascript;q=0.9,*/*;q=0.8',
                'accept-encoding': 'identity',
                'user-agent': 'ThalassaReleaseVerifier/1.0',
            },
            protectionBypassSecret,
        ),
        signal: globalThis.AbortSignal.timeout(20_000),
    });
    const { bytes, text: bodyText } = await readBoundedResponse(response, pathname, maxBytes);
    return { url, response, bytes, text: bodyText };
}

async function getTrustedReleaseResponse(rawUrl, maxBytes) {
    let current = new URL(rawUrl);
    const signal = globalThis.AbortSignal.timeout(20_000);
    for (let redirectCount = 0; redirectCount <= RELEASE_REDIRECT_LIMIT; redirectCount += 1) {
        if (current.protocol !== 'https:' || !TRUSTED_RELEASE_HOSTS.has(current.hostname)) {
            throw new Error(`release redirect escaped the trusted host set: ${current.hostname}`);
        }
        const response = await fetch(current, {
            redirect: 'manual',
            cache: 'no-store',
            headers: {
                accept: 'application/json,application/octet-stream,text/plain;q=0.5',
                'accept-encoding': 'identity',
                'user-agent': 'ThalassaReleaseVerifier/1.0',
            },
            signal,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            await response.body?.cancel().catch(() => undefined);
            if (!location || redirectCount === RELEASE_REDIRECT_LIMIT) throw new Error('invalid release redirect');
            current = new URL(location, current);
            continue;
        }
        const { bytes, text: bodyText } = await readBoundedResponse(response, current.pathname, maxBytes);
        return { url: current, response, bytes, text: bodyText };
    }
    throw new Error('too many release redirects');
}

async function getResponseHeaders(origin, pathname, protectionBypassSecret) {
    const url = new URL(pathname, origin);
    const response = await fetch(url, {
        redirect: 'manual',
        headers: sameOriginVercelRequestHeaders(
            {
                accept: 'text/plain,*/*;q=0.5',
                'accept-encoding': 'identity',
                'user-agent': 'ThalassaReleaseVerifier/1.0',
            },
            protectionBypassSecret,
        ),
        signal: globalThis.AbortSignal.timeout(20_000),
    });
    await response.body?.cancel().catch(() => undefined);
    return { url, response };
}

function responseSecurityFailures(response, label) {
    const failures = [];
    for (const [key, expected] of Object.entries(REQUIRED_SECURITY_HEADERS)) {
        const actual = response.headers.get(key);
        if (actual !== expected) failures.push(`${label}: ${key}=${JSON.stringify(actual)}, expected ${expected}`);
    }
    const csp = response.headers.get('content-security-policy') ?? '';
    for (const directive of REQUIRED_CSP_DIRECTIVES) {
        if (!csp.includes(directive)) failures.push(`${label}: content-security-policy is missing ${directive}`);
    }
    return failures;
}

function documentResponseFailures(result, surface, label, { hosted }) {
    const failures = [];
    if (result.response.status !== 200) failures.push(`${label}: HTTP ${result.response.status}, expected 200`);
    const contentType = result.response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/html')) {
        failures.push(`${label}: content-type=${JSON.stringify(contentType)}, expected text/html`);
    }
    failures.push(...validateHtmlSurface(result.text, surface).map((failure) => `${label}: ${failure}`));
    if (hosted) {
        failures.push(...responseSecurityFailures(result.response, label));
        const cacheControl = result.response.headers.get('cache-control');
        if (cacheControl !== DOCUMENT_CACHE_CONTROL) {
            failures.push(
                `${label}: cache-control=${JSON.stringify(cacheControl)}, expected ${DOCUMENT_CACHE_CONTROL}`,
            );
        }
    }
    return failures;
}

async function waitForPreview(child, logs) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Vite preview exited with ${child.exitCode}\n${logs.join('')}`);
        }
        try {
            const response = await fetch(LOCAL_ORIGIN, { signal: globalThis.AbortSignal.timeout(1_000) });
            await response.body?.cancel();
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
    }
    throw new Error(`Vite preview did not become ready at ${LOCAL_ORIGIN}\n${logs.join('')}`);
}

async function stopPreview(child) {
    if (child.exitCode !== null) return;
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.kill('SIGTERM');
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    if (child.exitCode === null) {
        child.kill('SIGKILL');
        await closed;
    }
}

async function verifyLocalPreview(artifacts) {
    const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    if (!fs.existsSync(viteBin)) throw new Error('node_modules/vite is missing; run npm ci first');

    const logs = [];
    const child = spawn(
        process.execPath,
        [viteBin, 'preview', '--host', LOCAL_HOST, '--port', String(LOCAL_PORT), '--strictPort'],
        { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const capture = (chunk) => {
        logs.push(String(chunk));
        if (logs.join('').length > 20_000) logs.splice(0, logs.length - 10);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    try {
        await waitForPreview(child, logs);
        const failures = [];
        const routes = [
            '/',
            '/plan',
            '/plan/release-verification',
            '/release-verification/deep-route',
            '/logs/release-verification',
            '/beta',
            '/terms',
            '/voyage-log-api',
        ];

        for (const pathname of routes) {
            const expectation = localRouteExpectation(pathname);
            if (expectation.kind !== 'document') throw new Error(`invalid local route fixture: ${pathname}`);
            const result = await getResponse(LOCAL_ORIGIN, pathname);
            failures.push(
                ...documentResponseFailures(result, expectation.surface, `local ${pathname}`, { hosted: false }),
            );
            const artifact = artifacts.documents.get(expectation.file);
            if (artifact !== undefined && result.text !== artifact) {
                failures.push(`local ${pathname}: response bytes do not match dist/${expectation.file}`);
            }
        }

        for (const pathname of ['/float', '/float/release-verification']) {
            const result = await getResponse(LOCAL_ORIGIN, pathname);
            const location = result.response.headers.get('location');
            if (result.response.status !== 307 || new URL(location ?? '/', result.url).pathname !== '/logs') {
                failures.push(
                    `local ${pathname}: expected temporary redirect to /logs, got HTTP ${result.response.status} ${location}`,
                );
            }
        }

        const scriptAsset = artifacts.assetPaths.find((asset) => asset.endsWith('.js'));
        if (!scriptAsset) failures.push('local preview has no JavaScript asset fixture');
        else {
            const result = await getResponse(LOCAL_ORIGIN, scriptAsset);
            const localFile = path.join(DIST, scriptAsset.replace(/^\//, ''));
            if (result.response.status !== 200) failures.push(`local ${scriptAsset}: HTTP ${result.response.status}`);
            else if (sha256(result.bytes) !== sha256(fs.readFileSync(localFile))) {
                failures.push(`local ${scriptAsset}: served bytes differ from the built asset`);
            }
        }

        const featureManifest = await getResponse(LOCAL_ORIGIN, `/${PUBLIC_BETA_FEATURE_ARTIFACT_FILE}`);
        const localFeatureManifestPath = path.join(DIST, PUBLIC_BETA_FEATURE_ARTIFACT_FILE);
        if (featureManifest.response.status !== 200) {
            failures.push(`local /${PUBLIC_BETA_FEATURE_ARTIFACT_FILE}: HTTP ${featureManifest.response.status}`);
        } else if (sha256(featureManifest.bytes) !== sha256(fs.readFileSync(localFeatureManifestPath))) {
            failures.push(`local /${PUBLIC_BETA_FEATURE_ARTIFACT_FILE}: served bytes differ from the built artifact`);
        }

        throwFailures('local production preview', failures);
    } finally {
        await stopPreview(child);
    }
}

function normalizeHostedOrigin(raw) {
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`--hosted requires a valid absolute URL, received ${JSON.stringify(raw)}`);
    }
    if (url.protocol !== 'https:') throw new Error('hosted release verification requires HTTPS');
    if (url.username || url.password) throw new Error('hosted release verification refuses credentials in the URL');
    if (['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase())) {
        throw new Error('hosted release verification refuses localhost');
    }
    if (url.pathname !== '/' || url.search || url.hash) {
        throw new Error('hosted release verification URL must be an origin with no path, query, or fragment');
    }
    return url.origin;
}

function releaseProxyIntegrityFailures(result, label, expectedSha256 = null) {
    const failures = [];
    const actualSha256 = sha256(result.bytes);
    const expectedDigest = `sha-256=:${Buffer.from(actualSha256, 'hex').toString('base64')}:`;
    if (expectedSha256 !== null && actualSha256 !== expectedSha256) {
        failures.push(`${label}: body SHA-256 does not match the manifest`);
    }
    if (result.response.headers.get('x-content-sha256') !== actualSha256) {
        failures.push(`${label}: X-Content-SHA256 does not authenticate the response body`);
    }
    if (result.response.headers.get('content-digest') !== expectedDigest) {
        failures.push(`${label}: Content-Digest does not authenticate the response body`);
    }
    if (result.response.headers.get('etag') !== `"${actualSha256}"`) {
        failures.push(`${label}: ETag does not equal the verified body digest`);
    }
    if (result.response.headers.get('access-control-allow-origin') !== '*') {
        failures.push(`${label}: public release proxy must allow cross-origin reads`);
    }
    if (result.response.headers.get('x-content-type-options') !== 'nosniff') {
        failures.push(`${label}: release proxy must emit X-Content-Type-Options: nosniff`);
    }
    return failures;
}

function legacyMarineRetirementFailures(result, label) {
    const failures = [];
    if (result.response.status !== 410) failures.push(`${label}: HTTP ${result.response.status}, expected 410 Gone`);
    if (result.response.headers.get('cache-control') !== 'no-store') {
        failures.push(`${label}: retired legacy path must use Cache-Control: no-store`);
    }
    if (result.response.headers.get('access-control-allow-origin') !== '*') {
        failures.push(`${label}: retired legacy path must retain public CORS`);
    }
    if (result.response.headers.get('accept-ranges') !== 'none') {
        failures.push(`${label}: retired legacy path must refuse ranges`);
    }
    if (result.response.headers.get('x-content-type-options') !== 'nosniff') {
        failures.push(`${label}: retired legacy path must emit X-Content-Type-Options: nosniff`);
    }
    return failures;
}

const RAW_MANIFEST_SLOTS = Object.freeze(['manifest-v2-a.json', 'manifest-v2-b.json']);

function responseMediaType(response) {
    return (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
}

const OWM_HOSTED_TILE_MAX_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function hostedOwmTileFailures(result, label) {
    const failures = [];
    if (result.response.status !== 200) {
        failures.push(`${label}: HTTP ${result.response.status}, expected a proxied PNG tile`);
        return failures;
    }
    if (responseMediaType(result.response) !== 'image/png') {
        failures.push(`${label}: content-type must be image/png`);
    }
    if (
        result.bytes.length < PNG_SIGNATURE.length ||
        result.bytes.length > OWM_HOSTED_TILE_MAX_BYTES ||
        !result.bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    ) {
        failures.push(`${label}: response is not a bounded PNG tile`);
    }
    const cacheControl = result.response.headers.get('cache-control') ?? '';
    const cacheDirectives = new Set(cacheControl.split(',').map((directive) => directive.trim().toLowerCase()));
    if (!cacheDirectives.has('public') || !cacheDirectives.has('max-age=300')) {
        failures.push(`${label}: browser tile cache policy is missing`);
    }
    if (result.response.headers.get('access-control-allow-origin') !== '*') {
        failures.push(`${label}: native tile CORS is missing`);
    }
    if (result.response.headers.get('x-content-type-options') !== 'nosniff') {
        failures.push(`${label}: X-Content-Type-Options: nosniff is missing`);
    }
    const responseSurface = [...result.response.headers]
        .flatMap(([name, value]) => [name, value])
        .join('\n')
        .toLowerCase();
    const bodySurface = result.bytes.toString('latin1');
    if (
        result.url.searchParams.has('appid') ||
        /(?:appid=|owm_api_key)/i.test(responseSurface) ||
        /(?:appid=|owm_api_key)/i.test(bodySurface)
    ) {
        failures.push(`${label}: provider credential metadata escaped the server proxy`);
    }
    return failures;
}

function immutableManifestCore(manifest) {
    return JSON.stringify({
        schema_version: manifest.schema_version,
        dataset: manifest.dataset,
        generation: manifest.generation,
        data_start: manifest.data_start,
        data_end: manifest.data_end,
        cadence_hours: manifest.cadence_hours,
        dimensions: manifest.dimensions,
        bounds: manifest.bounds,
        metadata: manifest.metadata,
        files: manifest.files,
    });
}

async function fetchRawManifestSlot(dataset, slot, nowMs) {
    const spec = MARINE_DATASET_CONTRACTS[dataset];
    const url = new URL(`https://github.com/${RELEASE_OWNER_REPO}/releases/download/${spec.releaseTag}/${slot}`);
    url.searchParams.set('release-verifier', `${nowMs}-${slot}`);
    const result = await getTrustedReleaseResponse(url, MARINE_MANIFEST_MAX_BYTES);
    if (result.response.status !== 200) throw new Error(`HTTP ${result.response.status}`);
    if (
        !new Set(['application/json', 'application/octet-stream', 'text/plain']).has(responseMediaType(result.response))
    ) {
        throw new Error(`unexpected content type ${JSON.stringify(responseMediaType(result.response))}`);
    }
    let manifest;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(result.bytes);
        manifest = JSON.parse(text);
    } catch (error) {
        throw new Error(`invalid UTF-8 JSON (${error instanceof Error ? error.message : error})`);
    }
    validateMarineManifest(manifest, dataset, nowMs, true);
    return { slot, manifest, bytes: result.bytes };
}

async function mapWithConcurrency(items, concurrency, operation) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        for (;;) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= items.length) return;
            results[index] = await operation(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

async function verifyHostedMarineAsset(origin, dataset, asset, protectionBypassSecret) {
    const failures = [];
    const spec = MARINE_DATASET_CONTRACTS[dataset];
    const file = asset.file;
    const assetPath = `/api/${dataset}/${encodeURIComponent(file.filename)}`;
    let result;
    try {
        result = await getResponse(origin, assetPath, 'manual', MARINE_ASSET_MAX_BYTES, protectionBypassSecret);
    } catch (error) {
        return [
            `${assetPath}: immutable asset fetch failed for ${asset.slots.join(', ')} (${error instanceof Error ? error.message : error})`,
        ];
    }
    if (result.response.status !== 200) {
        return [
            `${assetPath}: HTTP ${result.response.status}, expected an immutable asset referenced by ${asset.slots.join(', ')}`,
        ];
    }
    const assetType = responseMediaType(result.response);
    if (assetType !== spec.contentType) {
        failures.push(`${assetPath}: content-type=${JSON.stringify(assetType)}, expected ${spec.contentType}`);
    }
    if (result.bytes.length !== file.bytes) {
        failures.push(`${assetPath}: served ${result.bytes.length} bytes, manifest declares ${file.bytes}`);
    }
    failures.push(...releaseProxyIntegrityFailures(result, assetPath, file.sha256));
    if (result.response.headers.get('x-thalassa-generation') !== asset.generation) {
        failures.push(`${assetPath}: X-Thalassa-Generation does not match ${asset.generation}`);
    }
    if (result.response.headers.get('cache-control') !== IMMUTABLE_ASSET_CACHE_CONTROL) {
        failures.push(`${assetPath}: immutable release asset cache policy is missing`);
    }
    if (result.response.headers.get('accept-ranges') !== 'none') {
        failures.push(`${assetPath}: immutable release asset must refuse partial-body authority`);
    }
    return failures;
}

export async function verifyHostedMarineDataset(origin, dataset, nowMs = Date.now(), protectionBypassSecret) {
    const failures = [];
    const spec = MARINE_DATASET_CONTRACTS[dataset];
    if (!spec) return [`unknown hosted marine dataset: ${dataset}`];

    const rawSettled = await Promise.allSettled(
        RAW_MANIFEST_SLOTS.map((slot) => fetchRawManifestSlot(dataset, slot, nowMs)),
    );
    const rawSlots = [];
    rawSettled.forEach((result, index) => {
        const slot = RAW_MANIFEST_SLOTS[index];
        if (result.status === 'fulfilled') rawSlots.push(result.value);
        else {
            failures.push(
                `${dataset} ${slot}: raw discovery slot is not independently valid (${result.reason instanceof Error ? result.reason.message : result.reason})`,
            );
        }
    });
    const rawBySlot = new Map(rawSlots.map((entry) => [entry.slot, entry]));
    if (rawSlots.length === RAW_MANIFEST_SLOTS.length) {
        const [left, right] = rawSlots;
        if (
            left.manifest.generation === right.manifest.generation &&
            immutableManifestCore(left.manifest) !== immutableManifestCore(right.manifest)
        ) {
            failures.push(`${dataset}: same-generation discovery slots disagree on immutable manifest content`);
        }
    }

    const manifestPath = `/api/${dataset}/manifest-v2.json?release-verifier=${nowMs}`;
    let manifestResult;
    try {
        manifestResult = await getResponse(
            origin,
            manifestPath,
            'manual',
            MARINE_MANIFEST_MAX_BYTES,
            protectionBypassSecret,
        );
    } catch (error) {
        failures.push(
            `${manifestPath}: virtual manifest fetch failed (${error instanceof Error ? error.message : error})`,
        );
        return failures;
    }
    if (manifestResult.response.status !== 200) {
        failures.push(`${manifestPath}: HTTP ${manifestResult.response.status}, expected a live schema-v2 manifest`);
        return failures;
    }
    const manifestType = responseMediaType(manifestResult.response);
    if (manifestType !== 'application/json') {
        failures.push(`${manifestPath}: content-type=${JSON.stringify(manifestType)}, expected application/json`);
    }
    if (manifestResult.response.headers.get('cache-control') !== 'no-store') {
        failures.push(`${manifestPath}: virtual discovery manifest must use Cache-Control: no-store`);
    }
    failures.push(...releaseProxyIntegrityFailures(manifestResult, manifestPath));
    if (manifestResult.response.headers.get('x-thalassa-valid-manifest-slots') !== '2') {
        failures.push(`${manifestPath}: both validated discovery slots must be populated before cutover`);
    }
    const selectedSlot = manifestResult.response.headers.get('x-thalassa-selected-manifest-slot');
    if (!RAW_MANIFEST_SLOTS.includes(selectedSlot ?? '')) {
        failures.push(`${manifestPath}: selected discovery slot header is missing or invalid`);
    }
    const exposedHeaders = new Set(
        (manifestResult.response.headers.get('access-control-expose-headers') ?? '')
            .split(',')
            .map((header) => header.trim().toLowerCase())
            .filter(Boolean),
    );
    for (const header of ['x-thalassa-valid-manifest-slots', 'x-thalassa-selected-manifest-slot']) {
        if (!exposedHeaders.has(header)) failures.push(`${manifestPath}: CORS does not expose ${header}`);
    }

    let manifest;
    try {
        manifest = JSON.parse(manifestResult.text);
    } catch (error) {
        failures.push(`${manifestPath}: invalid JSON (${error instanceof Error ? error.message : error})`);
        return failures;
    }
    failures.push(...hostedMarineManifestFailures(manifest, dataset, nowMs));
    if (
        typeof manifest.generation === 'string' &&
        manifestResult.response.headers.get('x-thalassa-generation') !== manifest.generation
    ) {
        failures.push(`${manifestPath}: X-Thalassa-Generation does not match the manifest`);
    }
    if (selectedSlot && rawBySlot.has(selectedSlot)) {
        const selectedRaw = rawBySlot.get(selectedSlot);
        if (sha256(manifestResult.bytes) !== sha256(selectedRaw.bytes)) {
            failures.push(
                `${manifestPath}: virtual manifest bytes do not match the independently fetched ${selectedSlot}`,
            );
        }
    }

    const distinctAssets = new Map();
    for (const raw of rawSlots) {
        for (const file of raw.manifest.files) {
            const existing = distinctAssets.get(file.filename);
            if (existing) {
                if (
                    existing.file.bytes !== file.bytes ||
                    existing.file.sha256 !== file.sha256 ||
                    existing.file.content_type !== file.content_type ||
                    existing.generation !== raw.manifest.generation
                ) {
                    failures.push(`${dataset}: immutable filename ${file.filename} conflicts between discovery slots`);
                } else {
                    existing.slots.push(raw.slot);
                }
            } else {
                distinctAssets.set(file.filename, {
                    file,
                    generation: raw.manifest.generation,
                    slots: [raw.slot],
                });
            }
        }
    }
    const assetFailureSets = await mapWithConcurrency([...distinctAssets.values()], HOSTED_ASSET_CONCURRENCY, (asset) =>
        verifyHostedMarineAsset(origin, dataset, asset, protectionBypassSecret),
    );
    failures.push(...assetFailureSets.flat());
    return failures;
}

async function verifyHostedDeployment(rawOrigin) {
    const origin = normalizeHostedOrigin(rawOrigin);
    const protectionBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
    if (protectionBypassSecret && !isTrustedThalassaVercelPreviewOrigin(origin)) {
        throw new Error('refusing to send the Vercel automation bypass secret to an untrusted preview origin');
    }
    const failures = [];
    const documentSpecs = [
        ['/', 'main'],
        ['/plan', 'main'],
        ['/plan/release-verification', 'main'],
        ['/release-verification/deep-route', 'main'],
        ['/logs/release-verification', 'logs'],
        ['/beta', 'beta'],
        ['/terms', 'terms'],
        ['/voyage-log-api', 'api'],
    ];
    const results = new Map();

    for (const [pathname, surface] of documentSpecs) {
        const result = await getResponse(
            origin,
            pathname,
            'manual',
            DEFAULT_RESPONSE_MAX_BYTES,
            protectionBypassSecret,
        );
        results.set(pathname, result);
        failures.push(...documentResponseFailures(result, surface, `hosted ${pathname}`, { hosted: true }));
    }

    const root = results.get('/');
    const rootLocation = root?.response.headers.get('location');
    const rootRedirect = rootLocation ? new URL(rootLocation, root.url) : null;
    if (
        root &&
        [301, 302, 303, 307, 308].includes(root.response.status) &&
        rootRedirect?.hostname === 'vercel.com' &&
        rootRedirect.pathname.startsWith('/sso-api')
    ) {
        throw new Error(
            'hosted deployment is protected by Vercel Authentication; configure the repository VERCEL_AUTOMATION_BYPASS_SECRET before release smoke',
        );
    }

    const rootHash = root ? sha256(root.bytes) : null;
    for (const pathname of ['/plan', '/plan/release-verification', '/release-verification/deep-route']) {
        if (rootHash && results.has(pathname) && sha256(results.get(pathname).bytes) !== rootHash) {
            failures.push(`hosted ${pathname}: SPA fallback does not serve the same application shell as /`);
        }
    }

    for (const pathname of ['/float', '/float/release-verification']) {
        const result = await getResponse(
            origin,
            pathname,
            'manual',
            DEFAULT_RESPONSE_MAX_BYTES,
            protectionBypassSecret,
        );
        const location = result.response.headers.get('location');
        const destination = new URL(location ?? '/', result.url);
        if (result.response.status !== 307 || destination.pathname !== '/logs') {
            failures.push(
                `hosted ${pathname}: expected temporary redirect to /logs, got HTTP ${result.response.status} ${location}`,
            );
        }
    }

    const scriptAsset = root ? extractAssetPaths(root.text).find((asset) => asset.endsWith('.js')) : undefined;
    if (!scriptAsset) failures.push('hosted application shell exposes no hashed JavaScript asset');
    else {
        const asset = await getResponse(
            origin,
            scriptAsset,
            'manual',
            DEFAULT_RESPONSE_MAX_BYTES,
            protectionBypassSecret,
        );
        if (asset.response.status !== 200 || asset.bytes.length < 100) {
            failures.push(`hosted ${scriptAsset}: JavaScript asset was not served successfully`);
        }
        const contentType = asset.response.headers.get('content-type') ?? '';
        if (!/javascript/i.test(contentType)) {
            failures.push(`hosted ${scriptAsset}: content-type=${JSON.stringify(contentType)}, expected JavaScript`);
        }
        const cacheControl = asset.response.headers.get('cache-control');
        if (cacheControl !== IMMUTABLE_ASSET_CACHE_CONTROL) {
            failures.push(
                `hosted ${scriptAsset}: cache-control=${JSON.stringify(cacheControl)}, expected ${IMMUTABLE_ASSET_CACHE_CONTROL}`,
            );
        }
        failures.push(...responseSecurityFailures(asset.response, `hosted ${scriptAsset}`));
    }

    const serviceWorker = await getResponse(
        origin,
        '/sw.js',
        'manual',
        DEFAULT_RESPONSE_MAX_BYTES,
        protectionBypassSecret,
    );
    if (serviceWorker.response.status !== 200 || !serviceWorker.text.includes('CACHE_NAME')) {
        failures.push('hosted /sw.js: real Thalassa service worker was not served');
    }
    if (serviceWorker.response.headers.get('cache-control') !== DOCUMENT_CACHE_CONTROL) {
        failures.push(`hosted /sw.js must use ${DOCUMENT_CACHE_CONTROL}`);
    }
    failures.push(...responseSecurityFailures(serviceWorker.response, 'hosted /sw.js'));

    const featureManifest = await getResponse(
        origin,
        `/${PUBLIC_BETA_FEATURE_ARTIFACT_FILE}`,
        'manual',
        DEFAULT_RESPONSE_MAX_BYTES,
        protectionBypassSecret,
    );
    if (featureManifest.response.status !== 200) {
        failures.push(`hosted /${PUBLIC_BETA_FEATURE_ARTIFACT_FILE}: HTTP ${featureManifest.response.status}`);
    } else {
        const contentType = featureManifest.response.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().includes('application/json')) {
            failures.push(
                `hosted /${PUBLIC_BETA_FEATURE_ARTIFACT_FILE}: content-type=${JSON.stringify(contentType)}, expected JSON`,
            );
        }
        try {
            failures.push(
                ...validatePublicBetaFeatureManifest(JSON.parse(featureManifest.text)).map(
                    (failure) => `hosted /${PUBLIC_BETA_FEATURE_ARTIFACT_FILE}: ${failure}`,
                ),
            );
        } catch (error) {
            failures.push(
                `hosted /${PUBLIC_BETA_FEATURE_ARTIFACT_FILE}: invalid JSON (${error instanceof Error ? error.message : error})`,
            );
        }
        failures.push(
            ...responseSecurityFailures(featureManifest.response, `hosted /${PUBLIC_BETA_FEATURE_ARTIFACT_FILE}`),
        );
    }

    for (const dataset of ENABLED_HOSTED_MARINE_DATASETS) {
        try {
            failures.push(...(await verifyHostedMarineDataset(origin, dataset, Date.now(), protectionBypassSecret)));
        } catch (error) {
            failures.push(
                `/api/${dataset}: hosted manifest/asset probe failed (${error instanceof Error ? error.message : error})`,
            );
        }
    }

    for (const layer of ['clouds', 'temperature']) {
        const pathname = `/api/owm-tile?layer=${layer}&z=0&x=0&y=0`;
        try {
            const result = await getResponse(
                origin,
                pathname,
                'manual',
                OWM_HOSTED_TILE_MAX_BYTES,
                protectionBypassSecret,
            );
            failures.push(...hostedOwmTileFailures(result, `hosted ${pathname}`));
        } catch (error) {
            failures.push(
                `${pathname}: hosted OWM proxy probe failed (${error instanceof Error ? error.message : error})`,
            );
        }
    }

    const retirementProbe = Date.now().toString(36);
    for (const pathname of RETIRED_LEGACY_MARINE_PATHS) {
        for (const candidate of [pathname, `${pathname}?release-verifier=${retirementProbe}`]) {
            try {
                const result = await getResponseHeaders(origin, candidate, protectionBypassSecret);
                failures.push(...legacyMarineRetirementFailures(result, `hosted ${candidate}`));
            } catch (error) {
                failures.push(
                    `hosted ${candidate}: legacy retirement probe failed (${error instanceof Error ? error.message : error})`,
                );
            }
        }
    }

    throwFailures('hosted deployment', failures);
}

function printHelp() {
    console.log(`Usage:
  node scripts/verify-web-release.mjs
  node scripts/verify-web-release.mjs --hosted https://deployment.example

Default mode requires a fresh dist/ and verifies it through Vite's local
production preview. Hosted mode verifies actual edge routing, headers, live
schema-v2 marine generations, redundant discovery slots and legacy retirement.`);
}

async function main(argv = process.argv.slice(2)) {
    if (argv.includes('--help') || argv.includes('-h')) {
        printHelp();
        return;
    }

    const hostedIndex = argv.indexOf('--hosted');
    if (hostedIndex !== -1 && (hostedIndex !== 0 || argv.length !== 2)) {
        throw new Error('--hosted must be followed by exactly one deployment origin');
    }
    if (hostedIndex === -1 && argv.length !== 0) throw new Error(`unknown arguments: ${argv.join(' ')}`);

    const configFailures = validateVercelConfig(readJson('vercel.json'));
    throwFailures('Vercel source contract', configFailures);
    console.log('✓ Vercel rewrites, redirects, security headers, and cache policy are declared');

    if (hostedIndex !== -1) {
        await verifyHostedDeployment(argv[1]);
        console.log(
            `✓ Hosted deployment enforces shell, live v2 marine generations, and bare/cache-busted legacy 410 retirement for ${ENABLED_HOSTED_MARINE_DATASETS.join(', ')}`,
        );
        return;
    }

    const artifacts = validateBuiltArtifacts();
    throwFailures('built web artifacts', artifacts.failures);
    console.log('✓ Fresh production documents reference real hashed assets');
    await verifyLocalPreview(artifacts);
    console.log('✓ Local production preview serves byte-identical documents, deep routes, redirects, and assets');
    console.log('ℹ Edge header enforcement is proved only by --hosted and runs after a successful deployment');
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
