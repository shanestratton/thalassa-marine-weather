import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPrivateBoatSession, type PrivateBoatPorts } from '../services/weather/ownBoatSkillTransaction';
import { OWN_BOAT_SKILL, type OwnBoatCapability, type OwnBoatProposal } from '../utils/ownBoatSkill';
import { scoreOwnWind } from '../pi-cache/src/ownBoatSkill/score';
const NOW = Date.UTC(2026, 9, 17, 6),
    ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const binding = {
    ownerId: ID,
    vesselId: ID,
    vesselRevision: 3,
    piDeviceId: ID,
    controllerId: ID,
    pairingRevision: '1'.repeat(64),
    enrollmentRevision: '2'.repeat(64),
    selfKey: '3'.repeat(64),
    windSourceKey: '4'.repeat(64),
    positionSourceKey: '5'.repeat(64),
};
const proposal: OwnBoatProposal = {
    schema: 1,
    nonce: 'a'.repeat(64),
    expiresAt: NOW + 60_000,
    binding,
    vesselName: 'Synthetic boat',
    windSource: 'Synthetic true wind',
    positionSource: 'Synthetic GPS',
};
const cap: OwnBoatCapability = {
    schema: 1,
    capability: 'b'.repeat(64),
    consent: {
        schema: 1,
        revision: ID,
        binding,
        issuedAt: NOW,
        expiresAt: NOW + OWN_BOAT_SKILL.consentMs,
    },
};
function fixture(saved: OwnBoatCapability | null = null) {
    const state = { current: true, samePi: true, now: NOW, mono: 100, saved };
    const save = vi.fn((value) => {
        state.saved = value;
    });
    const request = vi.fn<PrivateBoatPorts['request']>(async (path: string) => {
        if (path === 'prepare') return proposal;
        if (path === 'confirm') return cap;
        if (path === 'enable') return { schema: 1, state: 'logging' };
        if (path === 'off' || path === 'clear') return { schema: 1, state: 'off', cleared: path === 'clear' };
        if (path === 'open-read') return { schema: 1, readId: 'c'.repeat(64), expiresAt: NOW + OWN_BOAT_SKILL.readMs };
        return {
            schema: 1,
            basis: 'private-instrument-agreement',
            generatedAt: NOW / 1000,
            consentRevision: ID,
            logging: true,
            phase: 'Warming',
            lastMeasuredAt: null,
            scores: scoreOwnWind([], [], NOW, 'own:' + ID),
        };
    });
    const ports: PrivateBoatPorts = {
        ...binding,
        vesselName: proposal.vesselName,
        current: () => state.current,
        samePi: () => state.samePi,
        request,
        jwt: vi.fn(async () => 'synthetic.jwt.only'),
        saved,
        save,
        now: () => state.now,
        monotonic: () => state.mono,
        onRelease: vi.fn(),
    };
    const session = createPrivateBoatSession(ports);
    return { state, save, request, ports, session };
}
afterEach(() => vi.useRealTimers());
describe('private phone transaction', () => {
    it('enables only after the exact stop capability is saved; a lost confirmation never sends enable', async () => {
        const f = fixture();
        await f.session.prepare();
        const ordinary = f.ports.request;
        f.ports.request = async (...args) => {
            if (args[0] === 'enable') expect(f.state.saved).toEqual(cap);
            return ordinary(...args);
        };
        await f.session.confirm(true);
        expect(f.request.mock.calls.map((c) => c[0])).toEqual(['prepare', 'confirm', 'enable']);
        const lost = fixture();
        await lost.session.prepare();
        lost.request.mockRejectedValueOnce(Error('confirmation response lost'));
        await expect(lost.session.confirm(true)).rejects.toThrow();
        expect(lost.request.mock.calls.some((c) => c[0] === 'enable')).toBe(false);
        expect(lost.save).not.toHaveBeenCalled();
    });
    it('does no work until explicitly asked; confirmation carries explicit logging choice and no JWT persistence', async () => {
        const f = fixture();
        expect(f.request).not.toHaveBeenCalled();
        expect(await f.session.prepare()).toEqual(proposal);
        await f.session.confirm(false);
        expect(f.request).toHaveBeenLastCalledWith(
            'confirm',
            { schema: 1, nonce: proposal.nonce, logging: false },
            'synthetic.jwt.only',
        );
        expect(f.save).toHaveBeenLastCalledWith(cap);
        expect(JSON.stringify(f.state.saved)).not.toContain('synthetic.jwt');
        const data = await f.session.read();
        expect(data.scores.every((s) => s.status === 'warming' && s.closest === null)).toBe(true);
        expect(f.request.mock.calls.map((c) => c[0])).toEqual(['prepare', 'confirm', 'open-read', 'read']);
    });
    it.each(['ownerId', 'vesselId', 'piDeviceId', 'controllerId'] as const)(
        'refuses a mismatched %s from actual Pi review',
        async (key) => {
            const f = fixture();
            f.request.mockResolvedValueOnce({ ...proposal, binding: { ...binding, [key]: OTHER } });
            await expect(f.session.prepare()).rejects.toThrow();
            expect(f.save).not.toHaveBeenCalled();
        },
    );
    it('rejects source changes between review and grant, preserving the original stored grant', async () => {
        const f = fixture(cap);
        await f.session.prepare();
        f.request.mockResolvedValueOnce({
            ...cap,
            consent: { ...cap.consent, binding: { ...binding, selfKey: 'f'.repeat(64) } },
        });
        await expect(f.session.confirm(true)).rejects.toThrow();
        expect(f.save).not.toHaveBeenCalled();
    });
    it('best-effort revokes a returned late grant after an account retirement, never saving it', async () => {
        const f = fixture();
        await f.session.prepare();
        let resolve!: (v: unknown) => void;
        f.request.mockImplementationOnce(
            () =>
                new Promise((r) => {
                    resolve = r;
                }),
        );
        const pending = f.session.confirm(true);
        await Promise.resolve();
        f.state.current = false;
        f.session.retire();
        resolve(cap);
        await expect(pending).rejects.toThrow();
        expect(f.request).toHaveBeenLastCalledWith('off', { schema: 1, capability: cap.capability }, undefined, true);
        expect(f.save).not.toHaveBeenCalledWith(cap);
    });
    it('a native timeout retires the waiter while still cleaning a late grant', async () => {
        vi.useFakeTimers();
        const f = fixture();
        await f.session.prepare();
        let resolve!: (v: unknown) => void;
        f.request.mockImplementationOnce(
            () =>
                new Promise((r) => {
                    resolve = r;
                }),
        );
        const pending = f.session.confirm(true),
            rejected = expect(pending).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(OWN_BOAT_SKILL.operationMs + 1);
        await rejected;
        resolve(cap);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.request).toHaveBeenLastCalledWith('off', { schema: 1, capability: cap.capability }, undefined, true);
        expect(f.save).not.toHaveBeenCalledWith(cap);
    });
    it('retains the opaque capability after an unconfirmed local stop so it can be retried without WAN', async () => {
        const f = fixture(cap);
        f.request.mockRejectedValueOnce(Error('unreachable'));
        await expect(f.session.off(true)).rejects.toThrow();
        expect(f.session.saved).toBe(true);
        expect(f.save).not.toHaveBeenCalled();
        await f.session.off(true);
        expect(f.session.saved).toBe(false);
        expect(f.save).toHaveBeenLastCalledWith(null);
        expect(f.ports.jwt).not.toHaveBeenCalled();
    });
    it('keeps stop usable beyond evidence/read/access expiry but cannot target another Pi', async () => {
        const f = fixture(cap);
        f.state.now = cap.consent.expiresAt + 1;
        await expect(f.session.read()).rejects.toThrow();
        f.state.samePi = false;
        await expect(f.session.off(false)).rejects.toThrow();
        f.state.samePi = true;
        await f.session.off(false);
        expect(f.session.saved).toBe(false);
    });
    it('fails closed on wall rollback or monotonic read expiry, without asking for another score', async () => {
        const f = fixture(cap);
        await f.session.read();
        const count = f.request.mock.calls.length;
        f.state.now -= 2000;
        await expect(f.session.read()).rejects.toThrow();
        f.state.now = NOW;
        f.state.mono += OWN_BOAT_SKILL.readMs;
        await expect(f.session.read()).rejects.toThrow();
        expect(f.request).toHaveBeenCalledTimes(count);
    });
    it('stale read/revision or invented ready model data never becomes private advice', async () => {
        const f = fixture(cap);
        f.request.mockResolvedValueOnce({ schema: 1, readId: 'c'.repeat(64), expiresAt: NOW + 60_000 });
        f.request.mockResolvedValueOnce({
            schema: 1,
            basis: 'private-instrument-agreement',
            generatedAt: NOW / 1000,
            consentRevision: OTHER,
            logging: true,
            phase: 'Ready',
            lastMeasuredAt: null,
            scores: [],
        });
        await expect(f.session.read()).rejects.toThrow();
    });
    it('closed ordinary review does not stop the separately consented logger', () => {
        const f = fixture(cap);
        f.session.release();
        expect(f.request).not.toHaveBeenCalled();
        expect(f.save).not.toHaveBeenCalled();
        expect(f.session.current()).toBe(false);
    });
    it('keeps an original privacy stop usable after a vessel revision changes, while refusing reads', async () => {
        const f = fixture({ ...cap, consent: { ...cap.consent, binding: { ...binding, vesselRevision: 2 } } });
        await expect(f.session.read()).rejects.toThrow('another vessel or revision');
        expect(f.request).not.toHaveBeenCalled();
        await f.session.off(true);
        expect(f.request).toHaveBeenLastCalledWith('clear', { schema: 1, capability: cap.capability }, undefined, true);
    });
    it('auth retirement still closes access and attempts the original stop if local storage fails', async () => {
        const f = fixture(cap);
        f.save.mockImplementation(() => {
            throw Error('storage held');
        });
        f.session.retire();
        await Promise.resolve();
        expect(f.session.current()).toBe(false);
        expect(f.request).toHaveBeenCalledWith('off', { schema: 1, capability: cap.capability }, undefined, true);
    });
});
