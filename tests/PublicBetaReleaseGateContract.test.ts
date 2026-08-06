import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('public-beta release gate contract', () => {
    it('enforces Node 24 for release and artifact verification', () => {
        const gate = read('scripts/check-beta-readiness.mjs');
        const previewSmoke = read('.github/workflows/preview-smoke.yml');

        expect(gate).toContain('if (!SOURCE_ONLY || CHECK_ARTIFACTS)');
        expect(gate).toContain('const runtimeNodeMajor = Number.parseInt(process.versions.node.split');
        expect(gate).toContain('runtimeNodeMajor === 24');
        expect(previewSmoke).toContain('node-version: 24');
    });

    it('keeps protected preview credentials scoped to the exact default-branch candidate and origin', () => {
        const gate = read('scripts/check-beta-readiness.mjs');
        const previewSmoke = read('.github/workflows/preview-smoke.yml');
        const verifier = read('scripts/verify-web-release.mjs');
        const smoke = read('e2e/smoke.spec.ts');
        const trust = read('utils/vercelPreviewTrust.ts');

        expect(previewSmoke).toContain('ref: ${{ github.event.repository.default_branch }}');
        expect(previewSmoke).toContain('DEPLOYMENT_SHA: ${{ github.event.deployment.sha }}');
        expect(previewSmoke).toContain('candidate_sha="$(git rev-parse HEAD)"');
        expect(previewSmoke).toContain("if: needs.authorize.outputs.eligible == 'true'");
        expect(previewSmoke).toContain("github.actor == 'vercel[bot]'");
        expect(previewSmoke).toContain("github.event.deployment.creator.login == 'vercel[bot]'");
        expect(previewSmoke).toContain('environment: Preview');
        expect(previewSmoke).toContain(
            'VERCEL_AUTOMATION_BYPASS_SECRET: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}',
        );
        expect(verifier).toContain('sameOriginVercelRequestHeaders');
        expect(verifier).toContain('isTrustedThalassaVercelPreviewOrigin(origin)');
        expect(verifier).toContain('configure the repository VERCEL_AUTOMATION_BYPASS_SECRET before release smoke');
        expect(smoke).toContain('new URL(request.url()).origin !== PREVIEW_ORIGIN');
        expect(smoke).toContain("'x-vercel-protection-bypass': VERCEL_AUTOMATION_BYPASS_SECRET");
        expect(smoke).toContain('isTrustedThalassaVercelPreviewOrigin(new URL(PREVIEW_URL).origin)');
        expect(trust).toContain('THALASSA_VERCEL_PREVIEW_HOST.test(url.hostname.toLowerCase())');
        expect(gate).toContain(
            'hosted preview admits only the exact default-branch candidate before using the Vercel bypass secret',
        );
    });

    it('keeps enough CI headroom for the complete verification corpus', () => {
        const gate = read('scripts/check-beta-readiness.mjs');
        const workflow = read('.github/workflows/ci.yml');
        const timeoutMinutes = Number.parseInt(workflow.match(/^\s*timeout-minutes:\s*(\d+)\s*$/m)?.[1] ?? '', 10);

        expect(gate).toContain('ciTimeoutMinutes >= 45');
        expect(timeoutMinutes).toBeGreaterThanOrEqual(45);
    });

    it('makes formatting a required CI contract', () => {
        const gate = read('scripts/check-beta-readiness.mjs');
        const workflow = read('.github/workflows/ci.yml');

        expect(workflow).toContain('npm run format:check');
        expect(gate).toContain('CI enforces repository formatting');
    });

    it('pins every GitHub Action and hosted runner to a reviewed immutable release', () => {
        const gate = read('scripts/check-beta-readiness.mjs');
        const workflowNames = readdirSync(join(root, '.github/workflows')).filter((name) => /\.ya?ml$/i.test(name));
        const workflows = workflowNames.map((name) => ({ name, source: read(`.github/workflows/${name}`) }));
        const approvedPins = new Map([
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
        let usesCount = 0;

        for (const { name, source } of workflows) {
            expect(source, `${name} must declare top-level token permissions`).toMatch(
                /^permissions:\s*(?:\{\})?\s*$/m,
            );
            expect(source.replace(/^\s*#.*$/gm, ''), `${name} must not request blanket token access`).not.toMatch(
                /\b(?:read-all|write-all)\b/,
            );
            expect(source, `${name} must not float the hosted runner`).not.toContain('ubuntu-latest');
            const writePermissions = [...source.replace(/^\s*#.*$/gm, '').matchAll(/([A-Za-z0-9_-]+):\s*write\b/g)]
                .map((match) => match[1])
                .sort();
            const expectedWritePermissions =
                name === 'codeql.yml'
                    ? ['security-events']
                    : /^(?:cmems-(?:currents|waves|sst|chl|seaice|mld)|mpa)-pipeline\.yml$/.test(name)
                      ? ['contents']
                      : [];
            expect(writePermissions, `${name} must retain least-privilege writes`).toEqual(expectedWritePermissions);
            for (const runner of source.matchAll(/^\s*runs-on:\s*([^\s#]+)\s*$/gm)) {
                expect(runner[1], `${name} runner`).toBe('ubuntu-24.04');
            }
            for (const action of source.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(?:\s+#\s*(\S.*?))?\s*$/gm)) {
                usesCount += 1;
                const target = /^([^@\s]+)@([0-9a-f]{40})$/.exec(action[1]);
                expect(target, `${name}:${action[1]} must use a full commit SHA`).not.toBeNull();
                expect(approvedPins.get(target?.[1] ?? ''), `${name}:${action[1]} must use the reviewed SHA`).toBe(
                    target?.[2],
                );
                expect(action[2], `${name}:${action[1]} must retain an audit-friendly version comment`).toMatch(
                    /^v\d+\.\d+\.\d+$/,
                );
            }
        }

        expect(usesCount).toBeGreaterThan(0);
        expect(read('.github/workflows/ci.yml')).toContain('deno-version: v2.9.4');
        expect(read('.github/workflows/ci.yml')).not.toContain('deno-version: v2.x');
        expect(gate).toContain(
            'GitHub Actions use reviewed immutable pins, fixed runners, explicit permissions, and exact Deno',
        );
    });

    it('keeps retired Mapbox currents debug workflows as secretless inert tombstones', () => {
        const gate = read('scripts/check-beta-readiness.mjs');
        const workflows = [
            read('.github/workflows/cmems-currents-tile-probe.yml'),
            read('.github/workflows/cmems-currents-status.yml'),
        ];

        for (const workflow of workflows) {
            expect(workflow.match(/^\s*permissions:\s*\{\}\s*$/gm)).toHaveLength(2);
            expect(workflow).toContain('runs-on: ubuntu-24.04');
            expect(workflow).toContain('exit 78');
            expect(workflow).not.toMatch(/\$\{\{|secrets\.|MAPBOX_|api\.mapbox\.com|https?:\/\/|\bcurl\b/);
            expect(workflow).not.toMatch(/^\s*(?:-\s*)?uses:/m);
        }
        expect(gate).toContain(
            'retired Mapbox currents debug workflows are inert and cannot access secrets or networks',
        );
    });

    it('removes the retired CMEMS Mapbox publisher without removing the public map token', () => {
        const gate = read('scripts/check-beta-readiness.mjs');
        const obsoleteMarkers = [
            ['MAPBOX', 'UPLOAD', 'TOKEN'].join('_'),
            ['MAPBOX', 'USERNAME'].join('_'),
            ['VITE', 'MAPBOX', 'USERNAME'].join('_'),
            ['mapbox', 'tilesets'].join('-'),
            ['thalassa', 'currents', 'h'].join('-'),
        ];
        const retiredPublisherSurfaces = [
            read('scripts/cmems-currents-pipeline/README.md'),
            read('src/components/vite-env.d.ts'),
        ];

        for (const source of retiredPublisherSurfaces) {
            for (const marker of obsoleteMarkers) expect(source).not.toContain(marker);
        }
        expect(read('.env.example')).toContain('VITE_MAPBOX_ACCESS_TOKEN=');
        expect(read('src/components/vite-env.d.ts')).toContain('VITE_MAPBOX_ACCESS_TOKEN');
        expect(gate).toContain(
            'retired CMEMS Mapbox publisher has no credential, config, endpoint, or instruction surface',
        );
    });

    it('deterministically installs and verifies every active nested production package', () => {
        const workflow = read('.github/workflows/ci.yml');
        const requiredJobs = [
            {
                job: 'ais-ingest',
                workingDirectory: 'workers/ais-ingest',
                nodeVersion: '22',
                commands: ['npm ci', 'npm audit --audit-level=high', 'npm ls --all', 'npm run build', 'npm test'],
            },
            {
                job: 'deepgram-proxy',
                workingDirectory: 'cloudflare-worker',
                nodeVersion: '22',
                commands: [
                    'npm ci',
                    'npm audit --audit-level=high',
                    'npm ls --all',
                    './node_modules/.bin/tsc --noEmit',
                ],
            },
            {
                job: 'pi-cache',
                workingDirectory: 'pi-cache',
                nodeVersion: '20',
                commands: ['npm ci', 'npm audit --audit-level=high', 'npm ls --all', 'npm run build', 'npm test'],
            },
        ];
        const jobMatches = [...workflow.matchAll(/^ {4}([a-z0-9-]+):\s*$/gm)];
        const jobSection = (job: string) => {
            const matchIndex = jobMatches.findIndex((match) => match[1] === job);
            if (matchIndex < 0) return '';
            const start = jobMatches[matchIndex].index ?? 0;
            const end = jobMatches[matchIndex + 1]?.index ?? workflow.length;
            return workflow.slice(start, end);
        };

        for (const { job, workingDirectory, nodeVersion, commands } of requiredJobs) {
            const section = jobSection(job);
            const steps = section.split(/(?=^[ \t]*-[ \t]+(?:name|uses):)/m);
            const installStepIndex = steps.findIndex(
                (step) =>
                    step.match(/^\s*working-directory:\s*(.*?)\s*$/m)?.[1] === workingDirectory &&
                    step.match(/^\s*run:\s*(.*?)\s*$/m)?.[1] === 'npm ci',
            );

            expect(section, `missing ${job} job`).not.toBe('');
            expect(section).toContain(`node-version: ${nodeVersion}`);
            expect(section).toContain(`cache-dependency-path: ${workingDirectory}/package-lock.json`);
            expect(existsSync(join(root, `${workingDirectory}/package-lock.json`))).toBe(true);
            for (const run of commands) {
                expect(
                    steps.some(
                        (step) =>
                            step.match(/^\s*working-directory:\s*(.*?)\s*$/m)?.[1] === workingDirectory &&
                            step.match(/^\s*run:\s*(.*?)\s*$/m)?.[1] === run,
                    ),
                    `missing ${job} gate: ${run}`,
                ).toBe(true);
            }
            const immediateDependencySteps = steps.slice(installStepIndex, installStepIndex + 3);
            expect(
                immediateDependencySteps.map((step) => step.match(/^\s*run:\s*(.*?)\s*$/m)?.[1]),
                `${job} must audit immediately after npm ci`,
            ).toEqual(['npm ci', 'npm audit --audit-level=high', 'npm ls --all']);
            expect(
                immediateDependencySteps.map((step) => step.match(/^\s*working-directory:\s*(.*?)\s*$/m)?.[1]),
            ).toEqual([workingDirectory, workingDirectory, workingDirectory]);
        }
        expect(read('workers/ais-ingest/Dockerfile')).toContain('FROM node:22-slim');
        expect(read('pi-cache/install.sh')).toContain('https://deb.nodesource.com/setup_20.x');
    });

    it('makes production manifests and retired Railway state source release gates', () => {
        const gate = read('scripts/check-beta-readiness.mjs');

        expect(gate).toContain('AIS production packaging is a locked multi-stage Node 22 compiled non-root image');
        expect(gate).toContain(
            'Pi install and redeploy build from the lockfile then retain production dependencies only',
        );
        expect(gate).toContain('retired Railway vessel scraper has no runnable build, start, or cron path');
        expect(gate).toContain('\'CMD ["node", "dist/index.js"]\'');
        expect(gate).toContain("'npm prune --omit=dev --silent --no-audit'");
        expect(gate).toContain('!/\\b(?:cronSchedule|startCommand|buildCommand)\\b/');
    });

    it('makes the LINZ writer and MPA safety copy source release gates', () => {
        const gate = read('scripts/check-beta-readiness.mjs');

        expect(gate).toContain(
            'LINZ MSI writer is locked, non-cancelling, secret-isolated, and fail-closed before persistence',
        );
        expect(gate).toContain('run: npx --no-install playwright install chromium --with-deps');
        expect(gate).toContain('"if: github.ref == \'refs/heads/master\'"');
        expect(gate).toContain("!linzBrowserEnvironmentBoundary.includes('SUPABASE_SERVICE_ROLE_KEY')");
        expect(gate).toContain(
            'MPA popup presents inferred classes, authority verification, focus return, and a 44px dismiss target',
        );
        expect(gate).toContain("tone: '#f87171'");
        expect(gate).toContain("tone: '#fbbf24'");
        expect(gate).toContain("tone: '#60a5fa'");
        expect(gate).toContain('<div style="font-size: 11px; color: #cbd5e1;');
        expect(gate).toContain('<div style="font-size: 11px; color: #b6c2d1;');
        expect(gate).toContain('.mpa-popup .mapboxgl-popup-content {');
        expect(gate).toContain("!mpaPopupSource.includes('Recreational fishing usually permitted')");
        expect(gate).toContain('MPA helm control stays neutral about access, anchoring, and fishing rules');
        expect(gate).toContain('!radialHelmMpaBlock.includes("label: \'No-Go\'")');
        expect(gate).toContain('feature-gated MPA overlay has a reachable neutral map control');
        expect(gate).toContain("label: 'MPAs'");
        expect(gate).toContain('onToggle: () => weather.setMpaVisible(!weather.mpaVisible)');
        expect(gate).toContain('exposes a neutral MPA toggle in the mixed map-items category');
        expect(gate).toContain("name: 'MPAs, off'");
    });

    it('makes bounded CMEMS and MPA client trust a source release gate', () => {
        const gate = read('scripts/check-beta-readiness.mjs');

        expect(gate).toContain(
            'CMEMS maps fetch one verified frame with bounded ownership while routing remains no-network',
        );
        expect(gate).toContain('const output = new Uint8Array(maxBytes)');
        expect(gate).toContain('bytes.byteLength === THCU_HEADER_BYTES + cells * 9');
        expect(gate).toContain('CMEMS_FRAME_CACHE_LIMIT = 2');
        expect(gate).toContain('const file = manifest.files[requestedStep]');
        expect(gate).toContain('CMEMS_CURRENT_ROUTING_BETA_ENABLED = false');
        expect(gate).toContain('derives every CMEMS scrubber count from the inclusive manifest contract');
        expect(gate).toContain(
            'MPA client validates one bounded immutable asset, releases ownership, and aborts stale work before Mapbox',
        );
        expect(gate).toContain("requestController.abort(new Error('MPA layer hidden or unmounted'))");
        expect(gate).toContain('beforeGenerationAsset?.(manifest.generation)');
        expect(gate).toContain("!mpaLayer.includes('data: MPA_GEOJSON_URL')");
        expect(gate).toContain(
            'global current and wave trails are device-tiered with bounded persistent GPU ownership',
        );
    });

    it('makes marine producer, publisher, and proxy trust source release gates', () => {
        const gate = read('scripts/check-beta-readiness.mjs');
        const publisherWorkflows = ['currents', 'waves', 'sst', 'chl', 'seaice', 'mld']
            .map((dataset) => read(`.github/workflows/cmems-${dataset}-pipeline.yml`))
            .concat(read('.github/workflows/mpa-pipeline.yml'));

        for (const workflow of publisherWorkflows) {
            const start = workflow.indexOf('- name: Run offline publisher');
            const end = workflow.indexOf('\n            - name:', start + 1);
            const offlineStep = workflow.slice(start, end);
            expect(offlineStep).toContain("NO_PROXY: '127.0.0.1,localhost,::1'");
            for (const variable of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) {
                expect(offlineStep).toContain(`${variable}: 'http://127.0.0.1:9'`);
            }
            expect(offlineStep).toContain('export no_proxy="$NO_PROXY"');
            expect(offlineStep).toContain('export https_proxy="$HTTPS_PROXY"');
            expect(offlineStep).toContain('export http_proxy="$HTTP_PROXY"');
            expect(offlineStep).toContain('export all_proxy="$ALL_PROXY"');
            expect(offlineStep).not.toMatch(/^\s+(?:no_proxy|https_proxy|http_proxy|all_proxy):/gm);
            expect(workflow).not.toMatch(/^\s*no_proxy:\s*['"]?\*/gim);
            expect(offlineStep).not.toMatch(/export\s+no_proxy=['"]?\*/i);
            expect(offlineStep).not.toContain('${{ secrets.');
        }

        expect(gate).toContain(
            'marine publishers use reviewed-master, run-stable sealed artifacts and an isolated dual-slot writer',
        );
        expect(gate).toContain("python-version: '3.11.15'");
        expect(gate).toContain("!workflow.includes('3.11.11')");
        expect(gate).toContain(
            'marine producer contract validates source science and immutable weekly shards before dual-slot discovery publication',
        );
        expect(gate).toContain('marinePublisherTestCount === 53');
        expect(gate).toContain('12-hourly waves use one exact three-hour source-age margin without weakening currents');
        expect(gate).toContain('offline marine publisher fixtures have a localhost-only dead-proxy network fence');
        expect(gate).toContain('!/^\\s+(?:no_proxy|https_proxy|http_proxy|all_proxy):/gm.test(offlineStep)');
        expect(gate).toContain('!/^\\s*no_proxy:\\s*[\'"]?\\*/gim.test(workflow)');
        expect(gate).toContain('!/export\\s+no_proxy=[\'"]?\\*/i.test(offlineStep)');
        expect(gate).toContain(
            'marine release proxy streams verified weekly-shard assets and preserves dotted Vercel API routes',
        );
        expect(gate).toContain('streamVerifiedBody');
        expect(gate).toContain('async function cancelResponseBody(');
        expect(gate).toContain("await cancelResponseBody(upstream, 'upstream status rejected')");
        expect(gate).toContain("await cancelResponseBody(upstream, 'upstream content type rejected')");
        expect(gate).toContain("await cancelResponseBody(response, 'upstream content length rejected')");
    });

    it('retains canonical feature, deletion-hold, and Guardian opt-in release boundaries', () => {
        const gate = read('scripts/check-beta-readiness.mjs');

        expect(gate).toContain('readPublicBetaFeatureProfile(ROOT)');
        expect(gate).toContain(
            'committed public-beta profile owns the exact map features, holds, endpoints, and credential policy',
        );
        expect(gate).toContain("connect-src 'self' data: http: https://thalassawx.vercel.app");
        expect(gate).toContain("const DEFAULT_NATIVE_BASE = 'https://thalassawx.vercel.app/api'");
        expect(gate).toContain('production account deletion is held before UI exposure or destructive invocation');
        expect(gate).toContain('Guardian AIS watchdog is a tested exact opt-in and defaults off for public beta');
    });

    it('keeps unresolved remote trust gates explicit in the release dossier', () => {
        const gate = read('scripts/check-beta-readiness.mjs');

        expect(gate).toContain('release dossier remains NO-GO and records every newly separated remote trust gate');
        expect(gate).toContain("'CMEMS/MPA producer, client, and hosted data trust'");
        expect(gate).toContain("'LINZ/Maritime NZ MSI live writer'");
        expect(gate).toContain("'Retired Railway vessel-scraper remote state'");
    });

    it('audits a freshly built, configured app shell on the exact preview port', () => {
        const gate = read('scripts/check-beta-readiness.mjs');
        const runner = read('scripts/run-lighthouse-audit.mjs');
        const ci = read('.github/workflows/ci.yml');
        const lighthouse = read('.github/workflows/lighthouse.yml');
        const preview = read('.github/workflows/preview-smoke.yml');

        for (const workflow of [ci, lighthouse]) {
            expect(workflow).toContain('VITE_SUPABASE_URL: ${{ vars.VITE_SUPABASE_URL }}');
            expect(workflow).toContain('VITE_SUPABASE_KEY: ${{ vars.VITE_SUPABASE_KEY }}');
            expect(workflow).toContain('VITE_MAPBOX_ACCESS_TOKEN: ${{ vars.VITE_MAPBOX_ACCESS_TOKEN }}');
            expect(workflow).toContain('VITE_APP_VERSION: ${{ vars.VITE_APP_VERSION }}');
            expect(workflow).toContain('npm run check:beta');
            expect(workflow).toContain('id: lighthouse-audit');
            expect(workflow).toMatch(
                /id:\s*lighthouse-audit\s*\n\s*timeout-minutes:\s*5\s*\n\s*run:\s*node scripts\/run-lighthouse-audit\.mjs/,
            );
            expect(workflow).toContain("if: ${{ always() && steps.lighthouse-audit.outcome != 'skipped' }}");
            expect(workflow).toContain('include-hidden-files: true');
            expect(workflow).toContain('if-no-files-found: error');
        }
        expect(runner).toContain('await rm(reportDirectory, { recursive: true, force: true })');
        expect(runner).toContain('async function closeBrowserBounded(');
        expect(runner).toContain("browserProcess.kill('SIGKILL')");
        expect(runner).toContain('if (browser) await closeBrowserBounded(browser)');
        expect(runner).toContain("require.resolve('vite/package.json')");
        expect(runner).toContain('spawn(process.execPath, [viteCli');
        expect(runner).not.toContain("spawn('npm'");
        expect(runner).toContain("'--strictPort'");
        expect(lighthouse).not.toContain('pull-requests: write');
        expect(preview).not.toContain('statuses: write');
        expect(gate).toContain('CI production builds require the complete public client configuration');
        expect(gate).toContain('release workflows keep read-only repository permissions');
    });

    it('runs release E2E against dist and hosted smoke against only the deployment', () => {
        const gate = read('scripts/check-beta-readiness.mjs');
        const playwright = read('playwright.config.ts');
        const ci = read('.github/workflows/ci.yml');
        const preview = read('.github/workflows/preview-smoke.yml');

        expect(playwright).toContain('const hostedPreviewUrl = process.env.PREVIEW_URL?.trim()');
        expect(playwright).toContain("const localReleaseUrl = 'http://127.0.0.1:4173'");
        expect(playwright).toContain("command: 'npm run preview -- --host 127.0.0.1 --strictPort'");
        expect(playwright).toContain('webServer: hostedPreviewUrl');
        expect(playwright).toContain('reuseExistingServer: false');
        expect(playwright).toContain("const requireHostedPreview = process.env.REQUIRE_HOSTED_PREVIEW === 'true'");
        expect(playwright).toContain('Refusing to test localhost');
        expect(playwright).not.toContain("command: 'npm run dev'");
        expect(ci).not.toContain('--reporter=list');
        expect(preview).not.toContain('--reporter=list');
        expect(preview).toContain("REQUIRE_HOSTED_PREVIEW: 'true'");
        expect(gate).toContain('browser E2E audits the production artifact and isolates hosted-preview smoke');
    });

    it('rejects contradictory source-only and artifact verification modes', () => {
        const gate = read('scripts/check-beta-readiness.mjs');

        expect(gate).toContain('if (SOURCE_ONLY && CHECK_ARTIFACTS)');
        expect(gate).toContain('--source-only and --artifacts are mutually exclusive release-gate modes');
    });

    it('makes local-only ENC samples and Finder metadata impossible in a production artifact', () => {
        const gate = read('scripts/check-beta-readiness.mjs');
        const vite = read('vite.config.ts');

        expect(vite).toContain("name: 'release-public-input-fence'");
        expect(vite).toContain("fs.rmSync(path.join(outDir, 'enc-samples')");
        expect(vite).toContain("entry.name === '.DS_Store'");
        expect(gate).toContain('web release bundle excludes ignored local public inputs');
        expect(gate).toContain('Capacitor iOS bundle excludes ignored local public inputs');
    });

    it('requires every web release file to be copied byte-identically into the iOS bundle', () => {
        const gate = read('scripts/check-beta-readiness.mjs');

        expect(gate).toContain("import { createHash } from 'node:crypto'");
        expect(gate).toContain('function regularFilesRecursively(root)');
        expect(gate).toContain('function copiedArtifactMismatches(sourceRoot, copiedRoot)');
        expect(gate).toContain("createHash('sha256').update(fs.readFileSync(file)).digest('hex')");
        expect(gate).toContain('Capacitor iOS bundle byte-matches every web release file');
        expect(gate).toContain('copiedArtifactParity.sourceFiles.length > 0');
        expect(gate).toContain('copiedArtifactParity.mismatches.length === 0');
    });

    it('keeps every iOS build configuration at the iOS 17 public-beta floor', () => {
        const gate = read('scripts/check-beta-readiness.mjs');
        const project = read('ios/App/App.xcodeproj/project.pbxproj');
        const targets = [...project.matchAll(/IPHONEOS_DEPLOYMENT_TARGET\s*=\s*([^;]+);/g)].map((match) =>
            match[1].trim(),
        );

        expect(gate).toContain("iosDeploymentTargets[0] === '17.0'");
        expect(targets.length).toBeGreaterThanOrEqual(4);
        expect(new Set(targets)).toEqual(new Set(['17.0']));
    });

    it('keeps CocoaPods reproducible on the locked Ruby 4 and Xcode project format', () => {
        const gate = read('scripts/check-beta-readiness.mjs');
        const gemfile = read('ios/App/Gemfile');
        const gemLock = read('ios/App/Gemfile.lock');
        const podfile = read('ios/App/Podfile');

        expect(gemfile).toContain("gem 'nkf'");
        expect(gemLock).toContain('nkf (');
        expect(gemLock).toContain('BUNDLED WITH\n  4.0.3');
        expect(podfile).toContain("require 'xcodeproj'");
        expect(podfile).toContain("compatibility_versions.merge(70 => 'Xcode 16.0').freeze");
        expect(gate).toContain('locked CocoaPods toolchain supports Ruby 4 and Xcode object version 70');
    });

    it('enforces the documented 11px operational-text floor for legacy utility sizes', () => {
        const css = read('index.css');

        for (const size of ['8px', '9px', '10px', '10.5px']) {
            expect(css).toContain(`[class~='text-[${size}]']`);
        }
        expect(css).toContain('font-size: var(--text-micro) !important');
        expect(css).toMatch(/--text-micro:\s*11px/);
    });

    it('locks the native privacy inventory and safety entitlement to the shipped data flows', () => {
        const gate = read('scripts/check-beta-readiness.mjs');
        const privacy = read('ios/App/App/PrivacyInfo.xcprivacy');
        const entitlements = read('ios/App/App/App.entitlements');
        const watchEntitlements = read('ios/App/ThalassaWatch Watch App/ThalassaWatch Watch App.entitlements');
        const requiredTypes = [
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

        expect(gate).toContain('requiredMainCollectedDataTypes');
        for (const dataType of requiredTypes) expect(privacy).toContain(`<string>${dataType}</string>`);
        expect(privacy).toContain('<string>NSPrivacyAccessedAPICategoryUserDefaults</string>');
        expect(privacy).toContain('<string>CA92.1</string>');
        expect(privacy).toContain('<string>NSPrivacyAccessedAPICategoryFileTimestamp</string>');
        expect(privacy).toContain('<string>C617.1</string>');
        expect(entitlements).toContain('<key>com.apple.developer.usernotifications.time-sensitive</key>');
        expect(entitlements).toMatch(/com\.apple\.developer\.usernotifications\.time-sensitive<\/key>\s*<true\/>/);
        expect(watchEntitlements).not.toContain('com.apple.security.application-groups');
        expect(watchEntitlements).not.toContain('group.com.thalassa.weather');
    });

    it('keeps Apple Music and the removed AISHub UDP bridge fail-closed in the public beta', () => {
        const gate = read('scripts/check-beta-readiness.mjs');
        const settings = read('components/settings/CalypsoIntegrationsTab.tsx');
        const orchestrator = read('services/voice/orchestrator.ts');
        const terms = read('public/terms.html');
        const project = read('ios/App/App.xcodeproj/project.pbxproj');
        const bridge = read('ios/App/App/ThalassaBridgeViewController.swift');
        const info = read('ios/App/App/Info.plist');
        const podfile = read('ios/App/Podfile');
        const podLock = read('ios/App/Podfile.lock');
        const aisHubTest = read('tests/aisHubService.test.ts');

        expect(settings).toContain('!FEATURE_VISIBILITY.appleMusic ? (');
        expect(settings).toContain('Apple Music unavailable in public beta');
        expect(orchestrator).toContain('Apple Music controls are unavailable in this public beta');
        expect(orchestrator).not.toContain('Apple Music tools are available whenever');
        expect(terms).toContain('disabled in this public-beta candidate');
        expect(project).not.toContain('AppleMusicPlugin.m in Sources');
        expect(project).not.toContain('AppleMusicPlugin.swift in Sources');
        expect(bridge).not.toContain('AppleMusicPlugin');
        expect(info).not.toContain('NSAppleMusicUsageDescription');

        expect(existsSync(join(root, 'types/capacitor-udp.d.ts'))).toBe(false);
        expect(podfile).not.toContain('FrontallCapacitorUdp');
        expect(podfile).not.toContain('@frontall/capacitor-udp');
        expect(podLock).not.toContain('FrontallCapacitorUdp');
        expect(podLock).not.toContain('@frontall/capacitor-udp');
        expect(aisHubTest).not.toContain('@frontall/capacitor-udp');
        expect(gate).toContain("!exists('types/capacitor-udp.d.ts')");
        expect(gate).toContain("!podLock.includes('FrontallCapacitorUdp')");
    });

    it('makes the TN3194 Apple token lifecycle a source-controlled beta gate', () => {
        const gate = read('scripts/check-beta-readiness.mjs');
        const config = read('supabase/config.toml');
        const entitlements = read('ios/App/App/App.entitlements');

        expect(gate).toContain(
            'native Apple auth retains a revocable credential only through the authenticated server',
        );
        expect(gate).toContain('Apple refresh tokens are service-role-only and revoked before account deletion');
        expect(gate).toContain('Apple sign-in stays compile-time gated on its flag');
        // AGREEMENT replaced ABSENCE on 2026-08-06 so the gate stays honest in
        // both directions: flag on without the entitlement is a button that
        // dies at Apple, the entitlement without the flag is a capability
        // claimed and never used. The entitlement must therefore track the
        // committed flag rather than simply be missing.
        expect(gate).toContain('the Sign in with Apple entitlement agrees with the Apple sign-in flag');
        const appleFlagOn =
            JSON.parse(read('config/public-beta-features.json')).featureFlags.VITE_APPLE_SIGN_IN_ENABLED === true;
        expect(entitlements.includes('<key>com.apple.developer.applesignin</key>')).toBe(appleFlagOn);
        expect(gate).toContain('native Apple credential revocation is identity-matched and fences the local session');
        expect(gate).toContain(
            'Apple server notifications are signature-verified and durably queued without claiming deletion',
        );
        expect(gate).toContain('APPLE_REFRESH_TOKEN_ENCRYPTION_KEY');
        expect(config).toMatch(/\[functions\.register-apple-token\][\s\S]*?verify_jwt = true/);
        expect(config).toMatch(/\[functions\.apple-server-notification\][\s\S]*?verify_jwt = false/);
    });
});
