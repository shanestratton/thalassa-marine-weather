import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response } from 'undici';
import {
    DEFAULT_THALASSA_SUPABASE_ORIGIN,
    PRIVATE_UPSTREAM_ORIGINS_FLAG,
    UNSAFE_SUPABASE_ORIGINS_FLAG,
    assertAddressAllowed,
    assertSupabaseOriginAssertion,
    configuredPrivateUpstreamOrigins,
    createOutboundFetcher,
    createPinnedConnector,
    normaliseExactHttpOrigin,
    normaliseOutboundHttpUrl,
    resolvePinnedAddress,
    resolveTrustedSupabaseOrigin,
    trustedSupabaseOrigins,
} from './outboundHttp.js';

test('outbound URL parsing accepts vendor URLs but rejects ambiguous authority', () => {
    assert.equal(normaliseOutboundHttpUrl('https://downloads.vendor.test/chart.zip?token=abc').protocol, 'https:');
    assert.equal(normaliseOutboundHttpUrl('http://charts.vendor.test:8080/file.000').port, '8080');
    assert.throws(() => normaliseOutboundHttpUrl('file:///etc/passwd'), /http\/https/);
    assert.throws(() => normaliseOutboundHttpUrl('https://user:pass@example.test/chart.zip'), /Credentialed/);
    assert.throws(() => normaliseOutboundHttpUrl('https://metadata.google.internal/latest'), /Metadata/);
    assert.throws(() => normaliseOutboundHttpUrl('https://example.test/\nchart'), /control/);
    assert.throws(() => normaliseExactHttpOrigin('https://example.test/not-an-origin'), /path/);
});

test('address policy blocks internal and metadata ranges unless an exact private origin opted in', () => {
    assert.doesNotThrow(() => assertAddressAllowed('93.184.216.34', false));
    assert.doesNotThrow(() => assertAddressAllowed('2606:4700:4700::1111', false));
    for (const address of ['10.1.2.3', '100.64.0.1', '172.31.0.1', '192.168.50.20', 'fd12::1']) {
        assert.throws(() => assertAddressAllowed(address, false), /private|carrier/i, address);
        assert.doesNotThrow(() => assertAddressAllowed(address, true), address);
    }
    for (const address of [
        '0.0.0.0',
        '127.0.0.1',
        '169.254.169.254',
        '100.100.100.200',
        '224.0.0.1',
        '::1',
        '::ffff:127.0.0.1',
        'fe80::1',
        'fd00:ec2::254',
        'fd20:ce::254',
    ]) {
        assert.throws(() => assertAddressAllowed(address, true), /loopback|metadata|link-local|reserved/i, address);
    }
});

test('translated and tunnelled IPv6 cannot encode loopback or metadata destinations', () => {
    for (const address of [
        '64:ff9b::7f00:1', // NAT64 well-known prefix -> 127.0.0.1
        '64:ff9b::a9fe:a9fe', // NAT64 well-known prefix -> 169.254.169.254
        '64:ff9b:1::7f00:1', // local-use NAT64 prefix -> 127.0.0.1
        '2002:7f00:1::', // 6to4 -> 127.0.0.1
        '2001:0000:4136:e378:8000:63bf:3fff:fdd2', // Teredo
        'fec0::1', // deprecated site-local
    ]) {
        assert.throws(
            () => assertAddressAllowed(address, true),
            /loopback|metadata|link-local|reserved|non-global/i,
            address,
        );
    }
});

test('private upstream origins require unsafe-admin and exact origin syntax', () => {
    const raw =
        'http://chartbox.local:8080, http://192.168.50.20:9000, *, https://user:pass@example.test, https://example.test/path';
    assert.deepEqual(
        [...configuredPrivateUpstreamOrigins({ [PRIVATE_UPSTREAM_ORIGINS_FLAG]: raw })],
        [],
        'the allowlist must be inert without unsafe-admin mode',
    );
    assert.deepEqual(
        [
            ...configuredPrivateUpstreamOrigins({
                THALASSA_UNSAFE_ADMIN_API: '1',
                [PRIVATE_UPSTREAM_ORIGINS_FLAG]: raw,
            }),
        ],
        ['http://chartbox.local:8080', 'http://192.168.50.20:9000'],
    );
});

test('Supabase authority is startup-pinned and HTTP input can only assert it', () => {
    assert.equal(resolveTrustedSupabaseOrigin(undefined, {}), DEFAULT_THALASSA_SUPABASE_ORIGIN);
    assert.deepEqual([...trustedSupabaseOrigins({})], [DEFAULT_THALASSA_SUPABASE_ORIGIN]);
    assert.throws(
        () => resolveTrustedSupabaseOrigin('https://attacker.test', {}),
        new RegExp(UNSAFE_SUPABASE_ORIGINS_FLAG),
    );

    const developmentEnv = {
        THALASSA_UNSAFE_ADMIN_API: '1',
        [UNSAFE_SUPABASE_ORIGINS_FLAG]: 'http://supabase.lan:54321',
    };
    assert.equal(
        resolveTrustedSupabaseOrigin('http://supabase.lan:54321', developmentEnv),
        'http://supabase.lan:54321',
    );
    assert.doesNotThrow(() =>
        assertSupabaseOriginAssertion(DEFAULT_THALASSA_SUPABASE_ORIGIN, DEFAULT_THALASSA_SUPABASE_ORIGIN),
    );
    assert.throws(
        () => assertSupabaseOriginAssertion('https://attacker.test', DEFAULT_THALASSA_SUPABASE_ORIGIN),
        /does not match/,
    );
});

test('resolution rejects mixed public/private DNS answers and selects a checked public address', async () => {
    await assert.rejects(
        resolvePinnedAddress('rebind.test', false, async () => [
            { address: '93.184.216.34', family: 4 },
            { address: '192.168.1.10', family: 4 },
        ]),
        /private|carrier/i,
    );
    assert.deepEqual(
        await resolvePinnedAddress('vendor.test', false, async () => [
            { address: '93.184.216.34', family: 4 },
            { address: '93.184.216.35', family: 4 },
        ]),
        { address: '93.184.216.34', family: 4 },
    );
});

test('the connector pins the checked address while preserving TLS SNI', async () => {
    type Connector = NonNullable<Parameters<typeof createPinnedConnector>[2]>;
    type Options = Parameters<Connector>[0];
    let connected: Options | undefined;
    const baseConnect: Connector = (options, callback) => {
        connected = options;
        callback(new Error('test stop after pin'), null);
    };
    const connector = createPinnedConnector(false, async () => [{ address: '93.184.216.34', family: 4 }], baseConnect);

    await new Promise<void>((resolve, reject) => {
        connector({ hostname: 'downloads.vendor.test', protocol: 'https:', port: '443' }, (error, _socket) => {
            if (!error || error.message !== 'test stop after pin')
                reject(error ?? new Error('missing connector error'));
            else resolve();
        });
    });
    assert.equal(connected?.hostname, '93.184.216.34');
    assert.equal(connected?.host, '93.184.216.34');
    assert.equal(connected?.servername, 'downloads.vendor.test');
});

test('the production connector can be constructed without an injected transport', () => {
    // Undici's runtime currently requires an options object even though its
    // TypeScript declaration marks the argument optional. This smoke test
    // exercises the production default that the pinning unit above replaces.
    const connector = createPinnedConnector(false, async () => [{ address: '93.184.216.34', family: 4 }]);
    assert.equal(typeof connector, 'function');
});

test('public vendor redirects are followed and each hop is canonicalised', async () => {
    const seen: string[] = [];
    const fetcher = createOutboundFetcher({
        request: async (input) => {
            const url = new URL(input);
            seen.push(url.href);
            return seen.length === 1
                ? new Response(null, { status: 302, headers: { location: 'https://cdn.vendor.test/files/chart.zip' } })
                : new Response('chart', { status: 200 });
        },
        privateOrigins: () => new Set(),
        dispatcher: () => undefined,
    });

    const response = await fetcher('https://shop.vendor.test/download?id=1', {
        headers: { Accept: 'application/octet-stream', Range: 'bytes=0-' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(seen, ['https://shop.vendor.test/download?id=1', 'https://cdn.vendor.test/files/chart.zip']);
});

test('redirects cannot reach private literals or carry caller secrets across origins', async () => {
    const privateRedirect = createOutboundFetcher({
        request: async () => new Response(null, { status: 302, headers: { location: 'http://192.168.1.20/admin' } }),
        privateOrigins: () => new Set(),
        dispatcher: () => undefined,
    });
    await assert.rejects(privateRedirect('https://public.vendor.test/chart'), /private|carrier/i);

    for (const headerName of ['apikey', 'X-Api-Key', 'X-Auth-Token', 'X-Thalassa-Pi-Relay-Token']) {
        let calls = 0;
        const credentialedRedirect = createOutboundFetcher({
            request: async () => {
                calls += 1;
                return new Response(null, { status: 302, headers: { location: 'https://attacker.test/' } });
            },
            privateOrigins: () => new Set(),
            dispatcher: () => undefined,
        });
        await assert.rejects(
            credentialedRedirect(`${DEFAULT_THALASSA_SUPABASE_ORIGIN}/functions/v1/weather`, {
                headers: { [headerName]: 'must-not-cross-origins' },
            }),
            /non-safelisted headers.*redirect across origins/,
        );
        assert.equal(calls, 1, headerName);
    }
});

test('non-idempotent requests never follow redirects, even on the same origin', async () => {
    let calls = 0;
    const fetcher = createOutboundFetcher({
        request: async () => {
            calls += 1;
            return new Response(null, { status: 307, headers: { location: '/redirected-post' } });
        },
        privateOrigins: () => new Set(),
        dispatcher: () => undefined,
    });

    await assert.rejects(
        fetcher('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            headers: { 'X-Thalassa-Pi-Relay-Token': 'must-not-be-replayed' },
            body: 'private-body',
        }),
        /redirects are not allowed for non-idempotent requests/,
    );
    assert.equal(calls, 1);
});

test('an exact configured private origin uses the private dispatcher and nearby origins do not', async () => {
    const dispatchModes: boolean[] = [];
    const privateOrigin = 'http://chartbox.local:8080';
    const fetcher = createOutboundFetcher({
        request: async () => new Response('ok', { status: 200 }),
        privateOrigins: () => new Set([privateOrigin]),
        dispatcher: (allowPrivate) => {
            dispatchModes.push(allowPrivate);
            return undefined;
        },
    });

    await fetcher(`${privateOrigin}/charts/au.zip`);
    await fetcher('http://chartbox.local:8081/charts/au.zip');
    assert.deepEqual(dispatchModes, [true, false]);
});
