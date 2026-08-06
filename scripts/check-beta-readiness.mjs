#!/usr/bin/env node

/**
 * Public-beta release contract.
 *
 * This is intentionally a source/artifact gate rather than another test
 * runner. It catches the release-only mistakes that unit tests cannot see:
 * mismatched phone/Watch versions, a live-reload URL left in Capacitor,
 * permissive ATS, missing privacy manifests/icons, a reintroduced unsafe
 * integration, or a production build made with incomplete public config.
 *
 * Usage:
 *   node scripts/check-beta-readiness.mjs --source-only   # CI-safe
 *   node scripts/check-beta-readiness.mjs                 # release env too
 *   node scripts/check-beta-readiness.mjs --artifacts     # after cap sync
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import {
    PUBLIC_BETA_ENDPOINT_KEYS,
    PUBLIC_BETA_FEATURE_ARTIFACT_FILE,
    PUBLIC_BETA_FEATURE_FLAG_KEYS,
    PUBLIC_BETA_HELD_CAPABILITIES,
    PUBLIC_BETA_REQUIRED_ABSENT_CLIENT_CONFIG,
    publicBetaFeatureArtifactFailures,
    readPublicBetaFeatureProfile,
} from './public-beta-feature-profile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ONLY = process.argv.includes('--source-only');
const CHECK_ARTIFACTS = process.argv.includes('--artifacts');
if (SOURCE_ONLY && CHECK_ARTIFACTS) {
    throw new Error('--source-only and --artifacts are mutually exclusive release-gate modes.');
}
const failures = [];
const passes = [];

function absolute(relative) {
    return path.join(ROOT, relative);
}

function read(relative) {
    try {
        return fs.readFileSync(absolute(relative), 'utf8');
    } catch {
        failures.push(`${relative}: required file is missing or unreadable`);
        return '';
    }
}

function exists(relative) {
    return fs.existsSync(absolute(relative));
}

function dependencyInstallConfigFiles() {
    const ignoredDirectories = new Set([
        '.git',
        '.claude',
        'node_modules',
        'docs',
        'dist',
        'coverage',
        'build',
        'Pods',
        'DerivedData',
    ]);
    const files = [];
    const visit = (directory, relativeDirectory = '') => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relative = path.join(relativeDirectory, entry.name);
            if (entry.isDirectory()) {
                if (!ignoredDirectories.has(entry.name)) visit(path.join(directory, entry.name), relative);
                continue;
            }
            if (
                entry.isFile() &&
                (entry.name === '.npmrc' ||
                    entry.name === 'Dockerfile' ||
                    entry.name === 'package.json' ||
                    relative.startsWith(path.join('.github', 'workflows') + path.sep))
            ) {
                files.push(relative);
            }
        }
    };
    visit(ROOT);
    return files.sort();
}

function repositorySourceTextEntries() {
    const ignoredDirectories = new Set([
        '.git',
        '.claude',
        '.vite-temp',
        'node_modules',
        'dist',
        'coverage',
        'build',
        'Pods',
        'DerivedData',
        'storybook-static',
    ]);
    const sourceExtensions = new Set([
        '.cjs',
        '.css',
        '.cts',
        '.env',
        '.example',
        '.html',
        '.js',
        '.json',
        '.jsx',
        '.md',
        '.mjs',
        '.mts',
        '.pbxproj',
        '.plist',
        '.py',
        '.sh',
        '.swift',
        '.toml',
        '.ts',
        '.tsx',
        '.yaml',
        '.yml',
    ]);
    const entries = [];
    const visit = (directory, relativeDirectory = '') => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relative = path.join(relativeDirectory, entry.name);
            if (relative.startsWith(path.join('ios', 'App', 'App', 'public') + path.sep)) continue;
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!ignoredDirectories.has(entry.name)) visit(target, relative);
                continue;
            }
            if (!entry.isFile()) continue;
            const extension = path.extname(entry.name).toLowerCase();
            if (!sourceExtensions.has(extension) && entry.name !== 'Dockerfile') continue;
            entries.push([relative, read(relative)]);
        }
    };
    visit(ROOT);
    return entries;
}

function regularFilesRecursively(root) {
    if (!fs.existsSync(root)) return [];

    const files = [];
    const visit = (directory, relativeDirectory = '') => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relative = path.join(relativeDirectory, entry.name);
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(target, relative);
            else if (entry.isFile()) files.push(relative);
        }
    };
    visit(root);
    return files.sort();
}

function sha256File(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Capacitor adds two native-only Cordova bridge files after copying `dist`.
 * Everything else must match exactly so a removed/stale chunk cannot survive
 * in the signed native bundle.
 */
function copiedArtifactMismatches(sourceRoot, copiedRoot) {
    const sourceFiles = regularFilesRecursively(sourceRoot);
    const mismatches = [];

    for (const relative of sourceFiles) {
        const source = path.join(sourceRoot, relative);
        const copied = path.join(copiedRoot, relative);
        try {
            if (!fs.existsSync(copied) || !fs.statSync(copied).isFile()) {
                mismatches.push(`missing:${relative}`);
            } else if (
                fs.statSync(source).size !== fs.statSync(copied).size ||
                sha256File(source) !== sha256File(copied)
            ) {
                mismatches.push(`different:${relative}`);
            }
        } catch {
            mismatches.push(`unreadable:${relative}`);
        }
    }

    const sourceFileSet = new Set(sourceFiles);
    const allowedNativeExtras = new Set(['cordova.js', 'cordova_plugins.js']);
    const unexpectedExtras = regularFilesRecursively(copiedRoot).filter(
        (relative) => !sourceFileSet.has(relative) && !allowedNativeExtras.has(relative),
    );

    return { sourceFiles, mismatches, unexpectedExtras };
}

function check(label, condition, detail = '') {
    if (condition) {
        passes.push(label);
        return;
    }
    failures.push(detail ? `${label}: ${detail}` : label);
}

function includesAll(source, values) {
    return values.every((value) => source.includes(value));
}

function includesInOrder(source, values) {
    let cursor = -1;
    for (const value of values) {
        cursor = source.indexOf(value, cursor + 1);
        if (cursor < 0) return false;
    }
    return true;
}

function workflowJobSource(source, jobName) {
    const lines = source.split(/\r?\n/);
    const start = lines.findIndex((line) => line === `    ${jobName}:`);
    if (start < 0) return '';

    const nextJob = lines.findIndex((line, index) => index > start && /^ {4}[A-Za-z0-9_-]+:\s*$/.test(line));
    return lines.slice(start, nextJob < 0 ? lines.length : nextJob).join('\n');
}

function workflowStepSource(source, namePrefix) {
    const lines = source.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trimStart().startsWith(`- name: ${namePrefix}`));
    if (start < 0) return '';

    const indentation = lines[start].match(/^\s*/)?.[0].length ?? 0;
    const nextStep = lines.findIndex(
        (line, index) => index > start && new RegExp(`^ {${indentation}}- (?:name|uses|run):`).test(line),
    );
    return lines.slice(start, nextStep < 0 ? lines.length : nextStep).join('\n');
}

function isPublishableSupabaseClientKey(value) {
    const key = String(value ?? '').trim();
    if (/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(key)) return true;
    const parts = key.split('.');
    if (parts.length !== 3) return false;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return payload?.role === 'anon';
    } catch {
        return false;
    }
}

function stripJsComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function plistBoolean(source, key, expected) {
    const expectedTag = expected ? String.raw`<true\s*/>` : String.raw`<false\s*/>`;
    return new RegExp(`<key>\\s*${key}\\s*<\\/key>\\s*${expectedTag}`).test(source);
}

function pngHeader(relative) {
    try {
        const bytes = fs.readFileSync(absolute(relative));
        if (bytes.length < 29 || bytes.toString('ascii', 1, 4) !== 'PNG') return null;
        return {
            width: bytes.readUInt32BE(16),
            height: bytes.readUInt32BE(20),
            colorType: bytes[25],
        };
    } catch {
        return null;
    }
}

const pkg = JSON.parse(read('package.json') || '{}');
const ciWorkflow = read('.github/workflows/ci.yml');
const lighthouseWorkflow = read('.github/workflows/lighthouse.yml');
const previewSmokeWorkflow = read('.github/workflows/preview-smoke.yml');
const vercelPreviewTrust = read('utils/vercelPreviewTrust.ts');
const primaryCiJob = workflowJobSource(ciWorkflow, 'check');
const releaseWorkflowSources = `${ciWorkflow}\n${lighthouseWorkflow}\n${previewSmokeWorkflow}`;
const workflowEntries = regularFilesRecursively(absolute('.github/workflows'))
    .filter((relative) => /\.ya?ml$/i.test(relative))
    .map((relative) => [
        path.join('.github', 'workflows', relative),
        read(path.join('.github', 'workflows', relative)),
    ]);
const workflowUseLineCount = workflowEntries.reduce(
    (total, [, source]) => total + (source.match(/^\s*(?:-\s*)?uses:\s*/gm) ?? []).length,
    0,
);
const workflowUseRecords = workflowEntries.flatMap(([relative, source]) =>
    [...source.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(?:\s+#\s*(\S.*?))?\s*$/gm)].map((match) => ({
        relative,
        target: match[1],
        versionComment: match[2] ?? '',
    })),
);
const reviewedWorkflowActionPins = new Map([
    ['actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'],
    ['actions/setup-node', '820762786026740c76f36085b0efc47a31fe5020'],
    ['actions/setup-python', '5fda3b95a4ea91299a34e894583c3862153e4b97'],
    ['actions/upload-artifact', '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'],
    ['actions/download-artifact', '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'],
    ['denoland/setup-deno', '22d081ff2d3a40755e97629de92e3bcbfa7cf2ed'],
    ['github/codeql-action/init', '5595ccaf912efad79be6eef63a5619ff05969be3'],
    ['github/codeql-action/autobuild', '5595ccaf912efad79be6eef63a5619ff05969be3'],
    ['github/codeql-action/analyze', '5595ccaf912efad79be6eef63a5619ff05969be3'],
]);
const workflowRunnerRecords = workflowEntries.flatMap(([relative, source]) =>
    [...source.matchAll(/^\s*runs-on:\s*([^\s#]+)\s*$/gm)].map((match) => ({ relative, runner: match[1] })),
);
const workflowsKeepExpectedWritePermissions = workflowEntries.every(([relative, source]) => {
    const executableSource = source.replace(/^\s*#.*$/gm, '');
    const actual = [...executableSource.matchAll(/([A-Za-z0-9_-]+):\s*write\b/g)].map((match) => match[1]).sort();
    const filename = path.basename(relative);
    const expected =
        filename === 'codeql.yml'
            ? ['security-events']
            : /^(?:cmems-(?:currents|waves|sst|chl|seaice|mld)|mpa)-pipeline\.yml$/.test(filename)
              ? ['contents']
              : [];
    return JSON.stringify(actual) === JSON.stringify(expected);
});
const lighthouseRunner = read('scripts/run-lighthouse-audit.mjs');
const webReleaseVerifier = read('scripts/verify-web-release.mjs');
const lighthouseConfig = read('lighthouserc.cjs');
const playwrightConfig = read('playwright.config.ts');
const denoLock = read('deno.lock');
const sourceTextEntries = repositorySourceTextEntries();
const legacyMapboxPublisherMarkers = [
    ['MAPBOX', 'UPLOAD', 'TOKEN'].join('_'),
    ['MAPBOX', 'USERNAME'].join('_'),
    ['VITE', 'MAPBOX', 'USERNAME'].join('_'),
    ['mapbox', 'tilesets'].join('-'),
    ['api.mapbox.com', 'tilesets', 'v1'].join('/'),
    ['api.mapbox.com', 'rasterarrays', 'v1'].join('/'),
    ['thalassa', 'currents', 'h'].join('-'),
];
const retiredMapboxTombstones = new Set([
    path.join('.github', 'workflows', 'cmems-currents-tile-probe.yml'),
    path.join('.github', 'workflows', 'cmems-currents-status.yml'),
]);
const legacyMapboxPublisherReferences = sourceTextEntries.flatMap(([relative, source]) =>
    legacyMapboxPublisherMarkers
        .filter((marker) => source.toLowerCase().includes(marker.toLowerCase()))
        .map((marker) => ({ relative, marker })),
);
const dependencyInstallConfigs = dependencyInstallConfigFiles();
const legacyPeerOverrideFiles = dependencyInstallConfigs.filter((relative) =>
    fs.readFileSync(absolute(relative), 'utf8').includes('legacy-peer-deps'),
);
const project = read('ios/App/App.xcodeproj/project.pbxproj');
const infoPlist = read('ios/App/App/Info.plist');
const capacitorSource = stripJsComments(read('capacitor.config.ts'));
const gemfile = read('ios/App/Gemfile');
const gemLock = read('ios/App/Gemfile.lock');
const podfile = read('ios/App/Podfile');
const podLock = read('ios/App/Podfile.lock');
const mainEntitlements = read('ios/App/App/App.entitlements');
const watchEntitlements = read('ios/App/ThalassaWatch Watch App/ThalassaWatch Watch App.entitlements');
const watchInfoPlist = read('ios/App/ThalassaWatch-Watch-App-Info.plist');
const mainPrivacy = read('ios/App/App/PrivacyInfo.xcprivacy');
const watchPrivacy = read('ios/App/ThalassaWatch Watch App/PrivacyInfo.xcprivacy');
const viteConfig = read('vite.config.ts');
const marineDevProxyBoundary = viteConfig.slice(
    viteConfig.indexOf('export const MARINE_PROXY_DATASETS'),
    viteConfig.indexOf('function releasePublicBetaFeatureManifest'),
);
const viteEnvironmentTypes = read('src/components/vite-env.d.ts');
const environmentExample = read('.env.example');
const webManifest = JSON.parse(read('manifest.json') || '{}');
const publicBetaFeatureProfile = readPublicBetaFeatureProfile(ROOT);
const expectedPublicBetaCredentialPresence = Object.fromEntries(
    publicBetaFeatureProfile.requiredCredentialPresence.map((name) => [name, true]),
);
const wxServerSource = read('services/weather/wxServer.ts');
const wxServerBoundaryTest = read('tests/WxServerPublicBetaBoundary.test.ts');
const aisDockerfile = read('workers/ais-ingest/Dockerfile');
const aisRailway = read('workers/ais-ingest/railway.toml');
const aisDockerignore = read('workers/ais-ingest/.dockerignore');
const aisTsconfig = read('workers/ais-ingest/tsconfig.json');
const piInstall = read('pi-cache/install.sh');
const piRedeploy = read('pi-cache/redeploy.sh');
const retiredVesselDockerfile = read('vessel-scraper/Dockerfile');
const retiredVesselRailway = read('vessel-scraper/railway.toml');
const retiredVesselPackage = JSON.parse(read('vessel-scraper/package.json') || '{}');
const retiredMapboxWorkflowEntries = [
    ['tile probe', read('.github/workflows/cmems-currents-tile-probe.yml')],
    ['status poll', read('.github/workflows/cmems-currents-status.yml')],
];
const linzWorkflow = read('.github/workflows/linz-msi-scrape.yml');
const linzScraper = read('scripts/linz-msi-scrape/scrape.mjs');
const linzPackage = JSON.parse(read('scripts/linz-msi-scrape/package.json') || '{}');
const linzLock = JSON.parse(read('scripts/linz-msi-scrape/package-lock.json') || '{}');
const mpaPopupSource = read('components/map/useMpaLayer.ts');
const radialHelmMenuSource = read('components/map/RadialHelmMenu.tsx');
const cmemsGridTrust = read('services/weather/api/cmemsGridTrust.ts');
const marineManifestContract = read('services/weather/api/marineManifestContract.ts');
const cmemsGridWrapperEntries = [
    ['currents', read('services/weather/api/currentsGrid.ts')],
    ['waves', read('services/weather/api/wavesGrid.ts')],
    ['sst', read('services/weather/api/sstGrid.ts')],
    ['chl', read('services/weather/api/chlGrid.ts')],
    ['seaice', read('services/weather/api/seaiceGrid.ts')],
    ['mld', read('services/weather/api/mldGrid.ts')],
];
const cmemsLayerSources = [
    read('components/map/useOceanCurrentParticleLayer.ts'),
    read('components/map/useOceanWaveParticleLayer.ts'),
    read('components/map/useSstRasterLayer.ts'),
    read('components/map/useChlRasterLayer.ts'),
    read('components/map/useSeaIceRasterLayer.ts'),
    read('components/map/useMldRasterLayer.ts'),
];
const cmemsGridRefresh = read('components/map/useCmemsGridRefresh.ts');
const cmemsPlaybackSource = read('components/map/useCmemsPlayback.ts');
const useWeatherLayersSource = read('components/map/useWeatherLayers.ts');
const mapWeatherControlsSource = read('components/map/MapWeatherControls.tsx');
const cmemsCurrentFieldSource = read('services/routing/env/CmemsCurrentField.ts');
const indexHtmlSource = read('index.html');
const nativeApiBaseSource = read('services/native/apiBase.ts');
const appShellCspSecurityTest = read('tests/AppShellCspSecurity.test.ts');
const indexCssSource = read('index.css');
const currentParticleLayerSource = read('components/map/CurrentParticleLayer.ts');
const waveParticleLayerSource = read('components/map/WaveParticleLayer.ts');
const cmemsRendererSources = [
    currentParticleLayerSource,
    waveParticleLayerSource,
    read('components/map/SstRasterLayer.ts'),
    read('components/map/ChlRasterLayer.ts'),
    read('components/map/SeaIceRasterLayer.ts'),
    read('components/map/MldRasterLayer.ts'),
];
const cmemsWebglSafetySource = read('components/map/cmemsWebglSafety.ts');
const cmemsRendererFailureTest = read('tests/CmemsRendererFailure.test.ts');
const marineLayerVisualContractTest = read('tests/MarineLayerVisualContract.test.ts');
const mpaDataset = read('services/weather/api/mpaDataset.ts');
const mpaLayer = read('components/map/MpaLayer.ts');
const mapHubSource = read('components/map/MapHub.tsx');
const marinePublisherTrustTest = read('tests/MarinePublisherTrust.test.ts');
const mpaLayerTrustTest = read('tests/MpaLayerTrust.test.ts');
const mpaSafetyLanguageTest = read('tests/MpaSafetyLanguage.test.ts');
const radialHelmMenuAccessibilityTest = read('tests/RadialHelmMenuAccessibility.test.tsx');
const cmemsGridRefreshTest = read('tests/CmemsGridRefresh.test.tsx');
const cmemsCurrentFieldTest = read('tests/cmemsCurrentField.test.ts');
const restoreActiveLayersTest = read('tests/restoreActiveLayers.test.ts');
const marinePublisherWorkflowEntries = [
    ['currents', read('.github/workflows/cmems-currents-pipeline.yml')],
    ['waves', read('.github/workflows/cmems-waves-pipeline.yml')],
    ['sst', read('.github/workflows/cmems-sst-pipeline.yml')],
    ['chl', read('.github/workflows/cmems-chl-pipeline.yml')],
    ['seaice', read('.github/workflows/cmems-seaice-pipeline.yml')],
    ['mld', read('.github/workflows/cmems-mld-pipeline.yml')],
    ['mpa', read('.github/workflows/mpa-pipeline.yml')],
];
const marineProducerSources = [
    read('scripts/cmems-currents-pipeline/pipeline.py'),
    read('scripts/cmems-waves-pipeline/pipeline.py'),
    read('scripts/cmems-sst-pipeline/pipeline.py'),
    read('scripts/cmems-chl-pipeline/pipeline.py'),
    read('scripts/cmems-seaice-pipeline/pipeline.py'),
    read('scripts/cmems-mld-pipeline/pipeline.py'),
    read('scripts/mpa-pipeline/pipeline.py'),
];
const marineCmemsProducerSources = marineProducerSources.slice(0, 6);
const mpaProducerSource = marineProducerSources[6];
const marinePublisherContract = read('scripts/publisher_contract.py');
const cmemsProducerContract = read('scripts/cmems_contract.py');
const isolatedDatasetPublisher = read('scripts/publish_dataset.py');
const cmemsRequirementsLock = read('scripts/cmems-requirements.lock');
const mpaRequirementsLock = read('scripts/mpa-pipeline/requirements.txt');
const marinePublisherContractTest = read('scripts/publisher-tests/test_contracts.py');
const marinePublisherSourceGateTest = read('scripts/publisher-tests/test_source_gates.py');
const mpaTransportTest = read('scripts/publisher-tests/test_mpa_transport.py');
const cmemsScienceTest = read('scripts/publisher-tests/test_cmems_science.py');
const waveMathTest = read('scripts/publisher-tests/test_wave_math.py');
const marinePublishFlowTest = read('scripts/publisher-tests/test_publish_flow.py');
const marinePublisherTestSources = [
    marinePublisherContractTest,
    marinePublisherSourceGateTest,
    mpaTransportTest,
    cmemsScienceTest,
    waveMathTest,
    marinePublishFlowTest,
];
const marinePublisherTestCount = marinePublisherTestSources.reduce(
    (count, source) => count + (source.match(/^\s*def test_/gm) ?? []).length,
    0,
);
const currentsPipelineReadme = read('scripts/cmems-currents-pipeline/README.md');
const wavesPipelineReadme = read('scripts/cmems-waves-pipeline/README.md');
const mpaPipelineReadme = read('scripts/mpa-pipeline/README.md');
const releaseAssetProxy = read('api/_releaseAssetProxy.ts');
const releaseAssetProxyTest = read('tests/ReleaseAssetProxy.test.ts');
const marineDevProxyContractTest = read('tests/MarineDevProxyContract.test.ts');
const marineVercelConfig = JSON.parse(read('vercel.json') || '{}');
const releaseAssetProxyWrapperEntries = [
    ['currents', read('api/currents/[file].ts')],
    ['waves', read('api/waves/[file].ts')],
    ['sst', read('api/sst/[file].ts')],
    ['chl', read('api/chl/[file].ts')],
    ['seaice', read('api/seaice/[file].ts')],
    ['mld', read('api/mld/[file].ts')],
    ['mpa', read('api/mpa/[file].ts')],
];
const publicBetaReleaseDossier = read('docs/PUBLIC_BETA_RELEASE.md');

// Version/build identity — the embedded Watch app must exactly match its host.
const marketingVersions = [...project.matchAll(/MARKETING_VERSION\s*=\s*([^;]+);/g)].map((match) => match[1].trim());
const buildNumbers = [...project.matchAll(/CURRENT_PROJECT_VERSION\s*=\s*([^;]+);/g)].map((match) => match[1].trim());
const uniqueMarketingVersions = new Set(marketingVersions);
const uniqueBuildNumbers = new Set(buildNumbers);
const iosDeploymentTargets = [...project.matchAll(/IPHONEOS_DEPLOYMENT_TARGET\s*=\s*([^;]+);/g)].map((match) =>
    match[1].trim(),
);
const uniqueIosDeploymentTargets = new Set(iosDeploymentTargets);
const ciTimeoutMinutes = Number.parseInt(ciWorkflow.match(/^\s*timeout-minutes:\s*(\d+)\s*$/m)?.[1] ?? '', 10);
check('package has a semantic beta version', /^\d+\.\d+\.\d+$/.test(pkg.version ?? ''));
check(
    'release and CI use a supported Node 24 LTS runtime',
    pkg.engines?.node === '24.x' &&
        read('.nvmrc').trim() === '24' &&
        primaryCiJob.includes('node-version: 24') &&
        lighthouseWorkflow.includes('node-version: 24') &&
        previewSmokeWorkflow.includes('node-version: 24') &&
        !/node-version:\s*(?:20|22)\b/.test(`${primaryCiJob}\n${lighthouseWorkflow}\n${previewSmokeWorkflow}`),
);
check(
    'CI gives the complete beta verification job at least 45 minutes',
    Number.isFinite(ciTimeoutMinutes) && ciTimeoutMinutes >= 45,
    `timeout-minutes=${Number.isFinite(ciTimeoutMinutes) ? ciTimeoutMinutes : 'missing'}`,
);
check(
    'CI blocks high and critical dependency vulnerabilities',
    ciWorkflow.includes('npm audit --audit-level=high') &&
        !/npm audit --audit-level=high\s*\|\||High-severity vulnerabilities found/.test(ciWorkflow),
);
check(
    'release workflows use strict lockfile installs without hidden peer overrides',
    [ciWorkflow, lighthouseWorkflow, previewSmokeWorkflow].every((workflow) => workflow.includes('run: npm ci')) &&
        ciWorkflow.includes('npm ls --all') &&
        legacyPeerOverrideFiles.length === 0,
    legacyPeerOverrideFiles.join(', '),
);
check(
    'GitHub Actions use reviewed immutable pins, fixed runners, explicit permissions, and exact Deno',
    workflowEntries.length > 0 &&
        workflowUseLineCount > 0 &&
        workflowUseRecords.length === workflowUseLineCount &&
        workflowUseRecords.every(({ target, versionComment }) => {
            const match = /^([^@\s]+)@([0-9a-f]{40})$/.exec(target);
            return (
                match !== null &&
                reviewedWorkflowActionPins.get(match[1]) === match[2] &&
                /^v\d+\.\d+\.\d+$/.test(versionComment)
            );
        }) &&
        workflowRunnerRecords.length > 0 &&
        workflowRunnerRecords.every(({ runner }) => runner === 'ubuntu-24.04') &&
        workflowEntries.every(([, source]) => /^permissions:\s*(?:\{\})?\s*$/m.test(source)) &&
        !workflowEntries.some(([, source]) => /\b(?:read-all|write-all)\b/.test(source.replace(/^\s*#.*$/gm, ''))) &&
        workflowsKeepExpectedWritePermissions &&
        ciWorkflow.includes('deno-version: v2.9.4') &&
        !ciWorkflow.includes('deno-version: v2.x') &&
        ciWorkflow.includes('supported Node LTS majors intentionally follow') &&
        !workflowEntries.some(([, source]) => source.includes('ubuntu-latest')),
    workflowUseRecords
        .filter(({ target, versionComment }) => {
            const match = /^([^@\s]+)@([0-9a-f]{40})$/.exec(target);
            return (
                match === null ||
                reviewedWorkflowActionPins.get(match[1]) !== match[2] ||
                !/^v\d+\.\d+\.\d+$/.test(versionComment)
            );
        })
        .map(({ relative, target }) => `${relative}:${target}`)
        .join(', '),
);
check('CI enforces repository formatting', ciWorkflow.includes('npm run format:check'));
check(
    'CI and beta shipping enforce route and bundle release gates',
    ciWorkflow.includes('npm run lint:routes') &&
        pkg.scripts?.['ship:beta']?.includes('npm run check:bundle') &&
        pkg.scripts?.['ship:beta']?.includes('npm run lint:routes'),
);
check(
    'CI production builds require the complete public client configuration',
    [ciWorkflow, lighthouseWorkflow].every((workflow) =>
        includesAll(workflow, [
            'VITE_SUPABASE_URL: ${{ vars.VITE_SUPABASE_URL }}',
            'VITE_SUPABASE_KEY: ${{ vars.VITE_SUPABASE_KEY }}',
            'VITE_MAPBOX_ACCESS_TOKEN: ${{ vars.VITE_MAPBOX_ACCESS_TOKEN }}',
            'VITE_OWM_API_KEY: ${{ vars.VITE_OWM_API_KEY }}',
            'VITE_SENTRY_DSN: ${{ vars.VITE_SENTRY_DSN }}',
            'VITE_APP_VERSION: ${{ vars.VITE_APP_VERSION }}',
            'npm run check:beta',
            'npm run build',
        ]),
    ),
);
check(
    'AIS production packaging is a locked multi-stage Node 22 compiled non-root image',
    includesInOrder(aisDockerfile, [
        'FROM node:22-slim AS build',
        'COPY package.json package-lock.json ./',
        'RUN npm ci --no-audit --no-fund',
        'COPY tsconfig.json ./',
        'RUN npm run build',
        'RUN npm prune --omit=dev --no-audit',
        'FROM node:22-slim AS runtime',
        'COPY --from=build /app/node_modules ./node_modules',
        'COPY --from=build /app/dist ./dist',
        'USER node',
        'CMD ["node", "dist/index.js"]',
    ]) &&
        !/\bnpm install\b/.test(aisDockerfile) &&
        includesAll(aisDockerignore, ['node_modules', 'dist', '.env', '.env.*']) &&
        includesAll(aisTsconfig, ['"*.test.ts"', '"vitest.config.ts"']) &&
        includesAll(aisRailway, [
            'builder = "DOCKERFILE"',
            'dockerfilePath = "Dockerfile"',
            'startCommand = "node dist/index.js"',
            'healthcheckPath = "/health"',
        ]) &&
        !/\b(?:NIXPACKS|tsx|ts-node)\b/.test(`${aisDockerfile}\n${aisRailway}`),
);
check(
    'Pi install and redeploy build from the lockfile then retain production dependencies only',
    includesInOrder(piInstall, [
        'npm ci --prefix "$INSTALL_DIR" --no-audit --no-fund',
        'npm run build --prefix "$INSTALL_DIR"',
        'npm prune --omit=dev --prefix "$INSTALL_DIR" --no-audit',
    ]) &&
        includesInOrder(piRedeploy, [
            'npm ci --silent --no-audit --no-fund',
            'npm run build --silent',
            'npm prune --omit=dev --silent --no-audit',
            'systemctl restart',
        ]) &&
        !/\bnpm install\b/.test(`${piInstall}\n${piRedeploy}`),
);
check(
    'retired Railway vessel scraper has no runnable build, start, or cron path',
    includesInOrder(retiredVesselDockerfile, [
        'FROM node:20-alpine',
        'vessel-scraper is retired; do not deploy',
        'exit 78',
    ]) &&
        includesAll(retiredVesselRailway, [
            'builder = "DOCKERFILE"',
            'dockerfilePath = "Dockerfile"',
            'watchPatterns = ["RETIRED_DO_NOT_DEPLOY"]',
        ]) &&
        !/\b(?:cronSchedule|startCommand|buildCommand)\b/.test(retiredVesselRailway) &&
        retiredVesselPackage.private === true &&
        retiredVesselPackage.scripts?.start?.includes('process.exit(78)') &&
        !Object.hasOwn(retiredVesselPackage.scripts ?? {}, 'dev'),
);
check(
    'retired Mapbox currents debug workflows are inert and cannot access secrets or networks',
    retiredMapboxWorkflowEntries.every(
        ([, workflow]) =>
            includesAll(workflow, [
                'workflow_dispatch:',
                'permissions: {}',
                'runs-on: ubuntu-24.04',
                'timeout-minutes: 1',
                'exit 78',
            ]) &&
            (workflow.match(/^\s*permissions:\s*\{\}\s*$/gm) ?? []).length === 2 &&
            !/\b(?:schedule|push|pull_request):/.test(workflow) &&
            !/\b(?:env|uses):/.test(workflow) &&
            !/\$\{\{|secrets\.|MAPBOX_|api\.mapbox\.com|https?:\/\/|\bcurl\b/.test(workflow),
    ),
);
check(
    'retired CMEMS Mapbox publisher has no credential, config, endpoint, or instruction surface',
    legacyMapboxPublisherReferences.every(({ relative }) => retiredMapboxTombstones.has(relative)) &&
        environmentExample.includes('VITE_MAPBOX_ACCESS_TOKEN=') &&
        viteEnvironmentTypes.includes('VITE_MAPBOX_ACCESS_TOKEN') &&
        !legacyMapboxPublisherMarkers.some((marker) => viteEnvironmentTypes.includes(marker)),
    legacyMapboxPublisherReferences.map(({ relative, marker }) => `${relative}:${marker}`).join(', '),
);
const linzBrowserEnvironmentBoundary = linzScraper.slice(
    linzScraper.indexOf('const BROWSER_ENV_ALLOWLIST'),
    linzScraper.indexOf('export function buildBrowserEnvironment'),
);
check(
    'LINZ MSI writer is locked, non-cancelling, secret-isolated, and fail-closed before persistence',
    includesAll(linzWorkflow, [
        "cron: '17 */6 * * *'",
        'permissions:',
        'contents: read',
        'group: linz-msi-scrape',
        'cancel-in-progress: false',
        "if: github.ref == 'refs/heads/master'",
        "node-version: '22'",
        'cache-dependency-path: scripts/linz-msi-scrape/package-lock.json',
    ]) &&
        includesInOrder(linzWorkflow, [
            'run: npm ci',
            'run: npm audit --audit-level=high',
            'run: npm ls --all',
            'run: npm test',
            'run: npx --no-install playwright install chromium --with-deps',
            'SUPABASE_SERVICE_ROLE_KEY:',
            'run: node scrape.mjs',
        ]) &&
        (linzWorkflow.match(/SUPABASE_SERVICE_ROLE_KEY:/g) ?? []).length === 1 &&
        !linzWorkflow.includes("github.event_name == 'workflow_dispatch' ||") &&
        linzPackage.engines?.node === '22.x' &&
        linzLock.lockfileVersion === 3 &&
        /^\d+\.\d+\.\d+$/.test(linzLock.packages?.['node_modules/@supabase/supabase-js']?.version ?? '') &&
        /^\d+\.\d+\.\d+$/.test(linzLock.packages?.['node_modules/playwright']?.version ?? '') &&
        includesAll(linzScraper, [
            'chromiumSandbox: true',
            'env: browserEnv',
            'const writeCredentials = dryRun ? null : validateWriteEnvironment(env);',
            'page in-force timestamp is stale; refusing database changes',
            'duplicate warning IDs found',
            'write preflight failed',
            'maxCountDropFraction: 0.5',
            'DRY_RUN=1 — skipping DB write',
        ]) &&
        !linzBrowserEnvironmentBoundary.includes('SUPABASE_URL') &&
        !linzBrowserEnvironmentBoundary.includes('SUPABASE_SERVICE_ROLE_KEY'),
);
check(
    'MPA popup presents inferred classes, authority verification, focus return, and a 44px dismiss target',
    includesAll(mpaPopupSource, [
        'Inferred high-protection class',
        'Inferred conditional-protection class',
        'Inferred multiple-use class',
        "tone: '#f87171'",
        "tone: '#fbbf24'",
        "tone: '#60a5fa'",
        'Verify current fishing and anchoring rules with the managing authority',
        'not legal advice and not for navigation',
        '<div style="font-size: 11px; color: #cbd5e1; padding-top: 6px;',
        '<div style="font-size: 11px; color: #b6c2d1; margin-top: 6px; font-style: italic;">',
        '.mpa-popup-close:focus-visible',
        'aria-label="Close"',
        'width: 44px',
        'height: 44px',
        "popup.on('close', () => map.getCanvas().focus())",
        'closeBtn.focus()',
    ]) &&
        includesAll(indexCssSource, [
            '.mpa-popup .mapboxgl-popup-content {',
            'color: #f3f4f6;',
            'background: rgba(15, 23, 42, 0.97) !important;',
        ]) &&
        !mpaPopupSource.includes('No fishing, collecting, or extraction permitted') &&
        !mpaPopupSource.includes('Recreational fishing usually permitted') &&
        includesAll(mpaSafetyLanguageTest, [
            'never turns indicative CAPAD class %s into permission',
            'uses readable class and metadata tones on the dark popup surface',
            'preserves tiny positive official areas instead of rounding them to zero',
            'puts the verified CAPAD snapshot date beside the authority warning',
        ]),
);
const radialHelmMpaBlock = radialHelmMenuSource.slice(
    radialHelmMenuSource.indexOf('if (TACTICAL_REFERENCE_ITEMS_VISIBLE && tacticalState?.onToggleMpa)'),
    radialHelmMenuSource.indexOf('if (tacticalState?.onToggleWeatherInspect)'),
);
const mapHubMpaToggleBlock = mapHubSource.slice(
    mapHubSource.indexOf('// CAPAD protected-area context belongs with map'),
    mapHubSource.indexOf('// Routes — picker for saved planned passages'),
);
check(
    'MPA helm control stays neutral about access, anchoring, and fishing rules',
    includesAll(radialHelmMpaBlock, [
        "id: 'mpa'",
        'CAPAD identifies protected-area boundaries',
        'does not itself',
        'determine whether entry, anchoring, fishing or another activity',
        'is prohibited at the selected position',
        "label: 'MPA'",
    ]) &&
        !radialHelmMpaBlock.includes("label: 'No-Go'") &&
        !radialHelmMpaBlock.includes("label: 'No Go'"),
);
check(
    'feature-gated MPA overlay has a reachable neutral map control',
    includesAll(mapHubMpaToggleBlock, [
        'CAPAD protected-area context belongs with map',
        'popup remains explicitly indicative',
        'requires users to verify current rules',
        '...(isMpaEnabled()',
        "id: 'mpa'",
        "label: 'MPAs'",
        'enabled: weather.mpaVisible',
        'onToggle: () => weather.setMpaVisible(!weather.mpaVisible)',
    ]) &&
        !mapHubMpaToggleBlock.includes("label: 'No-Go'") &&
        !mapHubMpaToggleBlock.includes("label: 'No Go'") &&
        includesAll(radialHelmMenuAccessibilityTest, [
            'exposes a neutral MPA toggle in the mixed map-items category',
            "name: 'Map items'",
            "name: 'MPAs, off'",
            'expect(onToggleMpa).toHaveBeenCalledOnce()',
        ]),
);
const cmemsBoundedReadBoundary = cmemsGridTrust.slice(
    cmemsGridTrust.indexOf('export async function readBoundedResponse'),
    cmemsGridTrust.indexOf('export async function fetchBoundedPublisherBytes'),
);
const cmemsHashBoundary = cmemsGridTrust.slice(
    cmemsGridTrust.indexOf('export async function sha256Hex'),
    cmemsGridTrust.indexOf('export async function publisherGenerationSuffix'),
);
const cmemsFrameFetchBoundary = cmemsGridTrust.slice(
    cmemsGridTrust.indexOf('export async function fetchCmemsGrid'),
    cmemsGridTrust.indexOf('function canonicalJson'),
);
const cmemsTimingBoundary = useWeatherLayersSource.slice(
    useWeatherLayersSource.indexOf('// ── CMEMS Now-alignment helpers'),
    useWeatherLayersSource.indexOf('// ── Pressure scrubber:'),
);
const cmemsExclusivityBoundary = useWeatherLayersSource.slice(
    useWeatherLayersSource.indexOf('export function enforceCmemsMarineExclusivity'),
    useWeatherLayersSource.indexOf('/**\n * Which layers a stored preference should restore.'),
);
const cmemsRoutingRemoteBoundary = cmemsCurrentFieldSource.slice(
    cmemsCurrentFieldSource.indexOf('export async function getCurrentField'),
);
check(
    'CMEMS maps fetch one verified frame with bounded ownership while routing remains no-network',
    cmemsGridWrapperEntries.every(
        ([dataset, source]) =>
            includesAll(source, [
                "from './cmemsGridTrust'",
                `fetchCmemsManifest('${dataset}')`,
                `fetchCmemsGrid('${dataset}', step)`,
                `releaseCmemsGrid('${dataset}')`,
            ]) && !/\bfetch\s*\(/.test(source),
    ) &&
        includesAll(cmemsGridTrust, [
            'export const MANIFEST_MAX_BYTES = 256 * 1024',
            'export const CMEMS_ASSET_MAX_BYTES = 16 * 1024 * 1024',
            'export const CMEMS_CACHE_TTL_MS = 5 * 60 * 1000',
            'export const CMEMS_FRAME_CACHE_LIMIT = 2',
            'export const CMEMS_FRAME_CACHE_MAX_BYTES = 32 * 1024 * 1024',
            '`${API_BASE}/${dataset}/manifest-v2.json`',
            'value.schema_version === 2',
            'const exactBytes = THCU_HEADER_BYTES + cellCount * 9',
            'bytes.byteLength === THCU_HEADER_BYTES + cells * 9',
            'Number.isFinite(uValue)',
            'Number.isFinite(vValue)',
            'mask === 0 || mask === 1',
            'await verifyPublisherAsset(bytes, file.bytes, file.sha256',
            "const retainV = kind === 'vector' || kind === 'waves'",
            'const v = retainV ? new Float32Array(cells) : undefined',
            'speed: new Array<Float32Array>(totalSteps)',
            'export function releaseCmemsGrid(dataset:',
            'for (const controller of controllers) controller.abort(',
            'let loadQueue: Promise<void> = Promise.resolve()',
            'export function getCmemsGridCacheStats()',
            'frameBytes + maskBytes',
            'assertCmemsFrameMemoryBudget(manifest)',
            'sourceStep?: number',
            'sourceStep,',
        ]) &&
        !cmemsGridTrust.includes('/manifest.json') &&
        includesAll(cmemsBoundedReadBoundary, [
            'const output = new Uint8Array(maxBytes)',
            'requireTrust(total + value.byteLength <= maxBytes',
            'output.set(value, total)',
            'return total === output.byteLength ? output : output.slice(0, total)',
        ]) &&
        !cmemsBoundedReadBoundary.includes('const chunks') &&
        !cmemsBoundedReadBoundary.includes('new Uint8Array(total)') &&
        includesAll(cmemsHashBoundary, [
            'bytes.byteOffset === 0',
            'bytes.byteLength === bytes.buffer.byteLength',
            '? (bytes as Uint8Array<ArrayBuffer>)',
            ': bytes.slice()',
        ]) &&
        !cmemsHashBoundary.includes('bytes.buffer.slice(') &&
        includesAll(cmemsFrameFetchBoundary, [
            'const file = manifest.files[requestedStep]',
            'Math.min(file.bytes, CMEMS_ASSET_MAX_BYTES)',
            "'force-cache'",
            'new Map([[requestedStep, decoded]])',
            'trustedMask, nowMs, requestedStep',
            'frameCache.set(key, entry)',
            'enforceFrameCacheBounds()',
        ]) &&
        !/for\s*\([^)]*(?:of|in)\s+manifest\.files/.test(cmemsFrameFetchBoundary) &&
        !/Promise\.all\s*\(/.test(cmemsFrameFetchBoundary) &&
        includesInOrder(cmemsGridTrust, [
            'while (frameCache.size > CMEMS_FRAME_CACHE_LIMIT || retained() > CMEMS_FRAME_CACHE_MAX_BYTES)',
            'deleteFrameAndOrphanMask(oldestKey)',
        ]) &&
        cmemsLayerSources.every(
            (source) => source.includes('useCmemsGridRefresh(') && source.includes('grid.sourceStep !=='),
        ) &&
        includesAll(cmemsGridRefresh, [
            'verifiedAt + CMEMS_CACHE_TTL_MS - now',
            'Math.min(untilCoverageEnd, untilTtl)',
            'requestedStep: number',
            'fetchGrid: (step: number)',
            'releaseGrid: () => void',
            'prepareForFrame: () => boolean',
            "publish('loading', attempt)",
            'if (isRefresh) releaseGrid()',
            'if (!prepareForFrame())',
            'next = await fetchGrid(step)',
            'next.sourceStep !== step',
            'clearTimeout(timer)',
            'releaseGrid()',
        ]) &&
        includesInOrder(cmemsGridRefresh, [
            "publish('loading', attempt)",
            'if (isRefresh) releaseGrid()',
            'await new Promise<void>((resolve) => setTimeout(resolve, 0))',
            'if (!prepareForFrame())',
            'next = await fetchGrid(step)',
            "publish('ready', attempt, next)",
            'scheduleRefresh(next)',
        ]) &&
        includesAll(cmemsTimingBoundary, [
            'fetchCurrentsManifest',
            'fetchWavesManifest',
            'fetchSstManifest',
            'fetchChlManifest',
            'fetchSeaIceManifest',
            'fetchMldManifest',
        ]) &&
        !/fetch(?:Currents|Waves|Sst|Chl|SeaIce|Mld)Grid/.test(cmemsTimingBoundary) &&
        includesAll(cmemsExclusivityBoundary, [
            'SEA_STATE_LAYERS.filter((layer) => next.has(layer))',
            'if (activeMarine.length <= 1) return next',
            'if (layer !== keep) next.delete(layer)',
        ]) &&
        includesAll(useWeatherLayersSource, [
            'const currentsTotalHours = CMEMS_DATASETS.currents.steps;',
            'const wavesTotalHours = CMEMS_DATASETS.waves.steps;',
            'const sstTotalSteps = CMEMS_DATASETS.sst.steps;',
            'const chlTotalSteps = CMEMS_DATASETS.chl.steps;',
            'const seaiceTotalSteps = CMEMS_DATASETS.seaice.steps;',
            'const mldTotalSteps = CMEMS_DATASETS.mld.steps;',
        ]) &&
        includesAll(cmemsPlaybackSource, [
            'if (!isCmemsRenderedStepReady(config.status, step)) return;',
            'if (next >= config.totalSteps)',
        ]) &&
        [
            'currentsTotalHours',
            'wavesTotalHours',
            'sstTotalSteps',
            'chlTotalSteps',
            'seaiceTotalSteps',
            'mldTotalSteps',
        ].every((timeline) => mapHubSource.includes(`totalSteps: weather.${timeline},`)) &&
        mapHubSource.includes('useCmemsAutoplay(activeCmemsPlayback);') &&
        mapWeatherControlsSource.includes('totalFrames = weather.currentsTotalHours;') &&
        includesAll(marinePublisherTrustTest, [
            'rejects truncated, huge, non-finite, implausible and bad-mask payloads',
            'verifies asset bytes and SHA-256',
            'caps streamed bodies in one bounded allocation',
            'mirrors an already-aborted caller signal before starting a publisher fetch',
            'mixedGeneration',
            'uses an immutable-core identity but permits fresh publication evidence for the same generation',
            'enforces a bounded one-frame decoder and two-frame LRU ownership contract',
            'derives every CMEMS scrubber count from the inclusive manifest contract with load-aware playback',
        ]) &&
        includesAll(cmemsGridRefreshTest, [
            'clears and releases a prior frame when the bounded-TTL refresh fails',
            'releases decoded ownership immediately when the layer is hidden',
            'releases an obsolete frame before loading a new scrubber step',
        ]) &&
        restoreActiveLayersTest.includes('allows only one decoded CMEMS marine product to be owned at a time') &&
        includesAll(cmemsCurrentFieldSource, [
            'export const CMEMS_CURRENT_ROUTING_BETA_ENABLED = false',
            '!grid.landMask ||',
            'grid.landMask.length !== grid.width * grid.height',
            'interpolationTouchesLand(',
            'weight > 0 && mask[index] !== 0',
        ]) &&
        includesAll(cmemsRoutingRemoteBoundary, [
            'if (!CMEMS_CURRENT_ROUTING_BETA_ENABLED) return null',
            'return null',
        ]) &&
        !/\bfetch\s*\(/.test(cmemsRoutingRemoteBoundary) &&
        includesAll(cmemsCurrentFieldTest, [
            'fails closed without an exact-size verified land mask',
            'rejects masked nonzero-weight coast corners but preserves exact ocean corners',
            'returns null without performing any network request',
            'also resolves null immediately for an already-aborted caller',
        ]),
);
check(
    'global current and wave trails are device-tiered with bounded persistent GPU ownership',
    [currentParticleLayerSource, waveParticleLayerSource].every((source) =>
        includesAll(source, [
            "import { particleScale } from '../../utils/deviceTier'",
            'Math.round(80000 * particleScale())',
            'const TRAIL_LENGTH = 20;',
        ]),
    ) &&
        includesAll(marineLayerVisualContractTest, [
            'tiers both global vector layers and bounds their persistent trail ownership',
            "'components/map/CurrentParticleLayer.ts', 'components/map/WaveParticleLayer.ts'",
            'Math.round(80000 * particleScale())',
            'const TRAIL_LENGTH = 20;',
        ]),
);
check(
    'every CMEMS renderer fails closed on incomplete WebGL resources, malformed frames, and upload errors',
    includesAll(cmemsWebglSafetySource, [
        'export function requireWebGlResource',
        'export function requireWebGlAttribute',
        'export function requireWebGlUniform',
        'export function beginWebGlOperation',
        'export function proveWebGlOperation',
        "return 'OUT_OF_MEMORY'",
        'export function createWebGlProgram',
        'if (program) gl.deleteProgram(program)',
        'if (vertexShader) gl.deleteShader(vertexShader)',
        'if (fragmentShader) gl.deleteShader(fragmentShader)',
    ]) &&
        cmemsRendererSources.every((source) =>
            includesAll(source, [
                "from './cmemsWebglSafety'",
                "'initialisation'",
                'requireWebGlResource(',
                'proveWebGlOperation(',
                'renderer is not fully initialised',
                'mismatch',
                'texture upload',
                'this.dataValid = true',
                '!this.dataValid',
            ]),
        ) &&
        [currentParticleLayerSource, waveParticleLayerSource].every((source) =>
            includesAll(source, [
                'requireWebGlResource(',
                'particle vertex array',
                'particle vertex array setup',
                'this.ensureCpuParticleState();',
                'this.releaseCpuOwnership();',
            ]),
        ) &&
        includesAll(cmemsRendererFailureTest, [
            "describe.each(RENDERERS)('$name CMEMS renderer failure contract'",
            'throws on malformed frame dimensions instead of silently accepting them',
            'rejects a null buffer and makes partial onAdd cleanup idempotent',
            'rejects a null texture and releases all resources allocated earlier in onAdd',
            'turns WebGL OUT_OF_MEMORY during a texture upload into a data-load failure',
            'expect(state.trailData).toHaveLength(0)',
            'expect(state.particleAges).toHaveLength(0)',
            'recreates released particle CPU buffers when a later texture upload succeeds',
            'rejects a null WebGL2 vertex array instead of claiming a complete particle renderer',
            "it.each(RENDERERS)('$name detects OUT_OF_MEMORY during initial buffer upload'",
        ]),
);
const mpaImmutableIdentityBoundary = mpaDataset.slice(mpaDataset.indexOf('function immutableManifestIdentity'));
const mpaFailClosedBoundary = mpaPopupSource.slice(
    mpaPopupSource.indexOf('const failClosed'),
    mpaPopupSource.indexOf('const revalidate'),
);
const mpaRevalidateBoundary = mpaPopupSource.slice(
    mpaPopupSource.indexOf('const revalidate'),
    mpaPopupSource.indexOf('return () =>', mpaPopupSource.indexOf('const revalidate')),
);
const mpaHookCleanupBoundary = mpaPopupSource.slice(
    mpaPopupSource.indexOf('return () =>', mpaPopupSource.indexOf('const revalidate')),
    mpaPopupSource.indexOf('/** Exposed so the legend'),
);
const mpaDatasetOwnershipBoundary = mpaDataset.slice(
    mpaDataset.indexOf('let cache: MpaCacheEntry | null = null'),
    mpaDataset.indexOf('function canonicalJson'),
);
check(
    'MPA client validates one bounded immutable asset, releases ownership, and aborts stale work before Mapbox',
    includesAll(mpaDataset, [
        'export const MPA_ASSET_MAX_BYTES = 16 * 1024 * 1024',
        'export const MPA_CACHE_TTL_MS = 30 * 60 * 1000',
        'value.schema_version === 2',
        'value.dimensions.feature_count',
        '`${API_BASE}/mpa/manifest-v2.json`',
        'await verifyPublisherAsset(asset, file.bytes, file.sha256',
        'validateMpaGeoJson(decodeUtf8Json(asset), manifest)',
        'finiteNumber(value.bounds.west, 70, 120',
        'finiteNumber(value.bounds.east, 145, 180',
        'finiteNumber(value.bounds.south, -60, -35',
        'finiteNumber(value.bounds.north, -15, 0',
        'requireTrust(feature.properties.area_km2 > 0',
        'cache = null',
        'cache.publishedAt = manifest.published_at',
        "'force-cache'",
    ]) &&
        !mpaDataset.includes('/manifest.json') &&
        cmemsGridTrust.includes("cache: RequestCache = 'no-store'") &&
        includesInOrder(mpaDatasetOwnershipBoundary, [
            'export function releaseMpaDataset(): void',
            'ownershipEpoch += 1',
            'cache = null',
            'pending = null',
            "activeController?.abort(new Error('MPA layer released'))",
            'activeController = null',
        ]) &&
        includesAll(mpaDatasetOwnershipBoundary, [
            'if (signal?.aborted) return null',
            'const onAbort = () => controller.abort(signal?.reason)',
            'requireTrust(ownershipEpoch === epoch && !signal.aborted',
            'requireActiveOwnership(epoch, signal)',
        ]) &&
        includesAll(mpaImmutableIdentityBoundary, [
            'dataset: manifest.dataset',
            'generation: manifest.generation',
            'files: manifest.files',
        ]) &&
        !['generated_at', 'published_at', 'producer'].some((field) => mpaImmutableIdentityBoundary.includes(field)) &&
        includesAll(mpaLayer, [
            'const verifiedData = alreadyVerifiedData ?? (await fetchVerifiedMpaGeoJson())',
            'data: verifiedData',
        ]) &&
        !mpaLayer.includes('data: MPA_GEOJSON_URL') &&
        includesInOrder(mpaFailClosedBoundary, ['teardown()', 'onVisibilityChange?.(false)']) &&
        includesAll(mpaRevalidateBoundary, [
            'let successful = false',
            'const data = await fetchVerifiedMpaGeoJson(requestController.signal, (nextGeneration) => {',
            'unmountPresentation()',
            "failClosed('MPA layer remains off because its trust refresh failed')",
            'const generationChanged = mountedRef.current && generationRef.current !== generation',
            "failClosed('MPA style or trust refresh failed closed', error)",
            'if (successful && !cancelled)',
            'setTimeout(() => void revalidate(), MPA_CACHE_TTL_MS + 100)',
        ]) &&
        includesInOrder(mpaDatasetOwnershipBoundary, [
            'beforeGenerationAsset?.(manifest.generation)',
            'cache = null',
            'const file = manifest.files[0]',
            'const asset = await fetchBoundedPublisherBytes(',
        ]) &&
        includesInOrder(mpaHookCleanupBoundary, [
            'cancelled = true',
            "requestController.abort(new Error('MPA layer hidden or unmounted'))",
            'clearTimeout(timer)',
            'teardown()',
        ]) &&
        mpaPopupSource.includes('if (handlersRef.current.click) return') &&
        mapHubSource.includes(
            'useMpaLayer(mapRef, mapReady, weather.mpaVisible && !planningSurface, weather.setMpaVisible)',
        ) &&
        includesAll(mpaPopupSource, ['Dataset snapshot:', 'export function formatMpaSourceDate', 'areaValue > 0']) &&
        includesAll(mpaLayerTrustTest, [
            'does not add a source or layer when verification fails',
            'hands Mapbox only an already verified in-memory object, never a URL',
            'periodically revalidates while visible, tears down on null, and guards handler attachment',
            'releaseMpaDataset()',
            'requestController.abort(',
            'closeBtn.focus()',
            'uses a readable dark surface and unmounts the old generation before replacement allocation',
            'beforeGenerationAsset?.(manifest.generation)',
        ]) &&
        includesAll(mpaSafetyLanguageTest, [
            'preserves tiny positive official areas instead of rounding them to zero',
            'puts the verified CAPAD snapshot date beside the authority warning',
        ]) &&
        includesAll(marinePublisherTrustTest, [
            'clears a previously verified overlay when its 30-minute refresh fails',
            'accepts fresh health evidence for an unchanged immutable generation and updates cached publication status',
            'cannot repopulate parsed GeoJSON after the overlay releases during a fetch',
        ]),
);
check(
    'marine publishers use reviewed-master, run-stable sealed artifacts and an isolated dual-slot writer',
    marinePublisherWorkflowEntries.every(([dataset, workflow]) => {
        const generateJob = workflowJobSource(workflow, 'generate');
        const publishJob = workflowJobSource(workflow, 'publish');
        const actionRefs = [...workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)].map((match) => match[1]);
        const runStableArtifactName = `${dataset}-\${{ github.run_id }}`;
        const attemptedArtifactName = `${runStableArtifactName}-\${{ github.run_attempt }}`;
        return (
            includesAll(workflow, [
                'runs-on: ubuntu-24.04',
                "python-version: '3.11.15'",
                'cancel-in-progress: false',
                'persist-credentials: false',
                '--require-hashes --only-binary=:all:',
                'Run offline publisher',
                'Generate and validate immutable bundle',
                'Seal generated bundle as workflow artifact',
                'Restore sealed bundle',
                'overwrite: true',
            ]) &&
            workflow.split(runStableArtifactName).length - 1 >= 2 &&
            !workflow.includes(attemptedArtifactName) &&
            !workflow.includes('3.11.11') &&
            (workflow.match(/if: github\.ref == 'refs\/heads\/master'/g) ?? []).length === 2 &&
            actionRefs.length >= 5 &&
            actionRefs.length === (workflow.match(/^\s*uses:/gm) ?? []).length &&
            actionRefs.every((ref) => /^[0-9a-f]{40}$/.test(ref)) &&
            includesAll(generateJob, ['contents: read']) &&
            !generateJob.includes('contents: write') &&
            includesAll(publishJob, [
                'contents: write',
                `python scripts/publish_dataset.py --dataset ${dataset} --bundle /tmp/publisher-bundle`,
            ]) &&
            !publishJob.includes('pip install') &&
            !publishJob.includes('COPERNICUS_') &&
            workflow.indexOf('Run offline publisher') < workflow.indexOf('Generate and validate immutable bundle')
        );
    }) &&
        marinePublisherWorkflowEntries
            .find(([dataset]) => dataset === 'currents')?.[1]
            .includes("cron: '20 */6 * * *'") === true &&
        [cmemsRequirementsLock, mpaRequirementsLock].every(
            (lock) =>
                lock.includes('--python-version 3.11.15') &&
                !lock.includes('--python-version 3.11.11') &&
                (lock.match(/^[-A-Za-z0-9_.]+==[^\n]+/gm) ?? []).length >= 5 &&
                (lock.match(/--hash=sha256:/g) ?? []).length >= (lock.match(/^[-A-Za-z0-9_.]+==[^\n]+/gm) ?? []).length,
        ),
);
const wavesPublisherWorkflow = marinePublisherWorkflowEntries.find(([dataset]) => dataset === 'waves')?.[1] ?? '';
check(
    '12-hourly waves use one exact three-hour source-age margin without weakening currents',
    wavesPublisherWorkflow.includes("cron: '0 7,19 * * *'") &&
        includesAll(cmemsGridTrust, [
            'maxSourceAgeHours: 12 | 15 | 48',
            'The publisher runs every 12h; one 3h product-cadence margin',
            'maxSourceAgeHours: 15',
        ]) &&
        marinePublisherContract.includes('maximum_source_age = 15 if dataset_key == "waves" else 12') &&
        includesAll(marinePublisherContractTest, [
            'test_wave_freshness_allows_one_native_step_of_schedule_margin',
            'timedelta(hours=15, seconds=1)',
        ]) &&
        includesAll(marinePublisherTrustTest, [
            'gives 12-hourly waves one honest 3-hour cadence margin without weakening currents',
            'expect(CMEMS_DATASETS.waves.maxSourceAgeHours).toBe(15)',
            'expect(CMEMS_DATASETS.currents.maxSourceAgeHours).toBe(12)',
        ]) &&
        includesAll(wavesPipelineReadme, [
            'Schedule: `07:00` and `19:00` UTC, exactly 12 hours apart',
            'Maximum source age: 15 hours',
            'one exact three-hour native-cadence margin',
        ]),
);
check(
    'offline marine publisher fixtures have a localhost-only dead-proxy network fence',
    marinePublisherWorkflowEntries.every(([, workflow]) => {
        const offlineStep = workflowStepSource(workflow, 'Run offline publisher');
        return (
            includesAll(offlineStep, [
                "NO_PROXY: '127.0.0.1,localhost,::1'",
                "HTTPS_PROXY: 'http://127.0.0.1:9'",
                "HTTP_PROXY: 'http://127.0.0.1:9'",
                "ALL_PROXY: 'http://127.0.0.1:9'",
                'export no_proxy="$NO_PROXY"',
                'export https_proxy="$HTTPS_PROXY"',
                'export http_proxy="$HTTP_PROXY"',
                'export all_proxy="$ALL_PROXY"',
                "python -m unittest discover -s scripts/publisher-tests -p 'test_*.py'",
            ]) &&
            !/^\s+(?:no_proxy|https_proxy|http_proxy|all_proxy):/gm.test(offlineStep) &&
            !/^\s*no_proxy:\s*['"]?\*/gim.test(workflow) &&
            !/export\s+no_proxy=['"]?\*/i.test(offlineStep) &&
            !/\$\{\{\s*secrets\.|COPERNICUS_|\bcurl\b|\bwget\b/.test(offlineStep)
        );
    }),
);
const isolatedPublisherPublishBoundary = isolatedDatasetPublisher.slice(
    isolatedDatasetPublisher.indexOf('def publish('),
    isolatedDatasetPublisher.indexOf('def main()'),
);
check(
    'marine producer contract validates source science and immutable weekly shards before dual-slot discovery publication',
    marineProducerSources.every(
        (source) =>
            !source.includes('GH_TOKEN') &&
            !source.includes('GITHUB_TOKEN') &&
            !source.includes('gh release') &&
            !source.includes('--clobber') &&
            !source.includes('upload_to_github_release'),
    ) &&
        marineCmemsProducerSources.every((source) =>
            includesInOrder(source, ['validate_cmems_source(', 'validate_thcu_payloads(', 'build_cmems_bundle(']),
        ) &&
        includesInOrder(mpaProducerSource, [
            'fetch_capad_marine()',
            'normalise_features(raw)',
            'write_validated_geojson(normalised)',
            'build_mpa_bundle(',
        ]) &&
        includesAll(marinePublisherContract, [
            'SCHEMA_VERSION = 2',
            'max_file_bytes": 16 * 1024 * 1024',
            'manifest is missing, non-regular or oversized',
            'generation digest does not match source time and assets',
            'same generation has altered immutable core metadata',
            'candidate source start time regressed',
            'validate_legacy_v1_bootstrap',
            'legacy CMEMS manifest fields are not the known v1 shape',
            'Australian external territories',
            'SHARD_TAG_RE',
            'def asset_shard_tag(',
            'def validate_shard_inventory(',
            'shard capacity guard must leave headroom below 1,000',
            'asset shard would exceed the conservative',
        ]) &&
        includesAll(cmemsProducerContract, [
            'source cadence is not exactly',
            'CF_METADATA_CONTRACT',
            'require_invariant_finite_mask',
            'implausible finite-ocean/land-mask fraction',
            'refusing to fabricate ocean values',
            'land mask contains values other than 0/1',
            'encoded land mask changed between forecast steps',
        ]) &&
        includesAll(isolatedDatasetPublisher, [
            'publisher refuses to run with Copernicus credentials',
            'remote immutable asset hash collision',
            'uploaded asset cannot be downloaded',
            'V2_MANIFEST_SLOTS = ("manifest-v2-a.json", "manifest-v2-b.json")',
            'inactive manifest slot upload failed verification',
            'target_slots = publication_manifest_slots(active_slot, target_slot)',
            'validate_same_generation_core(current, draft)',
            'validate_legacy_v1_bootstrap(legacy, dataset_key)',
            'validate_mpa_feature_count_review_bound(',
            '"--latest=false"',
        ]) &&
        (isolatedDatasetPublisher.match(/upload_args\.append\("--clobber"\)/g) ?? []).length === 1 &&
        includesInOrder(isolatedPublisherPublishBoundary, [
            'validate_manifest(draft,',
            'validate_bundle_layout(bundle_dir, draft)',
            'validate_publish_context(draft, repo)',
            'validate_publication_freshness(draft)',
            'inventory = release_assets(shard_tag, repo)',
            'existing = validate_shard_inventory(',
            'remote immutable asset hash collision',
            'validate_publication_freshness(draft)',
            'ensure_release(discovery_tag,',
            'ensure_release(shard_tag,',
            '["release", "upload", shard_tag,',
            'final["published_at"] =',
            'target_slots = publication_manifest_slots(active_slot, target_slot)',
            'for slot in target_slots:',
            'upload_manifest_slot(discovery_tag, repo, slot,',
            'Published verified generation %s to discovery slot(s)',
        ]) &&
        marinePublisherTestCount === 53 &&
        includesAll(marinePublisherContractTest, [
            'test_weekly_shard_derivation_and_iso_year_boundary',
            'test_shard_capacity_and_collision_guard_runs_before_mutation',
            'test_generation_digest_is_bound_to_ordered_hashes',
            'test_freshness_rejects_stale_and_future_sources',
            'test_consumer_metadata_size_and_coordinate_contracts_match_publisher_authority',
            'test_wave_freshness_allows_one_native_step_of_schedule_margin',
            'test_same_generation_refresh_allows_new_health_provenance_only',
            'test_real_shaped_legacy_bootstrap_and_arbitrary_legacy_rejection',
            'test_nonfinite_mask_domain_and_wave_magnitude_fail',
            'test_representative_external_territory_bounds_and_exact_properties',
        ]) &&
        includesAll(marinePublisherSourceGateTest, [
            'test_workflows_have_exact_trust_boundary',
            'test_schedule_interval_is_shorter_than_forecast_coverage',
            'test_producers_cannot_publish_or_clobber_stable_assets',
            'test_api_only_exposes_manifest_or_immutable_generation_names',
            'test_vercel_spa_rewrite_does_not_capture_dotted_release_assets',
            'self.assertEqual(4 * 7 * 13, 364)',
            'self.assertEqual(2 * 7 * 17, 238)',
        ]) &&
        includesAll(mpaTransportTest, [
            'test_valid_json_is_streamed_and_closed',
            'test_oversized_declared_body_is_rejected_before_iteration',
            'test_oversized_chunked_body_is_rejected_incrementally',
            'test_aggregate_page_budget_blocks_multi_page_memory_growth',
            'test_unsimplified_fallback_omits_offset_and_coordinate_rounding',
            'test_gis_area_hectares_are_converted_without_losing_tiny_positive_area',
        ]) &&
        includesAll(cmemsScienceTest, [
            'test_official_cf_metadata_is_accepted_for_every_field_and_axis',
            'test_convertible_but_unhandled_units_are_rejected_for_every_field_and_axis',
            'test_wrong_standard_names_and_coordinate_directions_are_rejected',
            'test_time_varying_nan_mask_is_rejected',
            'test_chlorophyll_floor_midpoint_and_ceiling_are_exact',
        ]) &&
        includesAll(waveMathTest, [
            'test_wraparound_359_and_1_average_to_zero_not_180',
            'test_height_weighting_preserves_mean_height_as_vector_magnitude',
            'test_equal_maxima_use_lowest_normalized_bearing_not_array_order',
            'test_grid_fallback_uses_same_stable_tie_rule',
        ]) &&
        includesAll(marinePublishFlowTest, [
            'test_missing_release_is_created_at_validated_producer_commit',
            'test_release_lookup_failure_does_not_mutate_remote_state',
            'test_legacy_mpa_bootstrap_accepts_feature_count_within_review_bound',
            'test_legacy_mpa_bootstrap_rejects_feature_count_outside_review_bound_before_mutation',
        ]) &&
        includesAll(currentsPipelineReadme, [
            'exactly 13 hourly snapshots',
            'deterministic UTC ISO-week shard',
            '364 current assets',
        ]) &&
        includesAll(wavesPipelineReadme, [
            '17 snapshots at three-hour cadence',
            '12-hour publish interval plus',
            'one exact three-hour native-cadence margin',
            'fail closed after that 15-hour boundary',
            'height-weighted circular mean',
        ]) &&
        includesAll(mpaPipelineReadme, [
            'GIS_AREA` is hectares and is explicitly divided by 100',
            'classification_source: indicative_heuristic',
            'UTC ISO-week release shard',
        ]),
);
check(
    'marine release proxy streams verified weekly-shard assets and preserves dotted Vercel API routes',
    releaseAssetProxyWrapperEntries.every(
        ([dataset, source]) =>
            source ===
            "import { proxyReleaseAsset } from '../_releaseAssetProxy';\n\n" +
                "export const config = { runtime: 'edge' };\n\n" +
                `export default (request: Request): Promise<Response> => proxyReleaseAsset(request, '${dataset}');\n`,
    ) &&
        includesAll(releaseAssetProxy, [
            'const MANIFEST_MAX_BYTES = 256 * 1024',
            "const V2_MANIFEST_SLOTS = ['manifest-v2-a.json', 'manifest-v2-b.json'] as const",
            'maxAssetBytes: 16 * 1024 * 1024',
            'const CMEMS_ASSET_PATTERN',
            'const MPA_ASSET_PATTERN',
            'const SHARD_TAG_PATTERN',
            'export function assetShardTag(',
            "if (request.method === 'OPTIONS')",
            "if (request.method !== 'GET')",
            "if (request.headers.has('range'))",
            "'access-control-allow-origin': '*'",
            "'access-control-allow-methods': 'GET, OPTIONS'",
            'const expectedGeneration = await computeGeneration(',
            'if (value.schema_version !== 2)',
            'const TRUSTED_UPSTREAM_HOSTS',
            "redirect: 'manual'",
            'async function cancelResponseBody(',
            'await response.body.cancel(reason)',
            "await cancelResponseBody(response, 'upstream content length rejected')",
            "await cancelResponseBody(response, 'following trusted release redirect')",
            "await cancelResponseBody(upstream, 'upstream status rejected')",
            "await cancelResponseBody(upstream, 'upstream content type rejected')",
            'function streamVerifiedBody(',
            'new ReadableStream<Uint8Array<ArrayBuffer>>',
            'return new Response(streamVerifiedBody(body)',
            "'content-digest': `sha-256=:${integrity.base64}:`",
            "'x-content-sha256': integrity.hex",
            "headers.set('x-thalassa-generation', generation)",
            "headers.set('x-thalassa-selected-manifest-slot', selectedSlot)",
            "headers.set('x-thalassa-valid-manifest-slots', String(validSlotCount))",
            'max-age=31536000, s-maxage=31536000, immutable',
            "'cache-control': isManifest ? 'no-store'",
            "process.env.THALASSA_CMEMS_V1_BRIDGE_ENABLED === 'true'",
            "return errorResponse(410, 'Legacy marine publication path is retired')",
            "if (request.headers.get('if-none-match') === etag)",
            'cancelReaderWithoutWaiting(reader,',
            'void reader.cancel(reason).catch(() => undefined)',
        ]) &&
        includesAll(marineManifestContract, [
            'export function canonicalMarineGeneration(',
            'export function validateMarineManifest(',
            'manifest metadata must be an object',
            'generation digest does not match source time and ordered asset hashes',
            "const minimumBytes = expectedDataset === 'mpa' ? 100_000",
        ]) &&
        cmemsGridTrust.includes("import { validateMarineManifest } from './marineManifestContract';") &&
        mpaDataset.includes("import { validateMarineManifest } from './marineManifestContract';") &&
        releaseAssetProxy.includes('validateMarineManifest(value, dataset, Date.now(), false)') &&
        !releaseAssetProxy.includes("'content-length': String(body.byteLength)") &&
        !releaseAssetProxy.includes("h00.bin'") &&
        !Object.hasOwn(marineVercelConfig, 'routes') &&
        !Object.hasOwn(marineVercelConfig, 'functions') &&
        JSON.stringify(marineVercelConfig.rewrites?.at(-1)) ===
            JSON.stringify({ source: '/((?!.*\\..*).*)', destination: '/index.html' }) &&
        includesAll(releaseAssetProxyTest, [
            'matches the Python canonical generation fixture exactly',
            'derives the same weekly shard, including the ISO year boundary',
            'rejects stable legacy names and unsupported methods without fetching',
            'fails legacy paths closed by default, including bare MPA and CMEMS URLs',
            'falls back from a missing or invalid slot and fails closed when neither slot is valid',
            'uses independent slot deadlines so one hung slot cannot poison the valid slot',
            'does not count a schema-valid but stale slot as failover-ready',
            'rejects Range because only a complete body can carry end-to-end integrity',
            'cancels and awaits a rejected upstream status body',
            'answers credential-free CORS preflight',
            'rejects a manifest whose generation suffix is not bound to ordered file hashes',
            'serves immutable assets with integrity, generation, ETag, CORS and 304 support',
            'follows only bounded redirects to the trusted GitHub asset host',
            'keeps the timeout active while a response body is stalled',
            'observes a rejected stream cancellation when a stalled body times out',
            'rejects an impossible generation timestamp before fetching',
            'cancels and awaits oversized or invalid declarations and unexpected content types',
            'expect(settled).toBe(false)',
        ]),
);
check(
    'local marine QA preserves API paths through the canonical shard-aware production proxy',
    includesAll(marineDevProxyBoundary, [
        "['currents', 'waves', 'sst', 'chl', 'seaice', 'mld', 'mpa'] as const",
        '`/api/${dataset}`',
        "target: 'https://thalassawx.vercel.app'",
        'changeOrigin: true',
    ]) &&
        !marineDevProxyBoundary.includes('rewrite') &&
        (marineDevProxyBoundary.match(/\btarget:\s*/g) ?? []).length === 1 &&
        viteConfig.includes('...canonicalMarineDevProxy') &&
        includesAll(marineDevProxyContractTest, [
            'preserves every API path through the canonical shard-aware production boundary',
            "expect(marineProxyBoundary).not.toContain('rewrite')",
            'expect(marineProxyBoundary.match(/\\btarget:\\s*/g) ?? []).toHaveLength(1)',
        ]),
);
const intendedPublicBetaFeatureFlags = {
    VITE_CMEMS_CURRENTS_ENABLED: false,
    VITE_CMEMS_WAVES_ENABLED: false,
    VITE_CMEMS_SST_ENABLED: false,
    VITE_CMEMS_CHL_ENABLED: false,
    VITE_CMEMS_SEAICE_ENABLED: false,
    VITE_CMEMS_MLD_ENABLED: false,
    VITE_MPA_ENABLED: false,
    VITE_APPLE_SIGN_IN_ENABLED: false,
    VITE_APPLE_WATCH_ENABLED: false,
    VITE_GOOGLE_SIGN_IN_ENABLED: false,
    VITE_ACCOUNT_DELETION_ENABLED: false,
    VITE_GRANT_ALL_FEATURES: false,
    VITE_ENABLE_ENC_DEMO_SAMPLES: false,
    VITE_WX_SERVER_ENABLED: false,
};
const releaseOwnedEnvironmentKeys = [
    ...PUBLIC_BETA_FEATURE_FLAG_KEYS,
    ...PUBLIC_BETA_ENDPOINT_KEYS,
    ...PUBLIC_BETA_REQUIRED_ABSENT_CLIENT_CONFIG,
];
check(
    'committed public-beta profile owns the exact map features, holds, endpoints, and credential policy',
    JSON.stringify(publicBetaFeatureProfile.featureFlags) === JSON.stringify(intendedPublicBetaFeatureFlags) &&
        publicBetaFeatureProfile.publicEndpoints.VITE_DEEPGRAM_PROXY_URL ===
            'https://thalassa-deepgram-proxy.thalassacalypso.workers.dev' &&
        publicBetaFeatureProfile.publicEndpoints.VITE_NATIVE_API_BASE === 'https://thalassawx.vercel.app/api' &&
        nativeApiBaseSource.includes("const DEFAULT_NATIVE_BASE = 'https://thalassawx.vercel.app/api'") &&
        indexHtmlSource.includes("connect-src 'self' data: http: https://thalassawx.vercel.app") &&
        includesAll(appShellCspSecurityTest, [
            'allows the native shell to reach the canonical same-app API host explicitly',
            "connect-src 'self' data: http: https://thalassawx.vercel.app",
            "const DEFAULT_NATIVE_BASE = 'https://thalassawx.vercel.app/api'",
        ]) &&
        publicBetaFeatureProfile.publicEndpoints.VITE_WX_SERVER_BASE === '' &&
        includesAll(publicBetaFeatureProfile.heldCapabilities.join('\n'), [
            'apple-sign-in',
            'apple-watch-bridge',
            'account-deletion',
            'gmail',
            'grant-all-features',
            'enc-demo-samples',
            'private-weather-server',
            'community-precise-track-sharing',
            'musickit',
            'aishub-contribution',
            'retired-public-float-plan',
            'calypso-proactive-alerts',
            'billing',
            'private-recipe-photos',
            'unverified-commercial-chart-packages',
            'spoonacular-online-catalogue',
            'marketplace',
        ]) &&
        JSON.stringify(publicBetaFeatureProfile.heldCapabilities) === JSON.stringify(PUBLIC_BETA_HELD_CAPABILITIES) &&
        JSON.stringify(publicBetaFeatureProfile.requiredAbsentClientConfig) ===
            JSON.stringify(['VITE_GOOGLE_OAUTH_CLIENT_ID']) &&
        JSON.stringify(publicBetaFeatureProfile.requiredCredentialPresence) ===
            JSON.stringify(['VITE_OWM_API_KEY', 'VITE_SENTRY_DSN']),
);
check(
    'production builds inject and emit the committed public-beta profile without workflow duplication',
    includesAll(viteConfig, [
        'readPublicBetaFeatureProfile(__dirname)',
        "name: 'release-public-beta-feature-manifest'",
        'publicBetaFeatureDefines(publicBetaFeatureProfile)',
        'publicBetaFeatureEnvironmentConflicts(publicBetaFeatureProfile',
        'serializePublicBetaFeatureArtifact(publicBetaFeatureProfile, credentialPresence)',
        "mode === 'production' && releasePublicBetaFeatureManifest(publicBetaCredentialPresence)",
        'Production environment disagrees with config/public-beta-features.json',
    ]) && releaseOwnedEnvironmentKeys.every((name) => !new RegExp(`^\\s*${name}:`, 'm').test(releaseWorkflowSources)),
);
check(
    'private wx server is development-only, exact opt-in, and has no release fallback or probe',
    includesAll(wxServerSource, [
        "if (!config.dev || config.enabled !== 'true') return ''",
        'enabled: import.meta.env.VITE_WX_SERVER_ENABLED',
        'base: import.meta.env.VITE_WX_SERVER_BASE',
        'if (!base) return true',
        'if (!base) return false',
    ]) &&
        !wxServerSource.includes('100.76.191.119') &&
        includesAll(wxServerBoundaryTest, [
            'resolveWxServerBase({ dev: false',
            "resolveWxServerBase({ dev: true, enabled: 'true'",
            'expect(get).not.toHaveBeenCalled()',
        ]),
);
check(
    'Lighthouse uses the lockfile-pinned direct runner and proves it audited the application shell',
    Object.hasOwn(pkg.devDependencies ?? {}, 'lighthouse') &&
        Object.hasOwn(pkg.devDependencies ?? {}, 'puppeteer') &&
        !Object.hasOwn(pkg.devDependencies ?? {}, '@lhci/cli') &&
        !denoLock.includes('@lhci/cli') &&
        [ciWorkflow, lighthouseWorkflow].every(
            (workflow) =>
                workflow.includes('scripts/run-lighthouse-audit.mjs') &&
                workflow.includes('scripts/assert-lighthouse-audited-app.mjs') &&
                /id:\s*lighthouse-audit\s*\n\s*timeout-minutes:\s*5\s*\n\s*run:\s*node scripts\/run-lighthouse-audit\.mjs/.test(
                    workflow,
                ),
        ) &&
        !/@lhci\/cli|\bnpx\s+lhci\b|treosh\/lighthouse-ci-action/.test(releaseWorkflowSources) &&
        includesAll(lighthouseRunner, [
            "import lighthouse from 'lighthouse'",
            "import puppeteer from 'puppeteer'",
            'await seedApplicationShell(browser, { url: auditUrl })',
            'evaluateAssertions(result.lhr)',
            'await rm(reportDirectory, { recursive: true, force: true })',
            'async function closeBrowserBounded(',
            "browserProcess.kill('SIGKILL')",
            'if (browser) await closeBrowserBounded(browser)',
            "require.resolve('vite/package.json')",
            'spawn(process.execPath, [viteCli',
            "'--strictPort'",
        ]) &&
        !lighthouseRunner.includes("spawn('npm'") &&
        [ciWorkflow, lighthouseWorkflow].every(
            (workflow) =>
                workflow.includes('id: lighthouse-audit') &&
                workflow.includes("if: ${{ always() && steps.lighthouse-audit.outcome != 'skipped' }}"),
        ) &&
        [ciWorkflow, lighthouseWorkflow].every(
            (workflow) =>
                workflow.includes(
                    `actions/upload-artifact@${reviewedWorkflowActionPins.get('actions/upload-artifact')}`,
                ) &&
                workflow.includes('path: .lighthouseci/') &&
                workflow.includes('include-hidden-files: true') &&
                workflow.includes('if-no-files-found: error'),
        ) &&
        !lighthouseConfig.includes('temporary-public-storage'),
);
check(
    'release workflows keep read-only repository permissions',
    [ciWorkflow, lighthouseWorkflow, previewSmokeWorkflow].every(
        (workflow) => workflow.includes('contents: read') && !/[\w-]+:\s*write|write-all/.test(workflow),
    ),
);
check(
    'hosted preview smoke accepts the legal gate and asserts application chrome',
    includesAll(read('e2e/smoke.spec.ts'), [
        "const DISCLAIMER_STORAGE_KEY = 'thalassa_disclaimer_v1.0'",
        "page.addInitScript((key) => localStorage.setItem(key, 'accepted')",
        "getByRole('tablist', { name: 'Main navigation' })",
        'new URL(request.url()).origin !== PREVIEW_ORIGIN',
        "'x-vercel-protection-bypass': VERCEL_AUTOMATION_BYPASS_SECRET",
    ]) && !read('e2e/smoke.spec.ts').includes("e.includes('Failed to fetch')"),
);
check(
    'hosted Vercel deploy admits only exact Preview or Production default-branch candidates before using the bypass secret',
    includesAll(previewSmokeWorkflow, [
        'ref: ${{ github.event.repository.default_branch }}',
        'DEPLOYMENT_SHA: ${{ github.event.deployment.sha }}',
        'candidate_sha="$(git rev-parse HEAD)"',
        "if: needs.authorize.outputs.eligible == 'true'",
        "github.actor == 'vercel[bot]'",
        "github.event.deployment.creator.login == 'vercel[bot]'",
        "github.event.deployment_status.environment == 'Preview'",
        "github.event.deployment_status.environment == 'Production'",
        'environment: Preview',
        'VERCEL_AUTOMATION_BYPASS_SECRET: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}',
    ]) &&
        includesAll(webReleaseVerifier, [
            'sameOriginVercelRequestHeaders',
            'x-vercel-protection-bypass',
            'isTrustedThalassaVercelPreviewOrigin(origin)',
            'refusing to send the Vercel automation bypass secret to an untrusted preview origin',
            'configure the repository VERCEL_AUTOMATION_BYPASS_SECRET before release smoke',
        ]) &&
        includesAll(vercelPreviewTrust, [
            "url.protocol === 'https:'",
            'THALASSA_VERCEL_PREVIEW_HOST.test(url.hostname.toLowerCase())',
            "url.pathname === '/'",
        ]),
);
check(
    'browser E2E audits the production artifact and isolates hosted-preview smoke',
    includesAll(playwrightConfig, [
        'const hostedPreviewUrl = process.env.PREVIEW_URL?.trim()',
        "const localReleaseUrl = 'http://127.0.0.1:4173'",
        "command: 'npm run preview -- --host 127.0.0.1 --strictPort'",
        'webServer: hostedPreviewUrl',
        'reuseExistingServer: false',
        "const requireHostedPreview = process.env.REQUIRE_HOSTED_PREVIEW === 'true'",
        'Refusing to test localhost',
        "['html', { open: 'never' }]",
    ]) &&
        !playwrightConfig.includes("command: 'npm run dev'") &&
        previewSmokeWorkflow.includes("REQUIRE_HOSTED_PREVIEW: 'true'") &&
        !ciWorkflow.includes('--reporter=list') &&
        !previewSmokeWorkflow.includes('--reporter=list'),
);
check(
    'local and hosted gates prove the web release surface and every enabled live marine generation',
    pkg.scripts?.['check:web-release'] === 'node scripts/verify-web-release.mjs' &&
        pkg.scripts?.['ship:beta']?.includes('npm run build && npm run check:web-release') &&
        ciWorkflow.includes('npm run check:web-release') &&
        previewSmokeWorkflow.includes('npm run check:web-release -- --hosted "$PREVIEW_URL"') &&
        includesAll(webReleaseVerifier, [
            'validateVercelConfig',
            'validateBuiltArtifacts',
            'verifyLocalPreview',
            'verifyHostedDeployment',
            'ENABLED_HOSTED_MARINE_DATASETS',
            'verifyHostedMarineDataset',
            'hostedMarineManifestFailures',
            'releaseProxyIntegrityFailures',
            'const manifestPath = `/api/${dataset}/manifest-v2.json?release-verifier=${nowMs}`',
            'fetchRawManifestSlot(dataset, slot, nowMs)',
            'RAW_MANIFEST_SLOTS.map((slot) => fetchRawManifestSlot(dataset, slot, nowMs))',
            'HOSTED_ASSET_CONCURRENCY = 2',
            'verifyHostedMarineAsset(origin, dataset, asset, protectionBypassSecret)',
            'same-generation discovery slots disagree on immutable manifest content',
            'virtual discovery manifest must use Cache-Control: no-store',
            "headers.get('x-thalassa-valid-manifest-slots') !== '2'",
            "RAW_MANIFEST_SLOTS.includes(selectedSlot ?? '')",
            'both validated discovery slots must be populated before cutover',
            'RETIRED_LEGACY_MARINE_PATHS',
            'legacyMarineRetirementFailures',
            'expected 410 Gone',
            'bare/cache-busted legacy 410 retirement',
            'SPA fallback does not serve the same application shell as /',
            'Edge header enforcement is proved only by --hosted',
        ]) &&
        includesAll(viteConfig, [
            "name: 'release-preview-document-routes'",
            'configurePreviewServer',
            "destination = '/logs.html'",
            "destination = '/index.html'",
        ]),
);
check(
    'phone and Watch marketing versions match package.json',
    marketingVersions.length >= 4 && uniqueMarketingVersions.size === 1 && marketingVersions[0] === pkg.version,
    `package=${pkg.version ?? 'missing'}, Xcode=${[...uniqueMarketingVersions].join(', ') || 'missing'}`,
);
check(
    'phone and Watch build numbers match',
    buildNumbers.length >= 4 && uniqueBuildNumbers.size === 1 && /^\d+$/.test(buildNumbers[0] ?? ''),
    `Xcode=${[...uniqueBuildNumbers].join(', ') || 'missing'}`,
);
check('iOS production bundle ID is fixed', project.includes('PRODUCT_BUNDLE_IDENTIFIER = com.thalassa.weather;'));
check(
    'Watch production bundle ID is fixed',
    project.includes('PRODUCT_BUNDLE_IDENTIFIER = com.thalassa.weather.watchkitapp;'),
);
check(
    'every iOS build configuration keeps the public-beta floor at iOS 17',
    iosDeploymentTargets.length >= 4 && uniqueIosDeploymentTargets.size === 1 && iosDeploymentTargets[0] === '17.0',
    `Xcode=${[...uniqueIosDeploymentTargets].join(', ') || 'missing'}`,
);
check('Watch public-beta floor is watchOS 10', project.includes('WATCHOS_DEPLOYMENT_TARGET = 10.0;'));
check(
    'Watch source plist contains no phone/iPad minimum-OS override',
    !/MinimumOSVersion(?:~ipad)?|LSMinimumSystemVersion/.test(watchInfoPlist),
);

// Native transport/privacy/packaging.
check(
    'Capacitor has no active live-reload URL',
    !/^\s*url\s*:/m.test(capacitorSource) && !/^\s*cleartext\s*:\s*true/m.test(capacitorSource),
);
check('ATS permits boat-LAN access', plistBoolean(infoPlist, 'NSAllowsLocalNetworking', true));
check('ATS does not permit arbitrary cleartext loads', !infoPlist.includes('<key>NSAllowsArbitraryLoads</key>'));
check('non-exempt encryption declaration is present', plistBoolean(infoPlist, 'ITSAppUsesNonExemptEncryption', false));
check('obsolete Bad Elf/MFi protocol is absent', !/badelf|UISupportedExternalAccessoryProtocols/i.test(infoPlist));
check(
    'main privacy manifest declares no tracking',
    includesAll(mainPrivacy, [
        '<key>NSPrivacyTracking</key>',
        '<false/>',
        'NSPrivacyAccessedAPICategoryUserDefaults',
        '<string>CA92.1</string>',
        'NSPrivacyAccessedAPICategoryFileTimestamp',
        '<string>C617.1</string>',
    ]),
);
const requiredMainCollectedDataTypes = [
    'NSPrivacyCollectedDataTypeName',
    'NSPrivacyCollectedDataTypeEmailAddress',
    'NSPrivacyCollectedDataTypePhoneNumber',
    'NSPrivacyCollectedDataTypeOtherUserContactInfo',
    'NSPrivacyCollectedDataTypeHealth',
    'NSPrivacyCollectedDataTypePreciseLocation',
    'NSPrivacyCollectedDataTypeCoarseLocation',
    'NSPrivacyCollectedDataTypeSensitiveInfo',
    'NSPrivacyCollectedDataTypeContacts',
    'NSPrivacyCollectedDataTypeEmailsOrTextMessages',
    'NSPrivacyCollectedDataTypePhotosorVideos',
    'NSPrivacyCollectedDataTypeAudioData',
    'NSPrivacyCollectedDataTypeOtherUserContent',
    'NSPrivacyCollectedDataTypeUserID',
    'NSPrivacyCollectedDataTypeDeviceID',
    'NSPrivacyCollectedDataTypeProductInteraction',
    'NSPrivacyCollectedDataTypePurchaseHistory',
    'NSPrivacyCollectedDataTypeCrashData',
    'NSPrivacyCollectedDataTypePerformanceData',
    'NSPrivacyCollectedDataTypeOtherDiagnosticData',
    'NSPrivacyCollectedDataTypeOtherDataTypes',
];
const declaredMainCollectedDataTypes = [
    ...mainPrivacy.matchAll(
        /<key>NSPrivacyCollectedDataType<\/key>\s*<string>(NSPrivacyCollectedDataType[^<]+)<\/string>/g,
    ),
].map((match) => match[1]);
const mainCollectedDataDictionaries = [
    ...mainPrivacy.matchAll(/<dict>\s*<key>NSPrivacyCollectedDataType<\/key>[\s\S]*?<\/dict>/g),
].map((match) => match[0]);
check(
    'main privacy manifest declares the complete public-beta data inventory',
    declaredMainCollectedDataTypes.length === requiredMainCollectedDataTypes.length &&
        requiredMainCollectedDataTypes.every((dataType) => declaredMainCollectedDataTypes.includes(dataType)),
    `declared=${declaredMainCollectedDataTypes.length}, required=${requiredMainCollectedDataTypes.length}`,
);
check(
    'every main privacy data declaration is linked, no-tracking, and app-functional',
    mainCollectedDataDictionaries.length === requiredMainCollectedDataTypes.length &&
        mainCollectedDataDictionaries.every(
            (entry) =>
                plistBoolean(entry, 'NSPrivacyCollectedDataTypeLinked', true) &&
                plistBoolean(entry, 'NSPrivacyCollectedDataTypeTracking', false) &&
                entry.includes('NSPrivacyCollectedDataTypePurposeAppFunctionality'),
        ),
);
check(
    'Watch privacy manifest declares no tracking',
    includesAll(watchPrivacy, ['<key>NSPrivacyTracking</key>', '<false/>']),
);
check(
    'time-sensitive safety notifications have the native entitlement',
    plistBoolean(mainEntitlements, 'com.apple.developer.usernotifications.time-sensitive', true),
);
check(
    'Watch declares no unused App Group capability',
    !watchEntitlements.includes('com.apple.security.application-groups') &&
        !watchEntitlements.includes('group.com.thalassa.weather'),
);
const mainPrivacyResourceCount = (project.match(/PrivacyInfo\.xcprivacy in Resources/g) ?? []).length;
const watchUsesSynchronizedGroup =
    project.includes('PBXFileSystemSynchronizedRootGroup') &&
    project.includes('fileSystemSynchronizedGroups') &&
    project.includes('ThalassaWatch Watch App');
check(
    'both privacy manifests are embedded resources',
    mainPrivacyResourceCount >= 2 &&
        watchUsesSynchronizedGroup &&
        exists('ios/App/ThalassaWatch Watch App/PrivacyInfo.xcprivacy'),
    `main resource references=${mainPrivacyResourceCount}, Watch synchronized group=${watchUsesSynchronizedGroup}`,
);

const mainIcon = pngHeader('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
check(
    'iOS App Store icon is opaque 1024×1024 PNG',
    mainIcon?.width === 1024 && mainIcon?.height === 1024 && [0, 2, 3].includes(mainIcon.colorType),
    mainIcon ? `${mainIcon.width}×${mainIcon.height}, PNG color type ${mainIcon.colorType}` : 'missing/invalid PNG',
);

const watchIcon = pngHeader('ios/App/ThalassaWatch Watch App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
check(
    'Watch App Store icon is opaque 1024×1024 PNG',
    watchIcon?.width === 1024 && watchIcon?.height === 1024 && [0, 2, 3].includes(watchIcon.colorType),
    watchIcon ? `${watchIcon.width}×${watchIcon.height}, PNG color type ${watchIcon.colorType}` : 'missing/invalid PNG',
);

const webManifestIcons = Array.isArray(webManifest.icons) ? webManifest.icons : [];
const webManifestIconEvidence = webManifestIcons.map((icon) => {
    const src = typeof icon?.src === 'string' ? icon.src : '';
    const dimensions = /^(\d+)x(\d+)$/.exec(typeof icon?.sizes === 'string' ? icon.sizes : '');
    const relative = /^\/[A-Za-z0-9._/-]+\.png$/.test(src) ? `public${src}` : '';
    const header = relative ? pngHeader(relative) : null;
    const expectedWidth = Number.parseInt(dimensions?.[1] ?? '', 10);
    const expectedHeight = Number.parseInt(dimensions?.[2] ?? '', 10);
    return {
        src,
        expectedWidth,
        expectedHeight,
        valid:
            Boolean(relative) &&
            Number.isFinite(expectedWidth) &&
            Number.isFinite(expectedHeight) &&
            header?.width === expectedWidth &&
            header?.height === expectedHeight,
    };
});
check(
    'web app manifest references present PNG icons at their declared dimensions',
    webManifestIconEvidence.length >= 2 &&
        webManifestIconEvidence.every((icon) => icon.valid) &&
        webManifestIconEvidence.some((icon) => icon.expectedWidth === 192 && icon.expectedHeight === 192) &&
        webManifestIconEvidence.some((icon) => icon.expectedWidth === 512 && icon.expectedHeight === 512),
    webManifestIconEvidence
        .map((icon) => `${icon.src || 'missing'}=${icon.expectedWidth || '?'}×${icon.expectedHeight || '?'}`)
        .join(', '),
);
check('temporary tide artwork is excluded from release inputs', !exists('public/temp_tide_girl.png'));

const obsoleteGoogleMarkers = /Codetrix|GoogleSignIn|GTMAppAuth|GTMSessionFetcher|\bAppAuth\b/;
check(
    'obsolete native Google auth dependency is removed',
    !pkg.dependencies?.['@codetrix-studio/capacitor-google-auth'],
);
check('obsolete native Google auth pod stack is removed', !obsoleteGoogleMarkers.test(`${podfile}\n${podLock}`));
check('legacy armv7 architecture is absent', !/\barmv7\b/.test(`${project}\n${podfile}`));
check(
    'locked CocoaPods toolchain supports Ruby 4 and Xcode object version 70',
    includesAll(gemfile, ["gem 'cocoapods', '1.16.2'", "gem 'nkf'"]) &&
        includesAll(gemLock, ['nkf (', 'cocoapods (1.16.2)', 'xcodeproj (1.27.0)', 'BUNDLED WITH\n  4.0.3']) &&
        includesAll(podfile, [
            "require 'xcodeproj'",
            'COMPATIBILITY_VERSION_BY_OBJECT_VERSION',
            "compatibility_versions.merge(70 => 'Xcode 16.0').freeze",
        ]),
);

// Safety/privacy contracts.
const anchor = read('services/AnchorWatchService.ts');
const anchorUi = read('components/AnchorWatchPage.tsx');
const anchorSoundCheck = read('components/anchor-watch/SoundCheckModal.tsx');
const anchorAlarmAudio = read('ios/App/App/AlarmAudioPlugin.swift');
const anchorSafetyNotifications = read('ios/App/App/AnchorSafetyNotificationPlugin.swift');
const anchorSafetyNotificationService = read('services/AnchorSafetyNotificationService.ts');
const bridgeViewController = read('ios/App/App/ThalassaBridgeViewController.swift');
const bgGeoManager = read('services/BgGeoManager.ts');
const shipLogService = read('services/ShipLogService.ts');
const shipLogAlwaysPreflightIndex = shipLogService.indexOf("requireAlwaysLocationAuthorization('voyage-log')");
const shipLogStartAcquisitionIndex = shipLogService.indexOf('BgGeoManager.requestStart()', shipLogAlwaysPreflightIndex);
const gps = read('services/GpsService.ts');
const mob = read('services/MobService.ts');
const mobUi = read('components/vessel/MobPage.tsx');
const guardian = read('services/GuardianService.ts');
const guardianMigration = read('supabase/migrations/20260804191000_guardian_presence_privacy.sql');
const guardianWorker = read('workers/ais-ingest/index.ts');
const guardianWatchdog = read('workers/ais-ingest/watchdog.ts');
const guardianWatchdogTest = read('workers/ais-ingest/watchdog.test.ts');
const watchLocation = read('ios/App/ThalassaWatch Watch App/Services/LocationManager.swift');
const watchAnchorView = read('ios/App/ThalassaWatch Watch App/Views/AnchorWatchView.swift');
const watchCockpitView = read('ios/App/ThalassaWatch Watch App/Views/CockpitGlanceView.swift');
const watchMobView = read('ios/App/ThalassaWatch Watch App/Views/MobButton.swift');
const watchSession = read('ios/App/ThalassaWatch Watch App/Services/WatchSession.swift');
check(
    'Anchor Watch setup is fail-closed',
    includesAll(anchor, ['setupError', 'await this.startGpsMonitoring()', 'rollbackFailedSetup', 'return false']),
);
check(
    'Anchor Watch native audio uses continuous background-eligible playback',
    includesAll(anchorAlarmAudio, [
        'AVAudioPlayer(data: Self.alarmWaveData)',
        'player.numberOfLoops = -1',
        'try session.setCategory(.playback',
        'try session.setActive(true)',
    ]) &&
        !anchorAlarmAudio.includes('Timer.scheduledTimer') &&
        !anchorAlarmAudio.includes('MPVolumeView') &&
        /<key>UIBackgroundModes<\/key>[\s\S]*?<string>audio<\/string>/.test(infoPlist),
);
check(
    'Anchor Watch native audio recovers from iOS audio-service events until explicitly stopped',
    includesAll(anchorAlarmAudio, [
        'AVAudioSession.interruptionNotification',
        'AVAudioSession.mediaServicesWereResetNotification',
        'resumeAlarmAfterSystemEvent(reason: "interruption")',
        'resumeAlarmAfterSystemEvent(reason: "media-services reset")',
        'let nextDelay = min(30, retryDelay * 2)',
        'guard let self = self, self.alarmRequested, !self.isPlaying else { return }',
        'alarmRequested = false',
        'resumeRetryWorkItem?.cancel()',
        'This is ordinary app audio, not a Critical Alert',
    ]),
);
check(
    'Anchor Watch schedules a verified 21-request native Time Sensitive fallback',
    includesAll(anchorSafetyNotifications, [
        'notificationCenter.getNotificationSettings',
        'settings.timeSensitiveSetting == .enabled',
        'private let maximumPendingNotificationCount = 64',
        'private let alarmRequestCount = 21',
        'removePendingNotificationRequests',
        'notificationCenter.add(request) { error in',
        'guard addErrors.isEmpty else',
        'content.interruptionLevel = .timeSensitive',
    ]) &&
        !anchorSafetyNotifications.includes('content.interruptionLevel = .critical') &&
        includesAll(anchorSafetyNotificationService, [
            "registerPlugin<AnchorSafetyNotificationsPlugin>('AnchorSafetyNotifications')",
            'ANCHOR_NOTIFICATION_REQUEST_COUNT = 21',
            "result.interruptionLevel !== 'timeSensitive'",
        ]) &&
        includesAll(bridgeViewController, ['registerPluginInstance(AnchorSafetyNotificationPlugin())']) &&
        project.includes('AnchorSafetyNotificationPlugin.swift in Sources') &&
        includesAll(anchor, [
            'AnchorSafetyNotificationService.requireReadiness()',
            'AnchorSafetyNotificationService.scheduleAlarm(title, body)',
            'AnchorSafetyNotificationService.cancelAlarm()',
        ]) &&
        !anchor.includes("extra: { interruptionLevel: 'timeSensitive'") &&
        plistBoolean(mainEntitlements, 'com.apple.developer.usernotifications.time-sensitive', true),
);
check(
    'Anchor Watch and voyage logging fail closed without verified iOS Always Location',
    includesAll(bgGeoManager, [
        "requireAlwaysLocationAuthorization(feature: 'anchor-watch' | 'voyage-log')",
        'current.status === AuthorizationStatus.Always',
        "locationAuthorizationRequest: 'Always'",
        'await BackgroundGeolocation.requestPermission()',
        'verified.status !== AuthorizationStatus.Always',
        "locationAuthorizationRequest: 'WhenInUse'",
    ]) &&
        /finally\s*\{[\s\S]*?locationAuthorizationRequest: 'WhenInUse'/.test(bgGeoManager) &&
        includesAll(anchor, [
            "requireAlwaysLocationAuthorization('anchor-watch')",
            "Capacitor.getPlatform() === 'ios' && !nativeMonitoringVerified",
            'A live NMEA feed is supplemental',
        ]) &&
        shipLogAlwaysPreflightIndex > -1 &&
        shipLogStartAcquisitionIndex > shipLogAlwaysPreflightIndex,
);
check(
    'shared marine GPS cannot auto-pause while a ref-counted tracking lease is active',
    includesAll(bgGeoManager, ['pausesLocationUpdatesAutomatically: false', 'disableStopDetection: true']),
);
check(
    'iOS location purpose copy distinguishes foreground tools from user-armed background safety',
    includesAll(infoPlist, [
        'Thalassa uses your location while the app is open to show local marine weather, your dashboard position, navigation tools, and the anchor position you choose.',
        'Thalassa uses your location in the background only while you explicitly arm Anchor Watch or start voyage logging, so it can detect anchor dragging and record your passage while the screen is locked.',
    ]),
);
check(
    'every Anchor Watch arming requires an explicit audible alarm confirmation',
    includesAll(anchorSoundCheck, [
        'Confirm alarm was audible',
        "const leasePromise = AlarmAudioService.acquire('anchor-sound-check')",
        'testLeasePromiseRef.current = leasePromise',
        'const lease = await leasePromise',
        'AlarmAudioService.releaseEventually(resolvedLease)',
        'disabled={!alarmAudibilityConfirmed || notificationBlocked || audioCleanupBlocked}',
        'Play the real alarm and confirm you heard it before Anchor Watch can start.',
    ]) &&
        anchorUi.includes('Every arming attempt requires a fresh audible test') &&
        !anchorUi.includes('soundCheckShownRef'),
);
check(
    'Shore Watch sharing is explicitly account-gated while local monitoring remains available',
    includesAll(anchorUi, [
        'if (!authedUser)',
        'Sign in to use Shore Watch',
        'Sign in to Shore Share',
        'Local Anchor Watch remains available without an account.',
    ]),
);
check(
    'web GPS and MOB vectors fail closed when own-ship position is stale',
    includesAll(gps, ['maximumAge: staleLimitMs', 'wasTooOldWhenRequested', 'position request rejected']) &&
        includesAll(mob, ['MOB_OWN_POSITION_STALE_MS = 15_000', 'ownPositionFresh', 'distanceMeters: distance']) &&
        includesAll(mobUi, ['const displayedDistance = ownPositionFresh', 'GPS stale', 'last known']),
);
check(
    'Shore Watch marks disconnected or missed position broadcasts as last-known',
    includesAll(anchorUi, [
        'SHORE_DATA_STALE_MS = 15_000',
        'shoreDataFresh',
        'Vessel data is stale · showing last-known update',
        'Mute this device only',
    ]),
);
check(
    'Watch Anchor companion age-gates phone state and foreground GPS',
    includesAll(anchor, ['generatedAt: Date.now()']) &&
        includesAll(watchLocation, [
            'freshLocation(',
            'maximumAge: TimeInterval = 20',
            'maximumAccuracy: CLLocationAccuracy = 50',
        ]) &&
        includesAll(watchAnchorView, [
            'snapshotFreshFor',
            'Foreground companion only · keep phone armed',
            'Silences this Watch only; phone alarm is separate',
        ]),
);
check(
    'Watch cockpit never presents durable stale data as live',
    includesAll(watchCockpitView, ['staleAfter', 'Last phone update', 'Open Thalassa on phone to refresh']),
);
check(
    'Watch MOB reports phone delivery honestly and directs real distress action',
    includesAll(watchSession, ['enum MobDeliveryState', 'case phoneReceived', 'case queued', 'replyHandler']) &&
        includesAll(watchMobView, [
            'Hold to mark MOB on phone',
            'DISTRESS: use VHF/DSC or chartplotter now',
            'Phone unreachable — queued briefly, not a marker or distress',
        ]),
);
const passiveLaunchApp = read('App.tsx');
const passiveLaunchController = read('hooks/useAppController.ts');
const passiveLaunchSettings = read('stores/settingsStore.ts');
const passiveLocationService = read('services/GpsService.ts');
const passiveWeatherOrchestrator = read('services/WeatherOrchestrator.ts');
const passiveWeatherContext = read('context/WeatherContext.tsx');
const passiveSmartRefresh = read('hooks/useSmartRefresh.ts');
const passiveDashboard = read('components/Dashboard.tsx');
const passiveLogPageState = read('hooks/useLogPageState.ts');
const passiveVesselHub = read('components/VesselHub.tsx');
const passiveOwnship = read('services/ownshipPosition.ts');
const passiveGuardianPage = read('components/GuardianPage.tsx');
const passiveGuardianService = read('services/GuardianService.ts');
const passiveLogPage = read('pages/LogPage.tsx');
const passiveAnchorWatch = read('services/AnchorWatchService.ts');
const passiveBgGeo = read('services/BgGeoManager.ts');
const passiveGpsHealthBody = passiveBgGeo.slice(
    passiveBgGeo.indexOf('async getGpsHealth()'),
    passiveBgGeo.indexOf('/** Synchronous last-known health'),
);
const passiveSamplingBody = passiveBgGeo.slice(
    passiveBgGeo.indexOf('async setSamplingMode('),
    passiveBgGeo.indexOf('/**\n     * Undo a sampling-mode change'),
);
const passiveGuardianHeartbeat = passiveGuardianService.slice(
    passiveGuardianService.indexOf('private async sendHeartbeat('),
    passiveGuardianService.indexOf('private startHeartbeat('),
);
const passiveAnchorPreview = passiveAnchorWatch.slice(
    passiveAnchorWatch.indexOf('async getCurrentPosition()'),
    passiveAnchorWatch.indexOf('/**\n     * Restore anchor watch state'),
);
check(
    'passive launch and cloud restore never request OS location or motion permissions',
    !passiveLaunchApp.includes("import('./services/BgGeoManager')") &&
        !passiveLaunchApp.includes("import('./services/gpsWarmUp')") &&
        !passiveLaunchSettings.includes('Geolocation.requestPermissions()') &&
        !passiveLaunchSettings.includes("merged.defaultLocation = 'Current Location'") &&
        !passiveLaunchController.includes('Geolocation.requestPermissions(') &&
        !passiveLaunchController.includes('Geolocation.getCurrentPosition(') &&
        passiveLaunchController.includes('GpsService.getCurrentPositionIfGranted(') &&
        passiveLaunchController.includes('GpsService.requestCurrentForegroundPosition(') &&
        includesAll(passiveLocationService, [
            'async getCurrentPositionIfGranted(',
            'const permission = await Geolocation.checkPermissions()',
            "if (permission.state !== 'granted') return null",
            'canUseForegroundHighAccuracy(permission, enableHighAccuracy)',
            'if (!ensureRunning) return this._nativeForegroundWatchIfGranted(callback)',
            'return opts.ensureRunning === true ? this._webWatch(callback) : this._webWatchIfGranted(callback)',
        ]) &&
        !passiveDashboard.includes('useLiveLocationName') &&
        !passiveLogPageState.includes('BgGeoManager.ensureReady') &&
        !passiveVesselHub.includes('GpsService.getCurrentPosition(') &&
        passiveVesselHub.includes('GpsService.getCurrentPositionIfGranted(') &&
        !passiveGpsHealthBody.includes('ensureReady()') &&
        passiveBgGeo.includes('disableMotionActivityUpdates: true') &&
        passiveSamplingBody.includes('if (!this.ready)') &&
        !passiveSamplingBody.includes('ensureReady()') &&
        passiveOwnship.includes("options.locationAccess ?? 'already-granted'") &&
        passiveOwnship.includes('GpsService.getCurrentPositionIfGranted(requestOptions)') &&
        passiveOwnship.includes('GpsService.requestCurrentForegroundPosition(requestOptions)') &&
        passiveOwnship.includes('GpsService.getCurrentPosition(requestOptions)') &&
        passiveGuardianPage.includes("locationAccess: 'foreground-request'") &&
        !passiveGuardianHeartbeat.includes("locationAccess: 'foreground-request'") &&
        passiveLogPage.includes("locationAccess: 'background-safety'") &&
        passiveAnchorPreview.includes('GpsService.getCurrentPositionIfGranted(') &&
        !passiveAnchorPreview.includes('BgGeoManager.ensureReady') &&
        !passiveWeatherOrchestrator.includes('GpsService.getCurrentPosition(') &&
        passiveWeatherOrchestrator.includes('GpsService.getCurrentPositionIfGranted(') &&
        !passiveWeatherContext.includes('GpsService.getCurrentPosition(') &&
        passiveWeatherContext.includes('GpsService.getCurrentPositionIfGranted(') &&
        !passiveSmartRefresh.includes('GpsService.getCurrentPosition(') &&
        passiveSmartRefresh.includes('GpsService.getCurrentPositionIfGranted('),
);
check(
    'Guardian client only discovers while armed',
    includesAll(guardian, [
        "rpc('guardian_arm'",
        "rpc('guardian_heartbeat'",
        "rpc('nearby_guardians'",
        '!this.state.armed',
    ]),
);
check(
    'Guardian server discovery cannot sweep arbitrary coordinates',
    includesAll(guardianMigration, [
        'DROP FUNCTION public.thalassa_users_nearby',
        'CREATE FUNCTION public.nearby_guardians(radius_nm',
        'gp.user_id = auth.uid()',
        'gp.armed IS TRUE',
        "gp.last_known_at > now() - interval '5 minutes'",
    ]),
);
check(
    'Guardian AIS watchdog is a tested exact opt-in and defaults off for public beta',
    includesAll(guardianWorker, [
        'isGuardianWatchdogEnabled(process.env.GUARDIAN_WATCHDOG_ENABLED)',
        'if (!GUARDIAN_WATCHDOG_ENABLED)',
        'guardianWatchdogEnabled: guardianWatchdogStarted',
        'guardianWatchdogStarted = true',
        'GUARDIAN_WATCHDOG_ENABLED must be exactly "true" to opt in',
    ]) &&
        includesAll(guardianWatchdog, [
            'export function isGuardianWatchdogEnabled(value: string | undefined)',
            "return value === 'true'",
        ]) &&
        includesAll(guardianWatchdogTest, [
            'isGuardianWatchdogEnabled(undefined)).toBe(false)',
            "isGuardianWatchdogEnabled('true')).toBe(true)",
            "' true '",
            "'TRUE'",
        ]) &&
        includesAll(ciWorkflow, ['ais-ingest:', 'working-directory: workers/ais-ingest', 'run: npm test']),
);

const accountService = read('services/accountDeletion.ts');
const accountFunction = read('supabase/functions/delete-account/index.ts');
const accountStorageCleanup = read('supabase/functions/delete-account/storage-cleanup.ts');
const accountStorageCleanupTest = read('supabase/functions/delete-account/storage-cleanup_test.ts');
const accountWorkflow = read('supabase/functions/delete-account/workflow.ts');
const accountWorkflowTest = read('supabase/functions/delete-account/workflow_test.ts');
const accountMigration = read('supabase/migrations/20260804190000_account_deletion_support.sql');
const accountDurabilityMigration = read('supabase/migrations/20260806120000_account_deletion_durability.sql');
const accountUi = read('components/settings/AccountTab.tsx');
const accountDeletionBoundary = read('services/accountDeletionPublicBetaBoundary.ts');
const accountDeletionHoldTest = read('tests/AccountDeletionPublicBetaHold.test.tsx');
const signInUi = read('components/SignInScreen.tsx');
const diaryService = read('services/DiaryService.ts');
const vesselSync = read('services/vessel/SyncService.ts');
const avatarMigration = read('supabase/migrations/20260804194000_retire_legacy_crew_avatar_paths.sql');
const storageBoundaryMigration = read('supabase/migrations/20260804195000_verify_storage_beta_boundaries.sql');
const socialAuth = read('services/auth/SocialAuthService.ts');
const appleRegistrationFunction = read('supabase/functions/register-apple-token/index.ts');
const appleAuthServer = read('supabase/functions/_shared/apple-auth.ts');
const appleTokenMigration = read('supabase/migrations/20260805090000_apple_sign_in_token_lifecycle.sql');
const appleNotificationFunction = read('supabase/functions/apple-server-notification/index.ts');
const appleNotificationMigration = read('supabase/migrations/20260805091000_apple_server_notification_queue.sql');
const appleNativePlugin = read('ios/App/App/AppleCredentialStatePlugin.swift');
const appleNativeClient = read('services/auth/appleCredentialState.ts');
const authStore = read('stores/authStore.ts');
const appBootstrap = read('hooks/useAppBootstrap.ts');
const supabaseConfig = read('supabase/config.toml');
const appleProductionEnvFiles = ['.env', '.env.local', '.env.production', '.env.production.local'];
const appleEnabledEnvFiles = appleProductionEnvFiles.filter(
    (relative) =>
        exists(relative) &&
        /^\s*VITE_APPLE_SIGN_IN_ENABLED\s*=\s*(?:true|"true"|'true')\s*(?:#.*)?$/m.test(read(relative)),
);
check(
    'in-app account deletion is wired end to end',
    includesAll(accountService, ['delete-account', 'purgeLocalDatabaseForUser', 'appleRevocationRequired']) &&
        includesAll(accountFunction, ['auth.admin.deleteUser', 'authorization', "method !== 'POST'"]) &&
        includesAll(accountUi, ['DeleteAccountDialog', 'appleRevocationRequired']) &&
        accountMigration.includes('ON DELETE CASCADE'),
);
const deleteAccountServiceBody = accountService.slice(
    accountService.indexOf('export async function deleteCurrentAccount'),
);
const accountDeletionHold = deleteAccountServiceBody.indexOf('if (!ACCOUNT_DELETION_PUBLIC_BETA_ENABLED)');
check(
    'production account deletion is held before UI exposure or destructive invocation',
    publicBetaFeatureProfile.featureFlags.VITE_ACCOUNT_DELETION_ENABLED === false &&
        publicBetaFeatureProfile.heldCapabilities.includes('account-deletion') &&
        includesAll(accountDeletionBoundary, [
            "import.meta.env.VITE_ACCOUNT_DELETION_ENABLED === 'true'",
            "ACCOUNT_DELETION_PRIVACY_EMAIL = 'privacy@thalassa.app'",
            'Account deletion is temporarily unavailable',
        ]) &&
        includesAll(accountUi, [
            'ACCOUNT_DELETION_PUBLIC_BETA_ENABLED ? (',
            'Account deletion temporarily unavailable',
            'ACCOUNT_DELETION_PRIVACY_MAILTO',
        ]) &&
        accountDeletionHold >= 0 &&
        accountDeletionHold < deleteAccountServiceBody.indexOf('confirmation !== ACCOUNT_DELETION_CONFIRMATION') &&
        accountDeletionHold < deleteAccountServiceBody.indexOf("supabase.functions.invoke('delete-account'") &&
        includesAll(accountDeletionHoldTest, [
            "queryByRole('button', { name: 'Permanently delete account' })",
            'expect(harness.invoke).not.toHaveBeenCalled()',
        ]),
);
check(
    'account deletion request and destructive ordering have executable Edge tests in CI',
    ciWorkflow.includes('deno test */*_test.ts') &&
        includesAll(accountWorkflowTest, [
            "Deno.test('delete-account request gate requires an exact bearer header and exact DELETE confirmation'",
            "Deno.test('delete-account runs Apple revocation and every cleanup before deleting auth'",
            'failure prevents auth deletion',
            "Deno.test('delete-account does not report success until auth deletion succeeds'",
        ]) &&
        includesAll(accountStorageCleanupTest, [
            'more than 20,000 objects in bounded pages',
            'successful remove responses make no progress',
            'drains and deletes bounded first pages from both current recipe tables',
            'deletes each cleaned page before a budget failure and resumes on retry',
            'fails closed on missing active tables',
            'prevents auth deletion',
        ]),
);
check(
    'web auth does not expose the unconfigured Apple Services-ID flow',
    signInUi.includes('Apple sign-in is not enabled in this beta build; use email.') &&
        !signInUi.includes('import { signInWithApple, signInWithAppleOnWeb }'),
);
const appleFlagOn = publicBetaFeatureProfile.featureFlags.VITE_APPLE_SIGN_IN_ENABLED === true;
const appleEntitled = mainEntitlements.includes('<key>com.apple.developer.applesignin</key>');
check(
    'Apple sign-in stays compile-time gated on its flag',
    includesAll(signInUi, [
        "const APPLE_SIGN_IN_ENABLED = import.meta.env.VITE_APPLE_SIGN_IN_ENABLED === 'true'",
        'const appleNativeEnabled = isNative && APPLE_SIGN_IN_ENABLED',
        '{appleNativeEnabled && (',
        '{!appleNativeEnabled && (',
        'Apple sign-in is not enabled in this beta build; use email.',
    ]) &&
        // The shell and env files must not disagree with the committed
        // profile: a build that turns Apple on locally would ship a button the
        // release manifest says is absent.
        (appleFlagOn || (process.env.VITE_APPLE_SIGN_IN_ENABLED !== 'true' && appleEnabledEnvFiles.length === 0)),
    `profile=${appleFlagOn ? 'enabled' : 'disabled'}, shell=${
        process.env.VITE_APPLE_SIGN_IN_ENABLED === 'true' ? 'enabled' : 'disabled'
    }, env-files=${appleEnabledEnvFiles.length}`,
);
check(
    // AGREEMENT, not absence. Flag on without the entitlement is a button that
    // dies at Apple; the entitlement without the flag is a capability we claim
    // and never use, which App Review asks about. Both are caught here.
    'the Sign in with Apple entitlement agrees with the Apple sign-in flag',
    appleEntitled === appleFlagOn,
    `flag=${appleFlagOn ? 'on' : 'off'}, entitlement=${appleEntitled ? 'present' : 'absent'}`,
);
const googleFlagOn = publicBetaFeatureProfile.featureFlags.VITE_GOOGLE_SIGN_IN_ENABLED === true;
const googleEnabledEnvFiles = appleProductionEnvFiles.filter(
    (relative) =>
        exists(relative) &&
        /^\s*VITE_GOOGLE_SIGN_IN_ENABLED\s*=\s*(?:true|"true"|'true')\s*(?:#.*)?$/m.test(read(relative)),
);
check(
    // Same shape as Apple. The extra clause is the client ID: Google sign-in
    // cannot work without one, and GOOGLE_SIGN_IN_ENABLED requires it at
    // runtime, so a flag-on build with no client ID would ship a dead button.
    'Google sign-in stays gated on its flag and a configured client ID',
    includesAll(read('services/auth/googleSignIn.ts'), [
        "import.meta.env.VITE_GOOGLE_SIGN_IN_ENABLED === 'true'",
        "GOOGLE_OAUTH_CLIENT_ID !== ''",
        "provider: 'google'",
    ]) &&
        // Identity scopes only — a sign-in must never quietly acquire mailbox
        // access. Gmail is a separate, separately-consented integration.
        read('services/auth/googleSignIn.ts').includes("const SCOPES = 'openid email profile'") &&
        !/gmail\.(readonly|compose|send|modify)/.test(read('services/auth/googleSignIn.ts')) &&
        includesAll(signInUi, ['GOOGLE_SIGN_IN_ENABLED', '{googleEnabled && (']) &&
        // Shell and env files must not disagree with the committed profile.
        (googleFlagOn || (process.env.VITE_GOOGLE_SIGN_IN_ENABLED !== 'true' && googleEnabledEnvFiles.length === 0)),
    `profile=${googleFlagOn ? 'enabled' : 'disabled'}, shell=${
        process.env.VITE_GOOGLE_SIGN_IN_ENABLED === 'true' ? 'enabled' : 'disabled'
    }, env-files=${googleEnabledEnvFiles.length}`,
);
check(
    'native Apple auth retains a revocable credential only through the authenticated server',
    socialAuth.indexOf('await supabase.auth.signInWithIdToken') <
        socialAuth.indexOf("supabase.functions.invoke('register-apple-token'") &&
        includesAll(socialAuth, [
            'authorizationCode',
            'body: { authorizationCode }',
            "supabase.auth.signOut({ scope: 'local' })",
            "Apple Sign-In couldn't finish securely",
        ]) &&
        !includesAll(socialAuth, ['APPLE_SIGN_IN_PRIVATE_KEY']) &&
        !socialAuth.includes('APPLE_REFRESH_TOKEN_ENCRYPTION_KEY') &&
        includesAll(appleRegistrationFunction, [
            'caller.auth.getUser()',
            'exchangeAppleAuthorizationCode(appleConfig, authorizationCode)',
            'verifyAppleIdTokenSubject(tokenExchange.idToken, appleConfig.clientId)',
            'exchangedSubject !== callerAppleSubject',
            'await encryptAppleRefreshToken',
            "admin.from('apple_sign_in_tokens')",
            'await decryptAppleRefreshToken',
            'previousRefreshToken !== refreshToken',
            ".eq('updated_at', previous.updated_at)",
            ".from('apple_sign_in_tokens').insert",
            "Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')",
        ]) &&
        includesAll(appleAuthServer, [
            '`${APPLE_ISSUER}/auth/token`',
            '`${APPLE_ISSUER}/auth/revoke`',
            'jwtVerify(idToken, APPLE_JWKS',
            "Deno.env.get('APPLE_REFRESH_TOKEN_ENCRYPTION_KEY')",
            "{ name: 'AES-GCM' }",
            'rawEncryptionKey.byteLength !== 32',
        ]),
);
check(
    'Apple refresh tokens are service-role-only and revoked before account deletion',
    includesAll(appleTokenMigration, [
        'REFERENCES auth.users(id) ON DELETE CASCADE',
        'ALTER TABLE public.apple_sign_in_tokens ENABLE ROW LEVEL SECURITY',
        'ALTER TABLE public.apple_sign_in_tokens FORCE ROW LEVEL SECURITY',
        'REVOKE ALL ON TABLE public.apple_sign_in_tokens FROM authenticated',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.apple_sign_in_tokens TO service_role',
        'apple_subject_sha256 TEXT NOT NULL UNIQUE',
    ]) &&
        !/CREATE POLICY/i.test(appleTokenMigration) &&
        accountFunction.lastIndexOf('await revokeAppleCredentialBeforeDeletion(') > -1 &&
        accountFunction.lastIndexOf('await revokeAppleCredentialBeforeDeletion(') <
            accountFunction.indexOf('admin.auth.admin.deleteUser') &&
        includesAll(accountFunction, [
            'await revokeAppleRefreshToken(appleConfig, refreshToken)',
            "await recordAppleState(admin, user.id, leaseToken, 'revoking'",
            "await recordAppleState(admin, user.id, leaseToken, 'complete'",
        ]) &&
        includesAll(accountWorkflow, [
            'await dependencies.scrubSurvivors()',
            'await dependencies.deleteAuthUser()',
            "appleRevocationRequired ? 'manual_required'",
        ]) &&
        includesAll(accountDurabilityMigration, [
            "apple_revocation_state TEXT NOT NULL DEFAULT 'pending'",
            'apple_subject_sha256 = NULL',
            'DELETE FROM public.apple_server_notification_queue',
        ]) &&
        /\[functions\.register-apple-token\][\s\S]*?verify_jwt = true/.test(supabaseConfig) &&
        /\[functions\.delete-account\][\s\S]*?verify_jwt = true/.test(supabaseConfig),
);
check(
    'native Apple credential revocation is identity-matched and fences the local session',
    includesAll(appleNativePlugin, [
        'ASAuthorizationAppleIDProvider.credentialRevokedNotification',
        'getCredentialState(forUserID: userID)',
        'retainUntilConsumed: true',
        'kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly',
        '"userId": userID',
    ]) &&
        includesAll(appleNativeClient, [
            "eventName: 'credentialRevoked'",
            'bindAppleCredentialUser',
            'clearBoundAppleCredential',
            'startAppleCredentialRevocationMonitoring',
        ]) &&
        includesAll(authStore, [
            'handleNativeAppleCredentialRevocation(appleUserId: string)',
            'appleSubjects(currentUser).includes(appleUserId)',
            "supabase?.auth.signOut({ scope: 'local' })",
            'setAuthIdentityScope(null)',
            'initLocalDatabase(null)',
        ]) &&
        includesAll(appBootstrap, [
            'startAppleCredentialRevocationMonitoring',
            'handleNativeAppleCredentialRevocation(event.userId)',
        ]),
);
check(
    'Apple server notifications are signature-verified and durably queued without claiming deletion',
    includesAll(appleAuthServer, [
        'verifyAppleServerNotification',
        'jwtVerify(signedPayload, APPLE_JWKS',
        'issuer: APPLE_ISSUER',
        'audience: clientId',
        "algorithms: ['RS256']",
    ]) &&
        includesAll(appleNotificationFunction, [
            'verifyAppleServerNotification(signedPayload, clientId)',
            "event.eventType === 'email-enabled'",
            ".from('apple_server_notification_queue').upsert",
            "status: 'pending'",
            "action: 'pending_account_lifecycle'",
        ]) &&
        !appleNotificationFunction.includes('auth.admin.deleteUser') &&
        includesAll(appleNotificationMigration, [
            'ALTER TABLE public.apple_server_notification_queue FORCE ROW LEVEL SECURITY',
            'REVOKE ALL ON TABLE public.apple_server_notification_queue FROM authenticated',
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.apple_server_notification_queue TO service_role',
        ]) &&
        /\[functions\.apple-server-notification\][\s\S]*?verify_jwt = false/.test(supabaseConfig),
);
check(
    'account, diary, and vessel media deletion stays owner-scoped and retryable',
    includesAll(accountFunction, [
        'captureDrainAndVerifyStorage',
        "'capture_account_deletion_storage'",
        "'verify_account_deletion_storage_empty'",
        'drainExactStorageManifest',
    ]) &&
        includesAll(accountStorageCleanup, [
            'export async function drainExactStorageManifest',
            'MAX_STORAGE_MANIFEST_PAGES_PER_INVOCATION',
            'markRemoveRequested',
            'Account Storage checkpoint did not verify the whole batch',
            'return { complete: false, processed }',
        ]) &&
        !accountStorageCleanup.includes('MAX_STORAGE_OBJECTS') &&
        accountFunction.lastIndexOf('captureDrainAndVerifyStorage') <
            accountFunction.indexOf('admin.auth.admin.deleteUser') &&
        includesAll(accountDurabilityMigration, [
            'CREATE TABLE public.account_deletion_storage_items',
            'object.owner_id::TEXT = p_user_id::TEXT',
            "'legacy-recipe-row'",
            "split_part(object.name, '/', 1) IN ('dating', 'crew')",
            'CREATE TRIGGER account_deletion_storage_write_fence',
        ]) &&
        includesAll(diaryService, [
            'Diary photo cleanup failed — will retry with the tombstone',
            'Diary audio cleanup failed — will retry with the tombstone',
            'if (storageError)',
            'return false',
        ]) &&
        includesAll(vesselSync, [
            'reconcileVaultObjects(table, authenticatedUserId, item.record_id, row[fileField])',
            'reconcileVaultObjects(table, authenticatedUserId, item.record_id, null)',
            'Attachment cleanup list failed',
            'Attachment cleanup failed',
        ]) &&
        includesAll(avatarMigration, [
            'DROP POLICY IF EXISTS "Users can update own avatar"',
            "bucket_id = 'chat-avatars'",
            "(storage.foldername(name))[1] = 'dating'",
        ]) &&
        includesAll(storageBoundaryMigration, [
            'Public-beta Storage has unbounded write policies',
            'Owner-scoped vessel_vault UPDATE policy is missing or malformed',
            'A legacy public chat-avatars/crew write path remains',
        ]),
);
const authModal = read('components/AuthModal.tsx');
check(
    'email OTP verification reuses the canonical address',
    includesAll(authModal, ['setEmail(cleanEmail)', 'email: sanitizeEmail(email)', 'Verify email code']),
);

const sentry = read('services/sentry.ts');
check(
    'production telemetry excludes default PII and session replay',
    includesAll(sentry, ['sendDefaultPii: false', 'replaysSessionSampleRate: 0', 'replaysOnErrorSampleRate: 0']) &&
        !sentry.includes('sendDefaultPii: true'),
);
check(
    'production telemetry drops console breadcrumbs that may contain private marine data',
    sentry.includes("if (IS_PROD && crumb.category === 'console') return null"),
);
check(
    'outbound telemetry sanitizes error text, embedded URLs, email, coordinates, and identifiers',
    includesAll(sentry, [
        'sanitizeTelemetryString',
        'event.message = sanitizeTelemetryString(event.message)',
        'event.logentry.message = sanitizeTelemetryString(event.logentry.message)',
        'exception.value = sanitizeTelemetryString(exception.value)',
        '[redacted-coordinates]',
        '[redacted-email]',
    ]),
);
const deepgramClient = read('services/voice/deepgramRecognizer.ts');
const speechClient = read('services/voice/speechRecognizer.ts');
const deepgramProxy = read('supabase/functions/deepgram-ws-proxy/index.ts');
check(
    'voice diagnostics never log transcript bodies or previews',
    !deepgramProxy.includes('ev.data.slice') &&
        !deepgramClient.includes('transcript.slice(0, 40)') &&
        !/text=\\?"\$\{preview/.test(`${deepgramClient}\n${speechClient}`),
);
check(
    'Gmail integration is development-only until tokens use secure storage',
    read('services/voice/integrations/gmail.ts').includes('GMAIL_PUBLIC_BETA_ENABLED = import.meta.env.DEV'),
);
const featureVisibility = read('utils/featureVisibility.ts');
const bosunConsole = read('components/voice/BosunConsole.tsx');
const voiceOrchestrator = read('services/voice/orchestrator.ts');
const viewRegistry = read('viewRegistry.tsx');
const calypsoSettings = read('components/settings/CalypsoIntegrationsTab.tsx');
const musicKitToken = read('supabase/functions/musickit-token/index.ts');
const musicKitServerHold = musicKitToken.indexOf('if (!MUSICKIT_PUBLIC_BETA_ENABLED)');
const musicKitServerAuth = musicKitToken.indexOf("requireAuthenticatedOrPublicQuota(req, 'musickit_token'");
const musicKitPrivateKeyRead = musicKitToken.indexOf("Deno.env.get('MUSICKIT_PRIVATE_KEY')");
const alertMonitor = read('services/AlertMonitorService.ts');
const alertNotifier = read('services/AlertNotifier.ts');
const appShell = read('App.tsx');
const publicTerms = read('public/terms.html');
const normalizedPublicTerms = publicTerms.replace(/\s+/g, ' ');
check(
    'Calypso proactive vessel alerts are fail-closed without background or Critical Alert claims',
    includesAll(featureVisibility, ['calypsoAlerts: false']) &&
        includesAll(appShell, [
            'FEATURE_VISIBILITY.calypsoAlerts && (settings.calypsoAlertsEnabled ?? false)',
            'void updateSettings({ calypsoAlertsEnabled: false })',
        ]) &&
        includesAll(calypsoSettings, [
            '!FEATURE_VISIBILITY.calypsoAlerts ? (',
            'Proactive alerts unavailable in public beta',
            'not running as a background or terminated-app vessel monitor',
            'Keep dedicated instrument alarms and watchkeeping procedures active',
        ]) &&
        includesAll(alertMonitor, [
            "FEATURE_VISIBILITY.calypsoAlerts || import.meta.env.MODE === 'test'",
            "this.evaluate(NmeaStore.getState(), 'nmea-backbone-dead')",
        ]) &&
        alertNotifier.includes('not a background, terminated-app, or Critical Alert channel') &&
        !alertNotifier.includes('audible even when the app is backgrounded'),
);
check(
    'Apple Music is compile-time fail-closed until MusicKit distribution capability is verified',
    includesAll(featureVisibility, ['appleMusic: false']) &&
        musicKitToken.includes('const MUSICKIT_PUBLIC_BETA_ENABLED = false') &&
        musicKitServerHold >= 0 &&
        musicKitServerHold < musicKitServerAuth &&
        musicKitServerHold < musicKitPrivateKeyRead &&
        includesAll(musicKitToken.slice(musicKitServerHold, musicKitServerAuth), [
            'status: 503',
            "'Cache-Control': 'no-store'",
        ]) &&
        includesAll(bosunConsole, [
            'FEATURE_VISIBILITY.appleMusic && canAccess',
            'FEATURE_VISIBILITY.appleMusic && (',
        ]) &&
        voiceOrchestrator.includes('FEATURE_VISIBILITY.appleMusic && input.integrations?.appleMusic') &&
        viewRegistry.includes('Apple Music unavailable in public beta') &&
        includesAll(calypsoSettings, [
            '!FEATURE_VISIBILITY.appleMusic ? (',
            'Apple Music unavailable in public beta',
            'no Apple Music connection',
        ]) &&
        voiceOrchestrator.includes('Apple Music controls are unavailable in this public beta') &&
        voiceOrchestrator.includes('!FEATURE_VISIBILITY.appleMusic && APPLE_MUSIC_TOOL_NAMES.has(name)') &&
        !voiceOrchestrator.includes('Apple Music tools are available whenever') &&
        includesAll(normalizedPublicTerms, [
            'both connections are',
            'disabled in this public-beta candidate',
            'If a future release enables one and you explicitly connect it',
        ]) &&
        !appShell.includes('GlobalNowPlayingBar') &&
        !viewRegistry.includes("import('./components/music/MusicPage')") &&
        !project.includes('AppleMusicPlugin.m in Sources') &&
        !project.includes('AppleMusicPlugin.swift in Sources') &&
        !bridgeViewController.includes('AppleMusicPlugin') &&
        !infoPlist.includes('NSAppleMusicUsageDescription'),
);
check(
    'incompatible Capacitor 3 UDP uplink is absent and AISHub fails closed in beta',
    includesAll(featureVisibility, ['aisHub: false']) &&
        !Object.hasOwn(pkg.dependencies ?? {}, '@frontall/capacitor-udp') &&
        !denoLock.includes('@frontall/capacitor-udp') &&
        !exists('types/capacitor-udp.d.ts') &&
        includesAll(read('services/AisHubService.ts'), [
            'AISHub contribution is unavailable in this public-beta build.',
            'forward(_sentence: string): void',
            'Intentionally inert',
        ]) &&
        !read('services/AisHubService.ts').includes('@frontall/capacitor-udp') &&
        !read('tests/aisHubService.test.ts').includes('@frontall/capacitor-udp') &&
        !podfile.includes('FrontallCapacitorUdp') &&
        !podfile.includes('@frontall/capacitor-udp') &&
        !podLock.includes('FrontallCapacitorUdp') &&
        !podLock.includes('@frontall/capacitor-udp') &&
        read('components/vessel/NmeaPage.tsx').includes('AISHub contribution unavailable in beta'),
);
check(
    'Vite client Supabase key has no generic server-key fallback',
    !viteConfig.includes("getKey('SUPABASE_KEY')") &&
        read('scripts/check-client-secrets.mjs').includes("payload?.role === 'anon'") &&
        read('scripts/check-client-secrets.mjs').includes('VITE_SUPABASE_SERVICE_ROLE_KEY'),
);
check(
    'automatic SSH provisioning is development-only',
    includesAll(read('services/PiProvisionService.ts'), [
        'PI_INTEGRATION_ENABLED && Capacitor.isNativePlatform()',
        'PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE',
    ]),
);

const recipeService = read('services/GalleyRecipeService.ts');
const recipeForm = read('components/chat/CustomRecipeForm.tsx');
const recipePhotoMigration = read('supabase/migrations/20260804193000_recipe_photo_ownership.sql');
check(
    'recipe media is owner-scoped and private photos fail closed',
    includesAll(recipeService, [
        'PrivateRecipePhotoUnavailableError',
        'recipePhotoStoragePath(ownerId, recipeId)',
        'retireRecipePhotoPaths',
        'retainUncertainOwnedMedia',
        'retireOwnedMedia',
        "status: 'pending'",
    ]) &&
        includesAll(recipeForm, [
            'privatePhotoBlocked',
            'Private photos are not available in beta',
            'Remove photo and keep private',
        ]) &&
        includesAll(recipePhotoMigration, [
            'Recipe photos owner upload',
            'Recipe photos owner update',
            'Recipe photos owner delete',
            "split_part(name, '/', 1) = auth.uid()::TEXT",
        ]),
);

const piClientBoundary = read('services/piPublicBetaBoundary.ts');
const piCacheClient = read('services/PiCacheService.ts');
const piPairingClient = read('services/PiPairingService.ts');
const piBoatNetwork = read('services/BoatNetworkService.ts');
const piDiaryClient = read('services/DiaryRelayTransport.ts');
const piBootstrap = read('hooks/useAppBootstrap.ts');
const piServer = read('pi-cache/src/server.ts');
const piServerBoundary = read('pi-cache/src/publicBetaBoundary.ts');
check(
    'Pi integration opens only for a build carrying the pinning verifier',
    includesAll(piClientBoundary, [
        'pinnedTransport: isPinnedTransportAvailable()',
        'return pinnedTransport === true || dev === true',
        'PI_DISABLED_BASE_URL',
    ]) &&
        // No build-time string may authorize the transport — every VITE_ value
        // is user-readable and user-settable.
        !/import\.meta\.env\.VITE_PI/.test(piClientBoundary) &&
        includesAll(piCacheClient, [
            "this.configure({ enabled: false, host: '', port: 3001 })",
            'return PI_INTEGRATION_ENABLED && this.config.enabled && this.status.reachable',
            'return PI_DISABLED_BASE_URL',
        ]) &&
        includesAll(piBoatNetwork, [
            'if (!PI_INTEGRATION_ENABLED) return null',
            'if (!PI_INTEGRATION_ENABLED) return;',
        ]) &&
        includesAll(piDiaryClient, [
            'if (!PI_INTEGRATION_ENABLED || !piCache.isAvailable()) return null',
            'if (!PI_INTEGRATION_ENABLED) return false',
        ]) &&
        includesAll(piBootstrap, [
            "import { PI_INTEGRATION_ENABLED } from '../services/piPublicBetaBoundary'",
            'if (!PI_INTEGRATION_ENABLED) return;',
            'AvNavService.autoStart()',
        ]),
);
check(
    'boat-LAN traffic is TLS pinned to the Pi pairing key, with no cleartext lane',
    // The certificate is issued from the key the app already pinned, so the
    // encrypted channel and the pairing identity are ONE trust decision.
    includesAll(read('pi-cache/src/tlsIdentity.ts'), [
        'TLS certificate public key does not match the Pi pairing identity',
        'ensureIdentityTls',
    ]) &&
        includesAll(piServer, ['https.createServer(', "minVersion: 'TLSv1.2'"]) &&
        // Private key stays off the object handed to route handlers.
        read('pi-cache/src/identity.ts').includes('export function readIdentityPrivateKeyPem') &&
        !read('pi-cache/src/routes/pair.ts').includes('privateKey') &&
        // Client: https only, every call through the pinning transport.
        piCacheClient.includes('return `https://${this.config.host}:${this.config.port}`') &&
        !/`http:\/\/\$\{/.test(piCacheClient) &&
        !/`http:\/\/\$\{/.test(piPairingClient) &&
        !piPairingClient.includes('CapacitorHttp') &&
        includesAll(read('services/piTls.ts'), [
            "if (!options.url.startsWith('https://'))",
            'isPinnedTransportAvailable',
        ]) &&
        // Pairing is bound to the channel that carried it.
        includesAll(piPairingClient, ['res.peerSpki !== data.publicKeySpki', 'if (!res.peerSpki)']) &&
        // Native: exactly one unpinned path, key-only trust, no app-wide ATS relaxation.
        includesAll(read('ios/App/App/PiTlsPlugin.swift'), [
            'private static let unpinnedPath = "/api/pair/info"',
            'if pin == nil && url.path != Self.unpinnedPath',
            'constantTimeEquals(presented, pinnedSpki)',
        ]) &&
        !read('ios/App/App/Info.plist').includes('NSAllowsArbitraryLoads') &&
        read('ios/App/App/ThalassaBridgeViewController.swift').includes(
            'bridge?.registerPluginInstance(PiTlsPlugin())',
        ),
);
check(
    'Pi controls are replaced by an unavailable notice where the pin cannot be checked',
    includesAll(read('components/ui/PiPublicBetaUnavailable.tsx'), [
        'Pi integration unavailable in this build',
        'No Pi discovery, setup,',
    ]) &&
        read('components/settings/PiCacheTab.tsx').includes('<PiPublicBetaUnavailable') &&
        read('components/vessel/AvNavPage.tsx').includes('<PiPublicBetaUnavailable'),
);
check(
    'Pi server defaults to loopback with private routes and ENC watcher disabled',
    includesAll(piServerBoundary, [
        "return env[LAN_BIND_FLAG] === '1' ? '0.0.0.0' : '127.0.0.1'",
        "return env[UNSAFE_ADMIN_FLAG] === '1'",
        "value.length > 0 && value !== '*'",
        'publicStatusPayload',
    ]) &&
        includesAll(piServer, [
            'https.createServer(',
            'server.listen(PORT, BIND_HOST',
            "app.post('/api/configure', requireUnsafeAdmin",
            "app.post('/cache/purge', requireUnsafeAdmin",
            "app.get('/api/passthrough', requireUnsafeAdmin",
            "app.use('/api/misc/proxy', requireUnsafeAdmin)",
            "UNSAFE_ADMIN_API_ENABLED && process.env.ENC_WATCHER_ENABLED === 'true'",
        ]),
);

const publicVoyageFreshness = read('src/publicVoyageFreshness.ts');
const publicVoyageDashboard = read('src/ThalassaDashboard.tsx');
const publicVoyageMap = read('src/components/MapContainer.tsx');
check(
    'public voyage logs age frozen telemetry and map contacts independently of polling',
    includesAll(publicVoyageFreshness, [
        'PUBLIC_POSITION_FRESH_MS',
        'PUBLIC_AIS_MAX_AGE_MS',
        "return 'expired'",
        "return 'last-known'",
    ]) &&
        includesAll(publicVoyageDashboard, [
            'DASHBOARD_CLOCK_MS',
            'setPollFailed(true)',
            'connectionLost={connectionLost}',
        ]) &&
        includesAll(publicVoyageMap, ['isPublicPositionFresh', "item.freshness !== 'expired'", 'Last known ·']),
);

// Chart/map licence and beta entitlement boundaries.
const offlineMaps = read('services/MapOfflineService.ts');
const encBootstrap = read('services/enc/bootstrapEncSamples.ts');
const encMetadata = read('services/enc/EncCellMetadata.ts');
const mapInit = read('components/map/useMapInit.ts');
const subscriptions = read('services/SubscriptionService.ts');
check(
    'public OSM/OpenSeaMap bulk prefetch is fail-closed',
    includesAll(offlineMaps, [
        'BULK_OFFLINE_PREFETCH_CAPABILITY',
        'enabled: false',
        'if (!BULK_OFFLINE_PREFETCH_CAPABILITY.enabled)',
    ]),
);
check(
    'demo ENC import requires an explicit non-production build',
    includesAll(encBootstrap, ['VITE_ENABLE_ENC_DEMO_SAMPLES', "mode === 'test'", "mode === 'demo'"]) &&
        !/return\s+explicit\s*;/.test(encBootstrap),
);
check(
    'production artifacts exclude ignored local ENC samples and Finder metadata',
    includesAll(viteConfig, [
        "name: 'release-public-input-fence'",
        "fs.rmSync(path.join(outDir, 'enc-samples')",
        "entry.name === '.DS_Store'",
        "mode === 'production' && releasePublicInputFence()",
    ]),
);
check(
    'demo ENC cells are excluded from live navigation',
    includesAll(encMetadata, ["cell.usage === 'demo'", 'isLiveNavigationCell']),
);
check(
    'map provider attribution is visible',
    includesAll(mapInit, ['attributionControl: true', 'Mapbox', 'MapTiler', 'OpenStreetMap contributors']),
);
check(
    'unsafe public development prototypes are absent',
    !exists('public/iboating.html') && !exists('public/wind_test.json'),
);
check(
    'public beta is free and paywalls resolve open',
    includesAll(subscriptions, ['PUBLIC_BETA_ACCESS', 'enabled: true', 'if (PUBLIC_BETA_ACCESS.enabled) return true']),
);

const terms = read('public/terms.html');
const normalizedTerms = terms.replace(/\s+/g, ' ');
const vercel = read('vercel.json');
const voyageLogHtml = read('logs.html');
const voyageLogApiHtml = read('public/voyage-log-api.html');
const diaryPublishModal = read('components/diary/DiaryPublishModal.tsx');
const voyageLogSettings = read('components/settings/VoyageLogTab.tsx');
const voyageLogService = read('services/VoyageLogService.ts');
const edgeMiddleware = read('middleware.ts');
const floatPlanTombstone = read('supabase/functions/float-plan/index.ts');
check(
    'live beta privacy/terms copy covers deletion, telemetry, sync, and location',
    includesAll(normalizedTerms, [
        'Version 2.1',
        '4 August 2026',
        'destructive in-app deletion flow is temporarily unavailable during this beta',
        'mailto:privacy@thalassa.app',
        'Sentry',
        'precise location',
        'syncs automatically',
        'www.thalassawx.app',
    ]),
);
check(
    'legacy public float-plan routes cannot expose or target a removed planning document',
    !vercel.includes('plan.html') &&
        includesAll(vercel, ['"source": "/float"', '"destination": "/logs"']) &&
        includesAll(floatPlanTombstone, [
            'Retired public float-plan endpoint',
            'status: 410',
            "'Cache-Control': 'no-store'",
        ]) &&
        !floatPlanTombstone.includes('SUPABASE_SERVICE_ROLE_KEY') &&
        !floatPlanTombstone.includes('ship_logs'),
);
check(
    'link-shared voyage logs are explicitly excluded from search indexes',
    voyageLogHtml.includes('name="robots" content="noindex, nofollow, noarchive"') &&
        includesAll(edgeMiddleware, ['X-Robots-Tag', 'noindex, nofollow, noarchive']),
);
check(
    'public voyage publication and API copy disclose the handle-based access boundary',
    includesAll(voyageLogApiHtml, [
        'intentionally public and does not use an API key',
        'Anyone who knows or guesses an',
        'enabled public handle can read the published feed',
        '?handle=demo-vessel&amp;trip=latest',
    ]) &&
        !/publishable API key|YOUR_PUBLISHABLE_KEY|[?&](?:amp;)?key=/.test(voyageLogApiHtml) &&
        includesAll(diaryPublishModal, [
            'Anyone who has or guesses your public handle can read it',
            'Unpublish it below to make it private again',
        ]) &&
        includesAll(voyageLogSettings, [
            'VoyageLogService.ensureConfigured()',
            'Your Voyage Log is switched off',
            'intentionally uses the public handle, not a secret key',
            'enabled: false',
        ]) &&
        !/publishable token|Reveal API key|Copy API key/.test(voyageLogSettings) &&
        includesAll(voyageLogService, ['ensureConfigured()', 'return this.ensureConfig(false)']),
);

// The artifact publishes a complete hold inventory, so each declaration must
// stay coupled to a source-level boundary. This prevents the manifest from
// becoming reassuring metadata while an independently gated surface reopens.
const heldCapabilitySourceContracts = {
    'apple-sign-in':
        publicBetaFeatureProfile.featureFlags.VITE_APPLE_SIGN_IN_ENABLED === false &&
        signInUi.includes("import.meta.env.VITE_APPLE_SIGN_IN_ENABLED === 'true'") &&
        !mainEntitlements.includes('com.apple.developer.applesignin'),
    'apple-watch-bridge':
        publicBetaFeatureProfile.featureFlags.VITE_APPLE_WATCH_ENABLED === false &&
        read('index.tsx').includes("import.meta.env.VITE_APPLE_WATCH_ENABLED === 'true'") &&
        !project.includes('Embed Watch Content'),
    'account-deletion':
        publicBetaFeatureProfile.featureFlags.VITE_ACCOUNT_DELETION_ENABLED === false &&
        accountDeletionBoundary.includes('Account deletion is temporarily unavailable'),
    gmail:
        publicBetaFeatureProfile.requiredAbsentClientConfig.includes('VITE_GOOGLE_OAUTH_CLIENT_ID') &&
        read('services/voice/integrations/gmail.ts').includes('GMAIL_PUBLIC_BETA_ENABLED = import.meta.env.DEV'),
    'grant-all-features':
        publicBetaFeatureProfile.featureFlags.VITE_GRANT_ALL_FEATURES === false &&
        read('hooks/useEntitlement.ts').includes('VITE_GRANT_ALL_FEATURES'),
    'enc-demo-samples':
        publicBetaFeatureProfile.featureFlags.VITE_ENABLE_ENC_DEMO_SAMPLES === false &&
        encBootstrap.includes(
            "return explicit && (import.meta.env?.DEV === true || mode === 'test' || mode === 'demo')",
        ),
    'private-weather-server':
        publicBetaFeatureProfile.featureFlags.VITE_WX_SERVER_ENABLED === false &&
        publicBetaFeatureProfile.publicEndpoints.VITE_WX_SERVER_BASE === '' &&
        wxServerSource.includes("if (!config.dev || config.enabled !== 'true') return ''"),
    'community-precise-track-sharing':
        /\bcommunityTrackSharing:\s*false\b/.test(featureVisibility) &&
        read('services/TrackSharingService.ts').includes('if (!FEATURE_VISIBILITY.communityTrackSharing)'),
    musickit:
        /\bappleMusic:\s*false\b/.test(featureVisibility) &&
        musicKitToken.includes('const MUSICKIT_PUBLIC_BETA_ENABLED = false'),
    'aishub-contribution':
        /\baisHub:\s*false\b/.test(featureVisibility) &&
        read('services/AisHubService.ts').includes('Intentionally inert'),
    'retired-public-float-plan':
        floatPlanTombstone.includes('Retired public float-plan endpoint') && floatPlanTombstone.includes('status: 410'),
    'calypso-proactive-alerts':
        /\bcalypsoAlerts:\s*false\b/.test(featureVisibility) &&
        alertMonitor.includes("FEATURE_VISIBILITY.calypsoAlerts || import.meta.env.MODE === 'test'"),
    billing:
        includesAll(subscriptions, [
            'PUBLIC_BETA_ACCESS',
            'enabled: true',
            'All public-beta features are unlocked at no charge',
        ]) && includesAll(read('components/UpgradeModal.tsx'), ['PUBLIC_BETA_ACCESS.message', 'Continue Exploring']),
    'private-recipe-photos':
        recipeService.includes('PrivateRecipePhotoUnavailableError') &&
        recipeForm.includes('Private photos are not available in beta'),
    'unverified-commercial-chart-packages':
        includesAll(read('services/ChartLockerService.ts'), [
            'chartPackageDistributionBlockReason',
            'source-hosted chart package is unavailable in the public beta',
            'getCommunityCatalog()',
        ]) && read('tests/ChartLockerTrust.test.ts').includes('restricts every reachable beta catalog'),
    'spoonacular-online-catalogue':
        /\bspoonacular:\s*false\b/.test(featureVisibility) &&
        read('services/spoonacularProxy.ts').includes('if (!FEATURE_VISIBILITY.spoonacular || !supabase) return null'),
    marketplace:
        includesAll(read('components/chat/ChannelList.tsx'), [
            "'Chandlery'",
            "'Marketplace'",
            'HIDDEN_CHANNEL_NAMES.has(ch.name)',
        ]) &&
        !exists('supabase/functions/create-marketplace-payment') &&
        !exists('supabase/functions/capture-escrow-payment') &&
        !exists('supabase/functions/sweep-expired-escrows') &&
        includesAll(read('supabase/migrations/20260729080000_drop_marketplace.sql'), [
            'DROP TABLE IF EXISTS public.marketplace_escrow CASCADE',
            'DROP TABLE IF EXISTS public.marketplace_listings CASCADE',
        ]),
};
const missingHeldCapabilitySourceContracts = PUBLIC_BETA_HELD_CAPABILITIES.filter(
    (name) => heldCapabilitySourceContracts[name] !== true,
);
const unexpectedHeldCapabilitySourceContracts = Object.keys(heldCapabilitySourceContracts).filter(
    (name) => !PUBLIC_BETA_HELD_CAPABILITIES.includes(name),
);
check(
    'every artifact-declared held capability has an exact source-level release boundary',
    missingHeldCapabilitySourceContracts.length === 0 && unexpectedHeldCapabilitySourceContracts.length === 0,
    `missing=${missingHeldCapabilitySourceContracts.join(', ') || 'none'}; unexpected=${
        unexpectedHeldCapabilitySourceContracts.join(', ') || 'none'
    }`,
);
check(
    'release dossier remains NO-GO and records every newly separated remote trust gate',
    includesAll(publicBetaReleaseDossier, [
        'Status: **NO-GO',
        'CMEMS/MPA producer, client, and hosted data trust',
        'LINZ/Maritime NZ MSI live writer',
        'Retired Railway vessel-scraper remote state',
        'Account-deletion durability, deployment, and authenticated smoke',
        'Distribution-signed',
        'privacy@thalassa.app',
    ]),
);

// Release builds must be made with real public configuration. CI uses
// --source-only because its artifact is not submitted to TestFlight.
if (!SOURCE_ONLY || CHECK_ARTIFACTS) {
    const runtimeNodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
    check('release and artifact gates run under Node 24', runtimeNodeMajor === 24, `runtime=${process.versions.node}`);
}

if (!SOURCE_ONLY) {
    const env = { ...loadEnv('production', ROOT, ''), ...process.env };
    const supabaseUrl = String(env.VITE_SUPABASE_URL ?? '').trim();
    const supabaseKey = String(env.VITE_SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_KEY ?? '').trim();
    const mapboxToken = String(env.VITE_MAPBOX_ACCESS_TOKEN ?? '').trim();
    const openWeatherMapKey = String(env.VITE_OWM_API_KEY ?? '').trim();
    const sentryDsn = String(env.VITE_SENTRY_DSN ?? '').trim();
    const appVersion = String(env.VITE_APP_VERSION ?? '').trim();

    check('release Supabase URL is configured', /^https:\/\/[^\s/]+(?:\/)?$/.test(supabaseUrl));
    check(
        'release Supabase publishable/anon key is configured',
        isPublishableSupabaseClientKey(supabaseKey),
        'only sb_publishable_ keys or legacy JWTs with role=anon may enter the client',
    );
    check('release Mapbox public token is configured', /^pk\.[A-Za-z0-9._-]{20,}$/.test(mapboxToken));
    check('release OpenWeatherMap client credential is present', openWeatherMapKey.length > 0);
    check('release Sentry ingest DSN is present', sentryDsn.length > 0);
    check(
        'release environment version matches package.json',
        appVersion === pkg.version,
        `env=${appVersion || 'missing'}, package=${pkg.version ?? 'missing'}`,
    );
}

if (CHECK_ARTIFACTS) {
    const dist = absolute('dist');
    const nativePublic = absolute('ios/App/App/public');
    const forbiddenGeneratedInput = (root) =>
        fs.existsSync(path.join(root, 'enc-samples')) ||
        (fs.existsSync(root) &&
            fs.readdirSync(root, { recursive: true }).some((entry) => path.basename(String(entry)) === '.DS_Store'));
    const featureArtifactFailures = (root) => {
        const target = path.join(root, PUBLIC_BETA_FEATURE_ARTIFACT_FILE);
        if (!fs.existsSync(target)) return [`${PUBLIC_BETA_FEATURE_ARTIFACT_FILE} is missing`];
        try {
            return publicBetaFeatureArtifactFailures(
                JSON.parse(fs.readFileSync(target, 'utf8')),
                publicBetaFeatureProfile,
                expectedPublicBetaCredentialPresence,
            );
        } catch (error) {
            return [
                `${PUBLIC_BETA_FEATURE_ARTIFACT_FILE} is invalid JSON: ${error instanceof Error ? error.message : error}`,
            ];
        }
    };
    const webFeatureArtifactFailures = featureArtifactFailures(dist);
    const nativeFeatureArtifactFailures = featureArtifactFailures(nativePublic);
    check(
        'web artifact exposes the deterministic public-beta feature profile',
        webFeatureArtifactFailures.length === 0,
        webFeatureArtifactFailures.join(', '),
    );
    check(
        'Capacitor artifact exposes the same deterministic public-beta feature profile',
        nativeFeatureArtifactFailures.length === 0,
        nativeFeatureArtifactFailures.join(', '),
    );
    check('web release bundle excludes ignored local public inputs', !forbiddenGeneratedInput(dist));
    check('Capacitor iOS web bundle exists', fs.existsSync(path.join(nativePublic, 'index.html')));
    check(
        'Capacitor iOS bundle contains generated assets',
        fs.existsSync(path.join(nativePublic, 'assets')) &&
            fs.readdirSync(path.join(nativePublic, 'assets')).length > 0,
    );
    check('Capacitor iOS bundle excludes ignored local public inputs', !forbiddenGeneratedInput(nativePublic));
    const copiedArtifactParity = copiedArtifactMismatches(dist, nativePublic);
    check(
        'Capacitor iOS bundle byte-matches every web release file',
        copiedArtifactParity.sourceFiles.length > 0 && copiedArtifactParity.mismatches.length === 0,
        copiedArtifactParity.sourceFiles.length === 0
            ? 'dist contains no regular files'
            : `mismatches=${copiedArtifactParity.mismatches.slice(0, 8).join(', ') || 'none'}${
                  copiedArtifactParity.mismatches.length > 8
                      ? ` (+${copiedArtifactParity.mismatches.length - 8} more)`
                      : ''
              }`,
    );
    check(
        'Capacitor iOS bundle contains no stale files beyond exact Cordova bridge extras',
        copiedArtifactParity.unexpectedExtras.length === 0,
        copiedArtifactParity.unexpectedExtras.length > 0
            ? `${copiedArtifactParity.unexpectedExtras.length} unexpected extra(s): ${copiedArtifactParity.unexpectedExtras
                  .slice(0, 8)
                  .join(', ')}`
            : '',
    );
}

if (failures.length) {
    console.error(`\n❌ Public beta readiness: ${failures.length} gate${failures.length === 1 ? '' : 's'} failed`);
    for (const failure of failures) console.error(`   - ${failure}`);
    console.error('\nNo TestFlight upload should be made from this tree.');
    process.exit(1);
}

console.log(
    `✅ Public beta readiness: ${passes.length} release contracts passed${SOURCE_ONLY ? ' (source-only)' : ''}.`,
);
if (!CHECK_ARTIFACTS)
    console.log('   Re-run with --artifacts after `npm run cap:sync` to verify the embedded web bundle.');
