import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
const proxySource = readFileSync(new URL('./proxy.ts', import.meta.url), 'utf8');
const encRouteSource = readFileSync(new URL('./routes/enc.ts', import.meta.url), 'utf8');
const chartRouteSource = readFileSync(new URL('./routes/charts.ts', import.meta.url), 'utf8');
const diaryRelaySource = readFileSync(new URL('./diaryRelayOutbox.ts', import.meta.url), 'utf8');
const osmServiceSource = readFileSync(new URL('./services/osm.ts', import.meta.url), 'utf8');
const governorSource = readFileSync(new URL('./workloadGovernor.ts', import.meta.url), 'utf8');
const resourceBoundarySource = readFileSync(new URL('./resourceBoundary.ts', import.meta.url), 'utf8');
const watcherSource = readFileSync(new URL('./encWatcher.ts', import.meta.url), 'utf8');
const chartworldSource = readFileSync(new URL('./chartworldSync.ts', import.meta.url), 'utf8');

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
    assert.match(source, /UNSAFE_ADMIN_API_ENABLED \? '100mb' : '64kb'/);
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
    assert.match(osmServiceSource, /outboundFetch\(OVERPASS_URL/);
    assert.doesNotMatch(osmServiceSource, /\bfetch\s*\(/, 'Overpass retained a direct fetch sink');
});

test('both ENC routing surfaces reject over-budget work before loading or routing', () => {
    const routeStart = encRouteSource.indexOf("router.post('/route'");
    const routePreppedStart = encRouteSource.indexOf("router.post('/route-prepped'");
    const installPublicStart = encRouteSource.indexOf("router.post('/install-public'", routePreppedStart);
    const routeBlock = encRouteSource.slice(routeStart, routePreppedStart);
    const routePreppedBlock = encRouteSource.slice(routePreppedStart, installPublicStart);

    assert.ok(routeStart >= 0 && routePreppedStart > routeStart && installPublicStart > routePreppedStart);
    assert.match(routeBlock, /validateInshoreRouteBoundary\(body, \{ validateCellIds: true \}\)/);
    assert.ok(
        routeBlock.indexOf('validateInshoreRouteBoundary') < routeBlock.indexOf('loadInstalledIndex'),
        'disk-backed route must reject its allocation budget before reading the chart index',
    );
    assert.match(routePreppedBlock, /validateInshoreRouteBoundary\(body, \{ validatePreparedLayers: true \}\)/);
    assert.ok(
        routePreppedBlock.indexOf('validateInshoreRouteBoundary') < routePreppedBlock.indexOf('routeInshore'),
        'prepared route must reject feature/coordinate budgets before routing',
    );
    for (const block of [routeBlock, routePreppedBlock]) {
        assert.match(block, /res\.status\(boundaryIssue\.status\)\.json\(boundaryIssue\)/);
        assert.match(block, /acquireRequestWorkload\(req, res, 'route'\)/);
    }
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
    assert.equal(watcherSource.match(/admit\('conversion'\)/g)?.length, 2);
    assert.match(chartworldSource, /admit\('conversion'\)/);
});

test('downloads and ZIP extraction cross centralized streaming resource boundaries', () => {
    assert.match(encRouteSource, /streamResponseToFile\(response, downloadPath, ENC_DOWNLOAD_POLICY/);
    assert.match(encRouteSource, /extractZipArchive\(inputPath, unzipDir, ENC_ARCHIVE_POLICY\)/);
    assert.match(chartRouteSource, /streamResponseToFile\(response, filePath, CHART_DOWNLOAD_POLICY/);
    assert.match(chartRouteSource, /extractZipArchive\(filePath, CHART_DIR, CHART_ARCHIVE_POLICY/);
    assert.doesNotMatch(encRouteSource, /AdmZip|extractAllTo/);
    assert.doesNotMatch(chartRouteSource, /AdmZip|entry\.getData\(\)/);

    assert.match(chartworldSource, /--max-filesize/);
    assert.match(chartworldSource, /assertDownloadDestinationCapacity/);
    assert.match(chartworldSource, /extractZipArchive\(filePath, extractionDir, CHARTWORLD_ARCHIVE_POLICY\)/);
    assert.match(chartworldSource, /materialiseDownloadedArchive\(exchangePath\)/);
    assert.match(chartworldSource, /runInstall\(exchangeDir, permitDir\)/);
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
    // charts, its track history and its ChartWorld credentials. So the flag
    // stayed on, and the door stayed open (Shane 2026-08-30).
    //
    // Neither worker serves a request or reads one. They poll and write to
    // disk, and each has its own honest gate.
    assert.match(source, /if \(SUPABASE_ANON_KEY\) \{\s*\n\s*startScheduler\(/);
    assert.match(source, /if \(process\.env\.ENC_WATCHER_ENABLED === 'true'\) \{\s*\n\s*startEncWatcher\(/);

    // Specifically: neither start call may mention the admin flag again.
    for (const call of ['startScheduler(cache, proxyConfig);', 'startEncWatcher();']) {
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
    assert.match(source, /UNSAFE_ADMIN_API_ENABLED \? '100mb' : '64kb'/);
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
