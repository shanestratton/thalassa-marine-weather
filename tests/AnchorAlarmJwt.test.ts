import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

// Exercise the actual edge signer without starting Deno. Only synthetic keys
// and injected environment values are used; no machine secrets are accessed.
const edge = readFileSync('supabase/functions/send-anchor-alarm/index.ts', 'utf8');
const signer = ts.transpileModule(
    edge.slice(edge.indexOf('type ApnsEnvironment'), edge.indexOf('// ---------- MAIN HANDLER')),
    {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    },
).outputText;
let pem: string;
let publicKey: webcrypto.CryptoKey;
let rotatedPem: string;
async function makeKey() {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const bytes = await webcrypto.subtle.exportKey('pkcs8', pair.privateKey);
    return {
        pem: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(bytes).toString('base64')}\n-----END PRIVATE KEY-----`,
        publicKey: pair.publicKey,
    };
}
beforeAll(async () => {
    ({ pem, publicKey } = await makeKey());
    rotatedPem = (await makeKey()).pem;
});
afterEach(() => vi.useRealTimers());

function harness() {
    const env: Record<string, string | undefined> = {
        APNS_KEY_ID: 'KEY1234567',
        APNS_TEAM_ID: 'TEAM123456',
        APNS_KEY_P8: pem,
    };
    const sign = vi.fn(webcrypto.subtle.sign.bind(webcrypto.subtle));
    const importKey = vi.fn(webcrypto.subtle.importKey.bind(webcrypto.subtle));
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const api = new Function(
        'Deno',
        'crypto',
        'base64url',
        'fetch',
        'AbortSignal',
        `${signer}\nreturn {create: createApnsJwt, send: sendApnsPush};`,
    )(
        { env: { get: (name: string) => env[name] } },
        { subtle: { sign, importKey } },
        (value: string | ArrayBuffer) =>
            typeof value === 'string'
                ? Buffer.from(value, 'utf8').toString('base64url')
                : Buffer.from(value).toString('base64url'),
        fetch,
        { timeout: () => undefined },
    ) as {
        create: (environment?: 'production' | 'sandbox') => Promise<string>;
        send: (
            token: string,
            title: string,
            body: string,
            data: Record<string, unknown>,
            failure: (reason: string) => void,
        ) => Promise<boolean>;
    };
    return { env, sign, importKey, fetch, ...api };
}

describe('anchor APNs signer hygiene', () => {
    it('trims IDs and produces a verifiable raw ES256 JWT', async () => {
        const h = harness();
        h.env.APNS_KEY_ID = ' KEY1234567\n';
        h.env.APNS_TEAM_ID = '\tTEAM123456 ';
        const token = await h.create();
        const [header, claims, signature] = token.split('.');
        expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
        expect(JSON.parse(Buffer.from(claims, 'base64url').toString()).iss).toBe('TEAM123456');
        expect(Buffer.from(signature, 'base64url')).toHaveLength(64);
        expect(
            await webcrypto.subtle.verify(
                { name: 'ECDSA', hash: 'SHA-256' },
                publicKey,
                Buffer.from(signature, 'base64url'),
                Buffer.from(`${header}.${claims}`),
            ),
        ).toBe(true);
    });

    it.each(['', 'short', '12345678901', 'TEAM-12345', 'TEAM 12345'])(
        'rejects invalid ID %j before importing/signing',
        async (id) => {
            const h = harness();
            h.env.APNS_TEAM_ID = id;
            await expect(h.create()).rejects.toThrow('Invalid APNs signing configuration');
            expect(h.importKey).not.toHaveBeenCalled();
            expect(h.sign).not.toHaveBeenCalled();
        },
    );

    it('shares concurrent signing and reuses the result for 45 minutes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime('2026-09-23T00:00:00Z');
        const h = harness();
        const [first, second] = await Promise.all([h.create(), h.create()]);
        expect(second).toBe(first);
        expect(h.sign).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(44 * 60_000);
        expect(await h.create()).toBe(first);
        vi.advanceTimersByTime(60_000);
        expect(await h.create()).not.toBe(first);
        expect(h.sign).toHaveBeenCalledTimes(2);
    });

    it('invalidates the cache on every signing credential change', async () => {
        const h = harness();
        await h.create();
        h.env.APNS_KEY_ID = 'KEY7654321';
        await h.create();
        h.env.APNS_TEAM_ID = 'TEAM654321';
        await h.create();
        h.env.APNS_KEY_P8 = rotatedPem;
        await h.create();
        expect(h.sign).toHaveBeenCalledTimes(4);
        h.env.APNS_TEAM_ID = '';
        await expect(h.create()).rejects.toThrow('Invalid APNs signing configuration');
    });

    it('does not cache a failed signing attempt', async () => {
        const h = harness();
        h.sign.mockRejectedValueOnce(new Error('synthetic signing failure'));
        await expect(h.create()).rejects.toThrow('synthetic signing failure');
        await expect(h.create()).resolves.toContain('.');
        expect(h.sign).toHaveBeenCalledTimes(2);
    });
});

describe('anchor notification sound policy', () => {
    it.each(['drag', 'gps_lost', 'contact_lost'])(
        'uses the custom ordinary siren for %s without asserting Critical approval',
        async (alarm_kind) => {
            const h = harness();
            await h.send('synthetic-token', 'Title', 'Body', { alarm_kind, expires_at_seconds: 2000000000 }, vi.fn());
            const payload = JSON.parse(h.fetch.mock.calls[0][1].body);
            expect(payload.aps.sound).toBe('thalassa-anchor-alarm.wav');
            expect(payload.aps['interruption-level']).toBe('time-sensitive');
            expect(h.fetch.mock.calls[0][1].headers['apns-expiration']).toBe('2000000000');
            expect(h.fetch).toHaveBeenCalledTimes(1);
        },
    );

    it.each([undefined, 'false', 'true'])('keeps expiry reminders ordinary with Critical flag %s', async (enabled) => {
        const h = harness();
        h.env.APNS_CRITICAL_ALERTS_ENABLED = enabled;
        await h.send('synthetic-token', 'Title', 'Body', { alarm_kind: 'session_expiring' }, vi.fn());
        const payload = JSON.parse(h.fetch.mock.calls[0][1].body);
        expect(payload.aps.sound).toBe('default');
        expect(payload.aps['interruption-level']).toBe('time-sensitive');
    });

    it('retains the custom sound in the separately approved Critical path', async () => {
        const h = harness();
        // Synthetic configuration only: no real Apple entitlement/secret is changed.
        h.env.APNS_CRITICAL_ALERTS_ENABLED = 'true';
        await h.send('synthetic-token', 'Title', 'Body', { alarm_kind: 'drag' }, vi.fn());
        const payload = JSON.parse(h.fetch.mock.calls[0][1].body);
        expect(payload.aps.sound).toEqual({ critical: 1, name: 'thalassa-anchor-alarm.wav', volume: 1 });
        expect(payload.aps['interruption-level']).toBe('critical');
    });
});

describe('legacy Xcode token compatibility without changing production delivery', () => {
    const rejected = (status: number, reason: string) => ({ ok: false, status, json: async () => ({ reason }) });
    const send = (h: ReturnType<typeof harness>, failure = vi.fn()) =>
        h.send(
            'synthetic-device-token',
            'Title',
            'Body',
            { session_code: 'TESTCODE2345', expires_at_seconds: 2000000000 },
            failure,
        );
    const configureSandbox = (h: ReturnType<typeof harness>) => {
        h.env.APNS_SANDBOX_KEY_ID = 'DEV1234567';
        h.env.APNS_SANDBOX_KEY_P8 = rotatedPem;
    };
    it('sends successful production notifications once, with the bundled ordinary alarm sound', async () => {
        const h = harness();
        configureSandbox(h);
        expect(await send(h)).toBe(true);
        expect(h.fetch).toHaveBeenCalledTimes(1);
        expect(h.fetch.mock.calls[0][0]).toContain('https://api.push.apple.com/');
        const payload = JSON.parse(h.fetch.mock.calls[0][1].body);
        expect(payload.notification_type).toBe('anchor_alarm');
        expect(payload.aps.sound).toBe('thalassa-anchor-alarm.wav');
        expect(payload.aps['interruption-level']).toBe('time-sensitive');
    });
    it('retries exactly once on production 400 BadDeviceToken, using a sandbox key and identical token/payload', async () => {
        const h = harness();
        configureSandbox(h);
        h.fetch.mockResolvedValueOnce(rejected(400, 'BadDeviceToken'));
        expect(await send(h)).toBe(true);
        expect(h.fetch).toHaveBeenCalledTimes(2);
        expect(h.fetch.mock.calls[1][0]).toBe('https://api.sandbox.push.apple.com/3/device/synthetic-device-token');
        expect(h.fetch.mock.calls[1][1].body).toBe(h.fetch.mock.calls[0][1].body);
        const header = (call: number) =>
            JSON.parse(
                Buffer.from(
                    h.fetch.mock.calls[call][1].headers.authorization.split(' ')[1].split('.')[0],
                    'base64url',
                ).toString(),
            );
        expect(header(0).kid).toBe('KEY1234567');
        expect(header(1).kid).toBe('DEV1234567');
    });
    it.each([
        [403, 'InvalidProviderToken'],
        [403, 'BadEnvironmentKeyInToken'],
        [429, 'TooManyRequests'],
        [500, 'InternalServerError'],
        [503, 'ServiceUnavailable'],
        [400, 'BadTopic'],
    ])('does not fallback for %s %s', async (status, reason) => {
        const h = harness();
        configureSandbox(h);
        h.fetch.mockResolvedValueOnce(rejected(status as number, reason as string));
        expect(await send(h)).toBe(false);
        expect(h.fetch).toHaveBeenCalledTimes(1);
    });
    it('does not fallback after a timeout/uncertain delivery', async () => {
        const h = harness();
        configureSandbox(h);
        h.fetch.mockRejectedValueOnce(new Error('timeout'));
        expect(await send(h)).toBe(false);
        expect(h.fetch).toHaveBeenCalledTimes(1);
    });
    it('reports missing sandbox credentials without exposing the token or sending a second push', async () => {
        const h = harness();
        const failure = vi.fn();
        h.fetch.mockResolvedValueOnce(rejected(400, 'BadDeviceToken'));
        expect(await send(h, failure)).toBe(false);
        expect(h.fetch).toHaveBeenCalledTimes(1);
        expect(failure).toHaveBeenCalledWith('APNs production 400 BadDeviceToken; sandbox credentials not configured');
    });
    it('does not loop after sandbox rejection', async () => {
        const h = harness();
        configureSandbox(h);
        h.fetch
            .mockResolvedValueOnce(rejected(400, 'BadDeviceToken'))
            .mockResolvedValueOnce(rejected(400, 'BadDeviceToken'));
        expect(await send(h)).toBe(false);
        expect(h.fetch).toHaveBeenCalledTimes(2);
    });
    it('keeps explicit sandbox mode, preferring dedicated credentials but supporting legacy dual-environment keys', async () => {
        const h = harness();
        h.env.APNS_PRODUCTION = 'false';
        expect(await send(h)).toBe(true);
        expect(h.fetch.mock.calls[0][0]).toContain('https://api.sandbox.push.apple.com/');
        configureSandbox(h);
        expect(await send(h)).toBe(true);
        expect(h.fetch).toHaveBeenCalledTimes(2);
        expect(h.sign).toHaveBeenCalledTimes(2);
    });
    it('keeps both environment credentials cached when alternating and accepts an optional sandbox team', async () => {
        const h = harness();
        configureSandbox(h);
        h.env.APNS_SANDBOX_TEAM_ID = ' DEVTEAM123 ';
        const prod = await h.create('production');
        const dev = await h.create('sandbox');
        expect(await h.create('production')).toBe(prod);
        expect(await h.create('sandbox')).toBe(dev);
        expect(h.sign).toHaveBeenCalledTimes(2);
        expect(JSON.parse(Buffer.from(dev.split('.')[1], 'base64url').toString()).iss).toBe('DEVTEAM123');
    });
});
