// @vitest-environment node
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope, getAuthIdentityScope } from '../services/authIdentityScope';
const storage = vi.hoisted(() => ({ values: new Map<string, string>(), get: vi.fn(), set: vi.fn() }));
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: storage.get, set: storage.set } }));
import {
    acceptNoaaAgreement,
    loadNoaaAgreementText,
    noaaAgreementAccepted,
    NOAA_AGREEMENT_SHA256,
} from '../services/enc/noaaAgreement';

const text = readFileSync('public/data/noaa-enc-user-agreement.txt', 'utf8');
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    storage.values.clear();
    storage.get.mockReset();
    storage.set.mockReset();
    storage.get.mockImplementation(async ({ key }: { key: string }) => ({ value: storage.values.get(key) ?? null }));
    storage.set.mockImplementation(async ({ key, value }: { key: string; value: string }) => {
        storage.values.set(key, value);
    });
    setAuthIdentityScope(A);
});
afterEach(() => vi.unstubAllGlobals());
describe('NOAA agreement version and account consent', () => {
    it('does not infer consent from imported charts; saves and verifies only the exact government agreement', async () => {
        expect(await noaaAgreementAccepted()).toBe(false);
        expect(await acceptNoaaAgreement('Some outdated or truncated NOAA terms')).toBe(false);
        expect(storage.values.size).toBe(0);
        expect(await acceptNoaaAgreement(text)).toBe(true);
        expect(await noaaAgreementAccepted()).toBe(true);
        const saved = JSON.parse([...storage.values.values()][0]);
        expect(saved.hash).toBe(NOAA_AGREEMENT_SHA256);
        expect(saved.scope).toBe(`user:${A}`);
        setAuthIdentityScope(B);
        expect(await noaaAgreementAccepted()).toBe(false);
        setAuthIdentityScope(A);
        expect(await noaaAgreementAccepted()).toBe(true);
    });
    it('rejects a changed agreement version, copied account record and malformed consent', async () => {
        await acceptNoaaAgreement(text);
        const [key, raw] = [...storage.values.entries()][0];
        const record = JSON.parse(raw);
        for (const change of [
            { hash: 'outdated' },
            { scope: `user:${B}` },
            { origin: 'https://elsewhere.invalid' },
            { acceptedAt: Date.now() + 600000 },
            { schema: 2 },
        ]) {
            storage.values.set(key, JSON.stringify({ ...record, ...change }));
            expect(await noaaAgreementAccepted()).toBe(false);
        }
        storage.values.set(key, '{');
        expect(await noaaAgreementAccepted()).toBe(false);
    });
    it('rejects old-account reads and completed writes across a synchronous identity fence', async () => {
        await acceptNoaaAgreement(text);
        const original = [...storage.values.values()][0];
        let release!: (value: { value: string }) => void;
        storage.get.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const pending = noaaAgreementAccepted();
        setAuthIdentityScope(B);
        release({ value: original });
        expect(await pending).toBe(false);
        const scope = getAuthIdentityScope();
        let releaseWrite!: () => void;
        storage.set.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    releaseWrite = resolve;
                }),
        );
        const write = acceptNoaaAgreement(text, scope);
        await vi.waitFor(() => expect(storage.set).toHaveBeenCalledTimes(2));
        setAuthIdentityScope(A);
        releaseWrite();
        expect(await write).toBe(false);
        expect(await noaaAgreementAccepted(scope)).toBe(false);
    });
    it('fails closed on persistence failure and never reports a successful unverified write', async () => {
        storage.get.mockRejectedValueOnce(new Error('Storage unavailable'));
        expect(await noaaAgreementAccepted()).toBe(false);
        storage.set.mockResolvedValueOnce(undefined);
        expect(await acceptNoaaAgreement(text)).toBe(false);
    });
    it('loads only bounded local bundled text, verifies its bytes, and refuses altered or oversized text', async () => {
        const fetch = vi.fn().mockResolvedValue(new Response(text));
        vi.stubGlobal('fetch', fetch);
        expect(await loadNoaaAgreementText()).toBe(text);
        expect(fetch).toHaveBeenCalledWith(
            '/data/noaa-enc-user-agreement.txt',
            expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
        );
        fetch.mockResolvedValueOnce(new Response(text + '\nChanged terms'));
        await expect(loadNoaaAgreementText()).rejects.toThrow(/changed/);
        fetch.mockResolvedValueOnce(new Response('x'.repeat(8193)));
        await expect(loadNoaaAgreementText()).rejects.toThrow(/unavailable/);
        fetch.mockResolvedValueOnce(new Response(text, { status: 404 }));
        await expect(loadNoaaAgreementText()).rejects.toThrow(/unavailable/);
    });
});
