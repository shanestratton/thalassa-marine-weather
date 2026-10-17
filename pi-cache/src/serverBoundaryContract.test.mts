import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
const appJsonSource = readFileSync(new URL('./appJson.ts', import.meta.url), 'utf8');
function assertAdminBodyParser() {
    assert.match(source, /app\.use\(createAppJsonParser\(UNSAFE_ADMIN_API_ENABLED\)\)/);
    assert.match(appJsonSource, /unsafeAdmin \? '100mb' : '64kb'/);
}
const proxySource = readFileSync(new URL('./proxy.ts', import.meta.url), 'utf8');
const encRouteSource = readFileSync(new URL('./routes/enc.ts', import.meta.url), 'utf8');
const chartRouteSource = readFileSync(new URL('./routes/charts.ts', import.meta.url), 'utf8');
const diaryRelaySource = readFileSync(new URL('./diaryRelayOutbox.ts', import.meta.url), 'utf8');
const osmServiceSource = readFileSync(new URL('./services/osm.ts', import.meta.url), 'utf8');
const ownedOsmSource = readFileSync(new URL('./ownedOsm.ts', import.meta.url), 'utf8');
const governorSource = readFileSync(new URL('./workloadGovernor.ts', import.meta.url), 'utf8');
const resourceBoundarySource = readFileSync(new URL('./resourceBoundary.ts', import.meta.url), 'utf8');
const watcherSource = readFileSync(new URL('./encWatcher.ts', import.meta.url), 'utf8');
const reconvertSource = readFileSync(new URL('./encSourceReconvert.ts', import.meta.url), 'utf8');
const installerSource = readFileSync(new URL('./oChartsInstaller.ts', import.meta.url), 'utf8');

test('server binds through the loopback-default policy and restricts CORS', () => {
    assert.match(source, /server\.listen\(PORT, BIND_HOST/);
    assert.match(source, /CORS_ORIGINS\.has\(origin\)/);
    assert.doesNotMatch(source, /app\.use\(cors\(\)\)/);
});

test('the API is served over TLS anchored to the pairing identity', () => {
    // The app validates this certificate by comparing its public key to the
    // one it pinned at pairing, so express must never be handed to a plain
    // http listener — there is no CA to fall back on and no cleartext lane.
    assert.match(source, /https\.createServer\(\{ key: tls\.keyPem, cert: tls\.certPem/);
    assert.match(source, /minVersion: 'TLSv1\.2'/);
    assert.doesNotMatch(source, /http\.createServer\(app\)/);
});

test('the plaintext port is a signpost, never a data path or a redirect', () => {
    // A 30x would put the requested path back on the wire in clear, which is
    // exactly what the TLS switch was for.
    const signpost = source.slice(source.indexOf('const plaintextSignpost'));
    assert.match(signpost, /writeHead\(400/);
    assert.doesNotMatch(signpost, /writeHead\(30\d/);
    assert.doesNotMatch(signpost, /Location/);
});

test('only what the app never calls keeps the unsafe-admin gate', () => {
    /* Rewritten 2026-08-30. This used to pin /api/configure, /cache/purge and
       both passthroughs here too — but the APP calls every one of them, so the
       flag could never be turned off, so it protected nothing while keeping the
       surface below permanently reachable beside it. A gate that must always be
       open is not a gate.

       What stays is what the app genuinely never calls: a raw arbitrary-upstream
       proxy, and download/delete of arbitrary chart sets. Both can now default
       off on a stock Pi. */
    assert.match(source, /app\.use\('\/api\/misc\/proxy', requireUnsafeAdmin\)/);
    assert.match(source, /app\.use\('\/api\/charts', requireUnsafeAdmin\)/);
    // Hosting the built web app, and the 100 MB body limit that only the chart
    // upload path needs, are administration too.
    assert.match(source, /UNSAFE_ADMIN_API_ENABLED && fs\.existsSync/);
    assertAdminBodyParser();
});

test('the endpoints the app calls are behind the APP gate, not the admin one', () => {
    // Each of these has live call sites in the iOS app. Behind the unsafe flag
    // they forced it on; behind the app gate they default on, which is what the
    // app needs, and the unsafe flag is free to default off.
    for (const route of [
        "app.get('/api/admin/status', requireAppApi",
        "app.post('/api/configure', requireAppApi",
        "app.post('/cache/purge', requireAppApi",
        "app.get('/api/passthrough', requireAppApi",
        "app.get('/api/passthrough-tile', requireAppApi",
        "app.use('/api/remote-access', requireAppApi",
    ]) {
        assert.equal(source.includes(route), true, `${route} is not on the app gate`);
    }
    // And none of them may quietly slide back onto the admin gate.
    assert.doesNotMatch(
        source,
        /app\.(get|post|use)\('\/api\/(configure|passthrough|passthrough-tile|admin\/status|remote-access)', requireUnsafeAdmin/,
    );
    assert.doesNotMatch(source, /app\.post\('\/cache\/purge', requireUnsafeAdmin/);
});

test('app routes are gated separately from admin, and never left ungated', () => {
    // Split 2026-08-07. Pairing and chart sync ARE the product; requiring the
    // unsafe-admin flag for them meant the only way to pair a phone was to
    // also expose /api/misc/proxy and a 100 MB body limit. They keep their own
    // gate — the invariant is that each prefix is guarded by SOMETHING, and
    // specifically not by the admin flag.
    for (const prefix of ['/api/enc', '/api/osm', '/api/pair', '/api/diary']) {
        assert.equal(source.includes(`'${prefix}'`), true, `${prefix} is absent from the gated prefix list`);
    }
    assert.match(source, /app\.use\(prefix, requireAppApi\)/);
    assert.match(source, /if \(APP_API_ENABLED\) \{/);
    // The old shared loop must be gone, or the split is cosmetic.
    assert.doesNotMatch(source, /app\.use\(prefix, requireUnsafeAdmin\)/);
});

test('the seabed routes are mounted behind the same app gate', () => {
    // Seabed mapping (2026-10-05) mounts /api/seabed from its own attach call so
    // the staged Pi install stays one import and one call. The invariant is the
    // same as for the prefixes above: the app gate, never ungated, never admin.
    const attachSource = readFileSync(new URL('./seabed/attach.ts', import.meta.url), 'utf8');
    assert.match(source, /attachSeabed\(\{[\s\S]*?appApiEnabled: APP_API_ENABLED,[\s\S]*?requireAppApi,[\s\S]*?\}\);/);
    assert.match(attachSource, /if \(options\.appApiEnabled\) \{\s*app\.use\(\s*'\/api\/seabed',/);
    assert.match(attachSource, /\} else \{\s*app\.use\('\/api\/seabed', requireAppApi\);/);
    assert.doesNotMatch(attachSource, /requireUnsafeAdmin/);
    assert.equal(
        (attachSource.match(/app\.use\(/g) ?? []).length,
        3,
        'mounted here, gated here, 503 when it cannot start',
    );
});

test('the app gate is a real gate — it can still refuse', () => {
    // Defaulting ON is a deliberate choice (see publicBetaBoundary), but a
    // gate that cannot say no is not a boundary. THALASSA_PI_APP_API=0 must
    // still shut these routes with their own distinct code.
    assert.match(source, /const requireAppApi: express\.RequestHandler/);
    assert.match(source, /appApiDisabledPayload\(\)/);
    assert.match(source, /res\.status\(503\)\.json\(appApiDisabledPayload\(\)\)/);
});

test('app hosting requires unsafe opt-in; the ENC watcher keeps its OWN gate', () => {
    /* Serving the built app off the Pi stays behind the unsafe flag — it is
       hosting, and hosting is administration.

       The ENC watcher used to be behind it too, and that was a public-beta
       posture worth keeping: a punter's Pi should not run a filesystem watcher
       spawning decrypt subprocesses unless asked. But the posture is
       "default off", not "only available alongside a proxy" — and while the
       two were welded together, the only way to have automatic chart
       decryption was to ALSO expose /api/misc/proxy, /api/passthrough, a config
       writer, a cache purge, remote access and arbitrary chart download/delete.
       So the flag stayed on and the door stayed open (Shane 2026-08-30).

       ENC_WATCHER_ENABLED is itself explicit and defaults off, so the beta
       protection is intact — it now rests on its own gate instead of borrowing
       one that carries far more with it. */
    assert.match(source, /UNSAFE_ADMIN_API_ENABLED && fs\.existsSync/);
    assert.match(source, /if \(process\.env\.ENC_WATCHER_ENABLED === 'true'\) \{/);
    assert.doesNotMatch(source, /UNSAFE_ADMIN_API_ENABLED && process\.env\.ENC_WATCHER_ENABLED/);
});

test('public status is built only from the redacted payload helper', () => {
    const statusStart = source.indexOf("app.get('/status'");
    const nextRoute = source.indexOf("app.get('/api/admin/status'", statusStart);
    const statusBlock = source.slice(statusStart, nextRoute);
    assert.match(statusBlock, /publicStatusPayload/);
    assert.doesNotMatch(statusBlock, /PREFETCH_|ownerId|diaryRelay|cacheDir/);
});

function assertOwnedOsmOutboundChain(server: string, service: string, transport: string) {
    // The service's old public OVERPASS_URL sink is retired. Follow the actual
    // production injection through the owned Edge adapter to its pinned default.
    assert.match(server, /import \{ fetchOwnedOverlayReply \} from '\.\/ownedOsm\.js'/);
    assert.match(
        server,
        /createOsmRoutes\(\(bbox, options\) =>\s*getOsmOverlay\(bbox, options, \{\s*fetchOverpass: \(request\) => fetchOwnedOverlayReply\(proxyConfig, request\),\s*\}\)/,
    );
    assert.match(service, /const response = await fetchOverpass\(\{\s*method: 'POST'/);
    assert.match(transport, /import \{ outboundFetch \} from '\.\/outboundHttp\.js'/);
    assert.match(transport, /fetcher: OwnedOsmFetch = outboundFetch,/);
    assert.match(transport, /const document = await fetchOwnedOsmEdge\(config, operation, request\.signal\)/);
    assert.match(transport, /const response = await fetcher\(supabaseEdgeUrl\(config, 'owned-overpass'\), \{/);
    assert.doesNotMatch(service, /\bfetch\s*\(/, 'Overpass service retained a direct fetch sink');
    assert.doesNotMatch(transport, /\bfetch\s*\(/, 'owned Overpass adapter retained a direct fetch sink');
}

test('all user-directed upstream requests cross the pinned outbound policy', () => {
    for (const [name, routeSource] of [
        ['ENC', encRouteSource],
        ['chart', chartRouteSource],
    ] as const) {
        assert.match(routeSource, /outboundFetch/);
        assert.doesNotMatch(routeSource, /\bfetch\s*\(/, `${name} route retained a direct fetch sink`);
    }
    assert.match(proxySource, /import \{ outboundFetch \}/);
    assert.doesNotMatch(proxySource, /\bfetch\s*\(/, 'generic proxy retained a direct fetch sink');
    assertOwnedOsmOutboundChain(source, osmServiceSource, ownedOsmSource);
});

test('the owned OSM boundary contract rejects bypassed injection, policy, destination and cancellation', () => {
    for (const [server, service, transport] of [
        [
            source.replace('fetchOwnedOverlayReply(proxyConfig, request)', 'otherTransport(proxyConfig, request)'),
            osmServiceSource,
            ownedOsmSource,
        ],
        [
            source,
            osmServiceSource.replace(
                'const response = await fetchOverpass({',
                'const response = await otherTransport({',
            ),
            ownedOsmSource,
        ],
        [
            source,
            osmServiceSource,
            ownedOsmSource.replace(
                'fetcher: OwnedOsmFetch = outboundFetch,',
                'fetcher: OwnedOsmFetch = otherTransport,',
            ),
        ],
        [
            source,
            osmServiceSource,
            ownedOsmSource.replace(
                "supabaseEdgeUrl(config, 'owned-overpass')",
                "supabaseEdgeUrl(config, 'other-endpoint')",
            ),
        ],
        [
            source,
            osmServiceSource,
            ownedOsmSource.replace(
                'fetchOwnedOsmEdge(config, operation, request.signal)',
                'fetchOwnedOsmEdge(config, operation, undefined)',
            ),
        ],
        [source, osmServiceSource + '\nfetch("https://bypass.example");', ownedOsmSource],
        [source, osmServiceSource, ownedOsmSource + '\nfetch("https://bypass.example");'],
    ]) {
        assert.throws(() => assertOwnedOsmOutboundChain(server, service, transport));
    }
});

test('both ENC routing surfaces answer routing-on-phone and the watch process loads no router (127-C-d)', () => {
    // Routing runs on the phone in this build (decision 9). The engine mirror
    // stays in the tree for the vault's brain (128), but routes/enc.ts no longer
    // imports it, so nothing CPU-bound about charts runs in the watch's thread.
    assert.match(encRouteSource, /router\.post\('\/route', routingOnPhone\)/);
    assert.match(encRouteSource, /router\.post\('\/route-prepped', routingOnPhone\)/);
    assert.match(encRouteSource, /res\.status\(503\)\.json\(\{ code: 'routing-on-phone'/);
    assert.doesNotMatch(encRouteSource, /routeInshore|inshoreRouter|validateInshoreRouteBoundary/);
});

test('all Pi chart conversion, installation, download and routing entry points share bounded lanes', () => {
    assert.match(governorSource, /conversion: Object\.freeze\(\{ activeLimit: 1, queueLimit: 2/);
    assert.match(governorSource, /route: Object\.freeze\(\{ activeLimit: 1, queueLimit: 2/);
    assert.match(governorSource, /PI_WORKLOAD_BUSY/);
    assert.match(encRouteSource, /Retry-After/);
    assert.match(chartRouteSource, /Retry-After/);

    const convertStart = encRouteSource.indexOf("router.post('/convert'");
    const urlInstallStart = encRouteSource.indexOf("router.post('/install-from-url'");
    const installedStart = encRouteSource.indexOf("router.get('/installed'", urlInstallStart);
    const publicInstallStart = encRouteSource.indexOf("router.post('/install-public'");
    const healthStart = encRouteSource.indexOf("router.get('/health'", publicInstallStart);
    assert.match(encRouteSource.slice(convertStart, urlInstallStart), /reserveConversionUpload, rawBodyParser/);
    assert.ok(
        encRouteSource.indexOf("acquireRequestWorkload(req, res, 'conversion')") <
            encRouteSource.indexOf("router.post('/convert'"),
        'conversion upload admission must run before the raw body parser allocates request buffers',
    );
    assert.match(encRouteSource.slice(urlInstallStart, installedStart), /piWorkloadGovernor\.submit\('conversion'/);
    assert.match(
        encRouteSource.slice(publicInstallStart, healthStart),
        /acquireRequestWorkload\(req, res, 'conversion'\)/,
    );
    assert.match(chartRouteSource.slice(chartRouteSource.indexOf("router.post('/download'")), /submit\('conversion'/);
    // No spawn site at all since Pi update 3 (127-C-d decision 11): the
    // watcher and the re-conversion decrypt nothing; the chart vault opens
    // o-charts sets in its own memory. The S-63 extract and the ChartWorld
    // poller went in 127 (S-63 opens in OpenCPN only).
    for (const [name, text] of [
        ['encWatcher', watcherSource],
        ['encSourceReconvert', reconvertSource],
        ['oChartsInstaller', installerSource],
    ] as const) {
        assert.doesNotMatch(text, /child_process|spawn\(|decryptBatch\.ts/, `${name} starts no converter`);
        assert.doesNotMatch(text, /admit\('conversion'\)/, `${name} takes no conversion lane`);
    }
    assert.equal(existsSync(new URL('./chartworldSync.ts', import.meta.url)), false);
    assert.ok(source.indexOf('startSourceReconvert()') > source.indexOf('startEncWatcher();'));
});

test('a service stop never cuts a chart re-conversion off inside a publication', () => {
    // An exit inside publishChartDelivery leaves enc-charts/.index.lock behind,
    // which the store never reclaims: every later chart write fails
    // chart-store-busy until someone removes it by hand.
    const shutdown = source.slice(source.indexOf('function shutdown()'));
    assert.match(shutdown, /const reconvertStopped = stopSourceReconvert\(SOURCE_RECONVERT_STOP_WAIT_MS\)/);
    assert.ok(shutdown.indexOf('reconvertStopped.finally') > 0);
    assert.ok(shutdown.indexOf('reconvertStopped.finally') < shutdown.indexOf('process.exit(0)'));
    const bound = Number(/const SOURCE_RECONVERT_STOP_WAIT_MS = ([\d_]+);/.exec(source)?.[1].replace(/_/g, ''));
    assert.ok(bound > 0 && bound <= 60_000, 'well inside systemd’s 90 s TimeoutStopSec');
});

test('the retired watcher and re-conversion import nothing that could decrypt (127-C-d)', () => {
    // Pi update 3 ships every file in one stage (no mixed deploy), and these
    // two modules keep their exports for server.ts but import nothing at all
    // from the installer or the chart store: they cannot reach a converter.
    assert.doesNotMatch(reconvertSource, /^import /m);
    assert.doesNotMatch(watcherSource, /from '\.\/(oChartsInstaller|encChartStore|workloadGovernor)\.js'/);
    assert.doesNotMatch(installerSource, /publishChartDelivery|converted-ocharts|runOChartsExtractor/);
    assert.match(installerSource, /rescan: \(cellIds: string\[\]\) => Promise<VaultRescanWire>/);
});

test('downloads and ZIP extraction cross centralized streaming resource boundaries', () => {
    assert.match(encRouteSource, /streamResponseToFile\(response, downloadPath, ENC_DOWNLOAD_POLICY/);
    // Its central directory is read first, so a protected S-57 cell is never unpacked (127-C-d decision 6).
    assert.match(encRouteSource, /inspectZipArchive\(inputPath, ENC_ARCHIVE_POLICY\)/);
    assert.match(
        encRouteSource,
        /extractZipArchive\(inputPath, unzipDir, ENC_ARCHIVE_POLICY, \{ select: plan\.select \}\)/,
    );
    assert.match(chartRouteSource, /streamResponseToFile\(response, filePath, CHART_DOWNLOAD_POLICY/);
    assert.match(chartRouteSource, /extractZipArchive\(filePath, CHART_DIR, CHART_ARCHIVE_POLICY/);
    assert.doesNotMatch(encRouteSource, /AdmZip|extractAllTo/);
    assert.doesNotMatch(chartRouteSource, /AdmZip|entry\.getData\(\)/);

    assert.match(resourceBoundarySource, /ZIP contains a symlink or special file/);
    assert.match(resourceBoundarySource, /pipeline\(source, createInflateRaw\(\), integrity, output\)/);
    assert.match(resourceBoundarySource, /\.partial/);
});

test('HTTP configuration may assert but never mutate or persist a new Supabase authority', () => {
    assert.match(source, /const SUPABASE_ORIGIN = resolveTrustedSupabaseOrigin\(process\.env\.SUPABASE_URL\)/);
    assert.match(source, /assertSupabaseOriginAssertion\(validated\.supabaseUrl, SUPABASE_ORIGIN\)/);
    assert.doesNotMatch(source, /proxyConfig\.supabaseUrl\s*=/);
    assert.equal(source.match(/SUPABASE_ORIGIN\s*=/g)?.length, 1, 'the startup trust anchor became mutable');
    assert.match(source, /piEnvironmentLine\('SUPABASE_URL', SUPABASE_ORIGIN/);
    assert.match(source, /writeEnvironmentFileAtomic\(envPath, envContents\)/);

    const routeStart = source.indexOf("app.post('/api/configure'");
    const routeEnd = source.indexOf("app.post('/cache/purge'", routeStart);
    const configureRoute = source.slice(routeStart, routeEnd);
    assert.ok(
        configureRoute.indexOf('validatePiConfigurationFields') <
            configureRoute.indexOf('assertSupabaseOriginAssertion'),
        'persisted request fields must be validated before the startup origin assertion and every side effect',
    );
    assert.ok(
        configureRoute.indexOf('assertSupabaseOriginAssertion') <
            configureRoute.indexOf('applyDiaryRelayConfiguration'),
        'origin validation must precede every persisted/mutable configuration side effect',
    );
    assert.doesNotMatch(configureRoute, /fs\.writeFileSync/);
});

test('diary relay endpoint and production transport inherit the startup Supabase trust anchor', () => {
    // The trust anchor is still the process-startup origin; the operator's
    // uplink declaration (THALASSA_PI_WAN_UPLINK) rides alongside it.
    assert.match(
        source,
        /new DiaryRelayOutbox\(CACHE_DIR, \{\s*trustedSupabaseOrigin: SUPABASE_ORIGIN,?\s*(wanUplink: WAN_UPLINK,?\s*)?\}\)/,
    );
    assert.match(diaryRelaySource, /parsed\.href !== trustedRelayEndpoint/);
    assert.match(diaryRelaySource, /this\.fetchImpl\s*=\s*options\.fetchImpl \?\?/);
    assert.match(diaryRelaySource, /outboundFetch\(url,/);
    assert.doesNotMatch(diaryRelaySource, /\bfetch\s*\(/, 'diary relay retained a direct global fetch sink');

    const migration = diaryRelaySource.indexOf('this.invalidateUntrustedPersistedRelayUrls()');
    const startupSweep = diaryRelaySource.indexOf('queueMicrotask');
    assert.ok(migration > 0 && migration < startupSweep, 'legacy relay URLs must be invalidated before startup I/O');
    for (const table of ['diary_relay_config', 'diary_relay_outbox', 'diary_relay_cancellations']) {
        assert.match(
            diaryRelaySource.slice(diaryRelaySource.indexOf('private invalidateUntrustedPersistedRelayUrls')),
            new RegExp(`UPDATE ${table}`),
        );
    }
});

test('background workers are NOT behind the unsafe-admin gate', () => {
    // The complement of the test above, and the reason it matters: while these
    // two were gated on THALASSA_UNSAFE_ADMIN_API, the only way to have weather
    // prefetch or automatic chart decryption was to ALSO expose an unbounded
    // outbound proxy, a config writer, a cache purge, remote access and
    // arbitrary chart download/delete — on the machine holding the boat's
    // charts and its track history. So the flag
    // stayed on, and the door stayed open (Shane 2026-08-30).
    //
    // Neither worker serves a request or reads one. They poll and write to
    // disk, and each has its own honest gate.
    assert.match(source, /if \(SUPABASE_ANON_KEY\) \{\s*\n\s*startScheduler\(/);
    assert.match(source, /if \(process\.env\.ENC_WATCHER_ENABLED === 'true'\) \{\s*\n\s*startEncWatcher\(/);

    // Specifically: neither start call may mention the admin flag again.
    assert.match(
        source,
        /if \(SUPABASE_ANON_KEY\) \{\s*startScheduler\(cache, proxyConfig, \{\s*internetAllowed: \(\) => diaryRelayOutbox\.getConfiguration\(\)\.allowInternet,?\s*\}\);/,
        'automatic prefetch must retain its explicit boat internet-policy gate',
    );
    for (const call of ['startScheduler(cache, proxyConfig, {', 'startEncWatcher();']) {
        // The final automatic startup call, after the earlier restart inside
        // an authenticated configuration request handler.
        const at = source.lastIndexOf(call);
        assert.ok(at > -1, `${call} not found`);
        const guard = source.slice(Math.max(0, at - 200), at);
        assert.equal(guard.includes('UNSAFE_ADMIN_API_ENABLED'), false, `${call} is gated on the admin flag again`);
    }
});

test('the admin flag still guards what it should', () => {
    // Turning the workers loose must not have loosened the surface that
    // genuinely mutates the Pi or proxies arbitrary upstreams.
    assert.match(source, /const requireUnsafeAdmin/);
    assert.match(source, /app\.use\('\/api\/misc\/proxy', requireUnsafeAdmin\)/);
    assertAdminBodyParser();
});

test('the passthrough reads its query params as strings, never casts them', () => {
    // Express hands back a string, an ARRAY, or a nested object depending on the
    // query syntax (?url=a&url=b, ?url[x]=y). Casting `as string` lets the
    // validation and the later fetch disagree about what the value even is.
    assert.match(source, /function singleQueryString\(value: unknown\): string \| null/);
    assert.doesNotMatch(source, /req\.query\.url as string/);
    assert.doesNotMatch(source, /\(req\.query\.ttl as string\)/);
    for (const call of ['singleQueryString(req.query.url)', 'singleQueryString(req.query.ttl)']) {
        assert.ok(source.includes(call), `${call} missing`);
    }
});

test('binary upstream bodies are capped like the JSON ones', () => {
    // The JSON path has streamed with a 16 MB cap since it was written; the
    // three binary paths buffered res.arrayBuffer() with no limit at all, into
    // the SQLite cache the boat relies on offshore.
    const proxy = readFileSync(new URL('./proxy.ts', import.meta.url), 'utf8');
    assert.match(proxy, /const MAX_BINARY_BYTES = /);
    assert.match(proxy, /async function readCappedBody\(/);
    assert.doesNotMatch(proxy, /await res\.arrayBuffer\(\)/);
});
