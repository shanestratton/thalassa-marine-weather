import { webcrypto } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ createClient: vi.fn(), getUser: vi.fn(), userQuota: vi.fn(), publicQuota: vi.fn() }));
vi.mock('https://esm.sh/@supabase/supabase-js@2', () => ({ createClient: sdk.createClient }));

const MODERN = 'sb_publishable_fictional_classifier_fixture';
const LEGACY = 'fictional.legacy.public-key';
const SERVICE = 'fictional-server-quota-fixture-only';
const URL = 'https://fictional-project.example';
let configuredPublic = MODERN;
let quota: (
    request: Request,
    bucket: string,
    authenticatedLimit: number,
    publicLimit: number,
    windowSeconds: number,
    allowCredentiallessPublic?: boolean,
) => Promise<{ userId: string | null; kind: 'authenticated' | 'public' } | Response>;
const network = vi.fn(() => {
    throw new Error('No HTTP is allowed in credential classification fixtures');
});
const request = (headers: Record<string, string> = {}) =>
    new Request(`${URL}/regional-arome`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': '192.0.2.10', ...headers },
    });
const call = (headers: Record<string, string> = {}, credentialless = false) =>
    quota(request(headers), 'regional_arome', 120, 30, 3600, credentialless);

beforeAll(async () => {
    // Import the actual shared function, mocking only its remote SDK adapter.
    // The string import keeps Deno's URL graph out of the app tsc program.
    const edgeModule = '../supabase/functions/_shared/auth-rate-limit';
    ({ requireAuthenticatedOrPublicQuota: quota } = await import(edgeModule));
});
beforeEach(() => {
    configuredPublic = MODERN;
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('fetch', network);
    vi.stubGlobal('Deno', {
        env: {
            get: (name: string) =>
                ({
                    SUPABASE_URL: URL,
                    SUPABASE_ANON_KEY: configuredPublic,
                    SUPABASE_SERVICE_ROLE_KEY: SERVICE,
                })[name],
        },
    });
    network.mockClear();
    sdk.createClient.mockReset();
    sdk.getUser.mockReset();
    sdk.userQuota.mockReset();
    sdk.publicQuota.mockReset();
    sdk.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'fictional invalid session' } });
    sdk.userQuota.mockResolvedValue({ data: true, error: null });
    sdk.publicQuota.mockResolvedValue({ data: true, error: null });
    sdk.createClient.mockImplementation((_url, key) =>
        key === SERVICE ? { rpc: sdk.publicQuota } : { auth: { getUser: sdk.getUser }, rpc: sdk.userQuota },
    );
});
afterEach(() => {
    expect(network).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
});

describe('actual Edge public-versus-user credential classification', () => {
    it.each([MODERN, LEGACY])('accepts the exact configured public bearer %s at public quota', async (key) => {
        configuredPublic = key;
        expect(await call({ Authorization: `Bearer ${key}`, apikey: key })).toEqual({ userId: null, kind: 'public' });
        expect(sdk.getUser).not.toHaveBeenCalled();
        expect(sdk.userQuota).not.toHaveBeenCalled();
        expect(sdk.publicQuota).toHaveBeenCalledOnce();
        expect(sdk.publicQuota).toHaveBeenCalledWith('consume_public_edge_quota', {
            p_bucket: 'regional_arome_public',
            p_client_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
            p_limit: 30,
            p_window_seconds: 3600,
        });
    });

    it.each([MODERN, LEGACY])('accepts configured apikey %s only when Authorization is absent', async (key) => {
        configuredPublic = key;
        const req = request({ apikey: key });
        expect(req.headers.get('authorization')).toBeNull();
        expect(await quota(req, 'regional_arome', 120, 30, 3600)).toEqual({ userId: null, kind: 'public' });
        expect(sdk.publicQuota).toHaveBeenCalledOnce();
        expect(sdk.getUser).not.toHaveBeenCalled();
    });

    it.each(['', 'Bearer', 'Bearer  malformed', 'Basic malformed', 'bearer malformed', MODERN])(
        'refuses present malformed Authorization %j even with the exact configured apikey',
        async (authorization) => {
            const req = request({ Authorization: authorization, apikey: MODERN });
            expect(req.headers.get('authorization')).not.toBeNull();
            const result = await quota(req, 'regional_arome', 120, 30, 3600);
            expect(result).toBeInstanceOf(Response);
            expect((result as Response).status).toBe(401);
            expect(await (result as Response).json()).toEqual({ error: 'Authentication required' });
            expect(sdk.createClient).not.toHaveBeenCalled();
            expect(sdk.publicQuota).not.toHaveBeenCalled();
            expect(sdk.userQuota).not.toHaveBeenCalled();
        },
    );

    it.each(['fictional-invalid-user-token', LEGACY])(
        'never downgrades a mismatched bearer %s through a valid modern apikey',
        async (bearer) => {
            const result = await call({ Authorization: `Bearer ${bearer}`, apikey: MODERN });
            expect(result).toBeInstanceOf(Response);
            expect((result as Response).status).toBe(401);
            expect(await (result as Response).json()).toEqual({ error: 'Invalid or expired session' });
            expect(sdk.getUser).toHaveBeenCalledOnce();
            expect(sdk.publicQuota).not.toHaveBeenCalled();
            expect(sdk.userQuota).not.toHaveBeenCalled();
        },
    );

    it('keeps a verified real user on the authenticated quota', async () => {
        sdk.getUser.mockResolvedValue({ data: { user: { id: 'verified-fixture-user' } }, error: null });
        expect(await call({ Authorization: 'Bearer verified-user-fixture', apikey: MODERN })).toEqual({
            userId: 'verified-fixture-user',
            kind: 'authenticated',
        });
        expect(sdk.createClient).toHaveBeenCalledWith(URL, MODERN, {
            global: { headers: { Authorization: 'Bearer verified-user-fixture' } },
        });
        expect(sdk.userQuota).toHaveBeenCalledWith('consume_edge_quota', {
            p_bucket: 'regional_arome',
            p_limit: 120,
            p_window_seconds: 3600,
        });
        expect(sdk.publicQuota).not.toHaveBeenCalled();
    });

    it.each([false, null, 'true', 1, {}])('requires literal public quota approval, refusing %j', async (allowed) => {
        sdk.publicQuota.mockResolvedValue({ data: allowed, error: null });
        const result = await call({ apikey: MODERN });
        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(429);
        expect(sdk.getUser).not.toHaveBeenCalled();
        expect(sdk.userQuota).not.toHaveBeenCalled();
    });

    it('does not fall back when an authenticated quota denies the verified user', async () => {
        sdk.getUser.mockResolvedValue({ data: { user: { id: 'verified-fixture-user' } }, error: null });
        sdk.userQuota.mockResolvedValue({ data: false, error: null });
        const result = await call({ Authorization: 'Bearer verified-user-fixture', apikey: MODERN });
        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(429);
        expect(sdk.publicQuota).not.toHaveBeenCalled();
    });

    it('preserves explicitly credentialless public endpoints without admitting malformed headers', async () => {
        expect(await call({}, true)).toEqual({ userId: null, kind: 'public' });
        sdk.publicQuota.mockClear();
        const denied = await call({ Authorization: '', apikey: MODERN }, true);
        expect(denied).toBeInstanceOf(Response);
        expect((denied as Response).status).toBe(401);
        expect(sdk.publicQuota).not.toHaveBeenCalled();
    });
});
