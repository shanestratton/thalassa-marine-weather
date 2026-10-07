// @vitest-environment node
/** Actual local scope/cutover policy with injected native DTOs only. No SDK,
 * native host, credentials, persistence, HTTPS, device or encryption evidence. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthIdentityScope } from '../services/authIdentityScope';
import type { PrivateMessageCutoverPolicy } from '../services/chat/e2ee/privateMessageCutover';

type Startup = ReturnType<
    typeof import('../services/chat/e2ee/privateMessageStartup').createNativePrivateMessageStartup
>;
type Identity = typeof import('../services/authIdentityScope');
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const BINDING = '44444444-4444-4444-8444-444444444444';
const NIL = '00000000-0000-0000-0000-000000000000';
const active: { startup: Startup; identity: Identity; stopObserver: () => void }[] = [];
function admission(selection: 'protected-required' | 'unknown' = 'protected-required', accountId = ACCOUNT) {
    return { status: 'private_admission', accountId, deviceId: DEVICE, credentialBinding: BINDING, selection };
}
function deferred() {
    let resolve!: (value: unknown) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<unknown>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
async function fixture(userId: string | null = ACCOUNT, actualSingleton = false) {
    const identity = await import('../services/authIdentityScope');
    identity.setAuthIdentityScope(userId);
    const central = await import('../services/chat/e2ee/privateMessageCutover');
    const policy: PrivateMessageCutoverPolicy = central.createPrivateMessageCutoverPolicy(
        identity.getAuthIdentityScope,
        (listener) => identity.subscribeAuthIdentityScope(() => listener()),
    );
    const capture = (scope: AuthIdentityScope = identity.getAuthIdentityScope()) =>
        actualSingleton
            ? central.captureLegacyPrivateMessagePermit(scope, OTHER)
            : policy.captureLegacyPrivateMessagePermit(scope, OTHER);
    const isCurrent = (value: unknown) =>
        actualSingleton
            ? central.isLegacyPrivateMessagePermitCurrent(value)
            : policy.isLegacyPrivateMessagePermitCurrent(value);
    const permit = capture();
    const abort = actualSingleton
        ? central.captureLegacyPrivateMessageAbortScope(permit)
        : policy.captureLegacyPrivateMessageAbortScope(permit);
    const order: string[] = [];
    const stopObserver = actualSingleton
        ? central.subscribePrivateMessageCutover(() => order.push('process-denial'))
        : policy.subscribePrivateMessageCutover(() => order.push('process-denial'));
    const native = {
        readAdmission: vi.fn<() => Promise<unknown>>(async () => {
            order.push('native-read');
            expect(capture()).toBeNull();
            return admission();
        }),
        // Deliberately exposed spies detect an accidental lifecycle expansion.
        fenceSession: vi.fn(),
        signOut: vi.fn(),
        dispose: vi.fn(),
    };
    const { createNativePrivateMessageStartup } = await import('../services/chat/e2ee/privateMessageStartup');
    const permitCurrentBeforeConstruction = isCurrent(permit);
    const startup = createNativePrivateMessageStartup({ native, ...(actualSingleton ? {} : { policy }) });
    active.push({ startup, identity, stopObserver });
    return {
        startup,
        identity,
        policy,
        central,
        native,
        permit,
        abort,
        capture,
        isCurrent,
        order,
        permitCurrentBeforeConstruction,
    };
}
beforeEach(() => {
    // A new module graph supplies a new process-lifetime singleton; the policy
    // itself deliberately has no reset/downgrade API.
    vi.resetModules();
});
afterEach(() => {
    for (const value of active.splice(0)) {
        value.startup.stop();
        value.stopObserver();
        value.identity.setAuthIdentityScope(null);
    }
    vi.restoreAllMocks();
});

describe('explicit startup process denial — real local policy, injected native admission', () => {
    it.each([false, true])(
        'denies legacy synchronously with actual singleton=%s before native dispatch',
        async (actualSingleton) => {
            const f = await fixture(ACCOUNT, actualSingleton);
            expect(f.permit).not.toBeNull();
            expect(f.permitCurrentBeforeConstruction).toBe(true);
            expect(f.isCurrent(f.permit)).toBe(false);
            expect(f.abort?.signal.aborted).toBe(true);
            expect(f.capture()).toBeNull();
            expect(f.order).toEqual(['process-denial']);
            expect(f.startup.state()).toEqual({ kind: 'unknown' });
            expect(f.native.readAdmission).not.toHaveBeenCalled();
            f.identity.setAuthIdentityScope(OTHER);
            expect(f.capture()).toBeNull();
            expect(f.native.readAdmission).not.toHaveBeenCalled();
            f.startup.stop();
            expect(f.capture()).toBeNull();
            expect(f.native.fenceSession).not.toHaveBeenCalled();
            expect(f.native.signOut).not.toHaveBeenCalled();
            expect(f.native.dispose).not.toHaveBeenCalled();
        },
    );

    it('starts signed out for anonymous scope and does not select a native owner on refresh', async () => {
        const f = await fixture(null);
        expect(f.startup.state()).toEqual({ kind: 'signed_out' });
        await f.startup.refresh();
        expect(f.startup.state()).toEqual({ kind: 'signed_out' });
        for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
        f.identity.setAuthIdentityScope(ACCOUNT);
        expect(f.startup.state()).toEqual({ kind: 'unknown' });
        expect(f.capture()).toBeNull();
        expect(f.native.readAdmission).not.toHaveBeenCalled();
    });

    it.each(['not-a-uuid', NIL, 'AAAAAAAA-1111-4111-8111-111111111111'])(
        'refuses invalid local owner %s without native work',
        async (userId) => {
            const f = await fixture(userId);
            expect(f.startup.state()).toEqual({ kind: 'unavailable' });
            await f.startup.refresh();
            expect(f.startup.state()).toEqual({ kind: 'unavailable' });
            for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
            f.identity.setAuthIdentityScope(ACCOUNT);
            expect(f.capture()).toBeNull();
        },
    );

    it.each(['protected-required', 'unknown'] as const)(
        'publishes only the frozen %s selection fact and never grants legacy',
        async (selection) => {
            const f = await fixture();
            const gate = deferred();
            f.native.readAdmission.mockReturnValueOnce(gate.promise);
            const pending = f.startup.refresh();
            expect(f.startup.state()).toEqual({ kind: 'checking' });
            expect(f.native.readAdmission).toHaveBeenCalledExactlyOnceWith();
            gate.resolve(admission(selection));
            await pending;
            expect(f.startup.state()).toEqual({ kind: selection });
            expect(Object.isFrozen(f.startup.state())).toBe(true);
            expect(Object.keys(f.startup.state())).toEqual(['kind']);
            expect(f.capture()).toBeNull();
            f.startup.stop();
            expect(f.startup.state()).toEqual({ kind: 'stopped' });
            expect(f.capture()).toBeNull();
            for (const method of [f.native.fenceSession, f.native.signOut, f.native.dispose])
                expect(method).not.toHaveBeenCalled();
        },
    );
});

describe('closed native admission projection — no Auth or message authority', () => {
    const invalid = [
        { name: 'null DTO', value: null },
        { name: 'undefined DTO', value: undefined },
        { name: 'array DTO', value: [admission()] },
        { name: 'string DTO', value: 'protected-required' },
        { name: 'wrong status', value: { ...admission(), status: 'account_mode' } },
        {
            name: 'missing field',
            value: {
                status: 'private_admission',
                accountId: ACCOUNT,
                deviceId: DEVICE,
                selection: 'protected-required',
            },
        },
        { name: 'wrong owner', value: admission('protected-required', OTHER) },
        { name: 'boolean selection', value: { ...admission(), selection: true } },
        { name: 'legacy selection', value: { ...admission(), selection: 'legacy-permitted' } },
        { name: 'encryption selection', value: { ...admission(), selection: 'encrypted' } },
        { name: 'selection newline', value: { ...admission(), selection: 'protected-required\n' } },
        { name: 'extra authority flag', value: { ...admission(), canSend: true } },
        { name: 'extra private field', value: { ...admission(), bearer: 'private-admission-canary' } },
    ];
    it.each(invalid)('refuses $name, clears a prior selection and retains denial', async ({ value }) => {
        const f = await fixture();
        await f.startup.refresh();
        expect(f.startup.state().kind).toBe('protected-required');
        f.native.readAdmission.mockResolvedValueOnce(value);
        await f.startup.refresh();
        expect(f.startup.state()).toEqual({ kind: 'unavailable' });
        expect(JSON.stringify(f.startup.state())).not.toContain('private-admission-canary');
        expect(f.capture()).toBeNull();
    });

    it.each(
        ['accountId', 'deviceId', 'credentialBinding'].flatMap((field) =>
            [
                { name: 'nil UUID', value: NIL },
                { name: 'malformed UUID', value: 'not-a-uuid' },
                { name: 'uppercase UUID', value: 'AAAAAAAA-1111-4111-8111-111111111111' },
                { name: 'UUID newline', value: `${ACCOUNT}\n` },
                { name: 'number', value: 1 },
                { name: 'null', value: null },
            ].map((bad) => ({ field, ...bad })),
        ),
    )('refuses $name in $field', async ({ field, value }) => {
        const f = await fixture();
        f.native.readAdmission.mockResolvedValueOnce({ ...admission(), [field]: value });
        await f.startup.refresh();
        expect(f.startup.state()).toEqual({ kind: 'unavailable' });
        expect(f.capture()).toBeNull();
    });

    it.each(['accessor', 'hidden field', 'symbol extra', 'null prototype', 'inherited fields', 'hostile reflection'])(
        'refuses %s without invoking getters or exposing diagnostics',
        async (shape) => {
            const f = await fixture();
            const getter = vi.fn(() => 'protected-required');
            let value: unknown = admission();
            if (shape === 'accessor') Object.defineProperty(value, 'selection', { get: getter, enumerable: true });
            else if (shape === 'hidden field') Object.defineProperty(value, 'selection', { enumerable: false });
            else if (shape === 'symbol extra')
                Object.defineProperty(value, Symbol('private-admission-canary'), { value: true });
            else if (shape === 'null prototype')
                value = Object.assign(Object.create(null) as Record<string, unknown>, admission());
            else if (shape === 'inherited fields') value = Object.create(admission());
            else
                value = new Proxy(admission(), {
                    ownKeys() {
                        throw new Error('private-admission-canary');
                    },
                });
            f.native.readAdmission.mockResolvedValueOnce(value);
            await f.startup.refresh();
            expect(getter).not.toHaveBeenCalled();
            expect(f.startup.state()).toEqual({ kind: 'unavailable' });
            expect(f.capture()).toBeNull();
        },
    );

    it.each(['throw', 'reject'])('contains a native %s failure and never restores legacy access', async (failure) => {
        const f = await fixture();
        if (failure === 'throw')
            f.native.readAdmission.mockImplementationOnce(() => {
                throw new Error('private-admission-canary');
            });
        else f.native.readAdmission.mockRejectedValueOnce(new Error('private-admission-canary'));
        await expect(f.startup.refresh()).resolves.toBeUndefined();
        expect(f.startup.state()).toEqual({ kind: 'unavailable' });
        expect(f.capture()).toBeNull();
        f.startup.stop();
        f.identity.setAuthIdentityScope(OTHER);
        expect(f.capture()).toBeNull();
    });

    it('publishes a copied frozen state without retaining or freezing the caller DTO', async () => {
        const f = await fixture();
        const value = admission();
        f.native.readAdmission.mockResolvedValueOnce(value);
        await f.startup.refresh();
        const state = f.startup.state();
        expect(Object.isFrozen(state)).toBe(true);
        expect(Object.isFrozen(value)).toBe(false);
        value.selection = 'unknown';
        value.accountId = OTHER;
        expect(f.startup.state()).toBe(state);
        expect(state).toEqual({ kind: 'protected-required' });
        expect(() => Object.assign(state, { kind: 'unknown' })).toThrow();
    });
});

describe('original startup scope and refresh revision fences', () => {
    it('clears selected presentation immediately on each scope change without native work', async () => {
        const f = await fixture();
        await f.startup.refresh();
        expect(f.startup.state().kind).toBe('protected-required');
        for (const [userId, kind] of [
            [OTHER, 'unknown'],
            [null, 'signed_out'],
            ['invalid', 'unavailable'],
            [ACCOUNT, 'unknown'],
        ] as const) {
            f.identity.setAuthIdentityScope(userId);
            expect(f.startup.state()).toEqual({ kind });
            expect(f.native.readAdmission).toHaveBeenCalledTimes(1);
            expect(f.capture()).toBeNull();
        }
    });

    it.each(['other owner', 'logout', 'ABA', 'stop'])('discards a held valid admission after %s', async (change) => {
        const f = await fixture();
        const gate = deferred();
        f.native.readAdmission.mockReturnValueOnce(gate.promise);
        const pending = f.startup.refresh();
        expect(f.startup.state().kind).toBe('checking');
        if (change === 'stop') f.startup.stop();
        else if (change === 'logout') f.identity.setAuthIdentityScope(null);
        else {
            f.identity.setAuthIdentityScope(OTHER);
            if (change === 'ABA') f.identity.setAuthIdentityScope(ACCOUNT);
        }
        const fenced = f.startup.state();
        gate.resolve(admission());
        await pending;
        expect(f.startup.state()).toBe(fenced);
        expect(f.startup.state().kind).not.toBe('protected-required');
        expect(f.native.readAdmission).toHaveBeenCalledTimes(1);
        expect(f.capture()).toBeNull();
    });

    it('keeps a newer explicit refresh result when an older read completes later', async () => {
        const f = await fixture();
        const first = deferred(),
            second = deferred();
        f.native.readAdmission.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const old = f.startup.refresh(),
            current = f.startup.refresh();
        expect(f.native.readAdmission).toHaveBeenCalledTimes(2);
        second.resolve(admission('unknown'));
        await current;
        const newest = f.startup.state();
        first.resolve(admission('protected-required'));
        await old;
        expect(f.startup.state()).toBe(newest);
        expect(newest).toEqual({ kind: 'unknown' });
        expect(f.capture()).toBeNull();
    });

    it('does not let a stale native rejection replace the newer selected state', async () => {
        const f = await fixture();
        const gate = deferred();
        f.native.readAdmission.mockReturnValueOnce(gate.promise);
        const old = f.startup.refresh();
        await f.startup.refresh();
        const newest = f.startup.state();
        gate.reject(new Error('old-private-admission-canary'));
        await old;
        expect(f.startup.state()).toBe(newest);
        expect(newest.kind).toBe('protected-required');
    });

    it.each(['switch', 'stop', 'refresh'])(
        'fences native dispatch when a checking observer reenters with %s',
        async (change) => {
            const f = await fixture();
            let changed = false;
            let nested: Promise<void> | undefined;
            f.startup.subscribeState((state) => {
                if (state.kind !== 'checking' || changed) return;
                changed = true;
                if (change === 'switch') f.identity.setAuthIdentityScope(OTHER);
                else if (change === 'stop') f.startup.stop();
                else nested = f.startup.refresh();
            });
            await f.startup.refresh();
            await nested;
            expect(changed).toBe(true);
            expect(f.native.readAdmission).toHaveBeenCalledTimes(change === 'refresh' ? 1 : 0);
            expect(f.startup.state().kind).toBe(
                change === 'refresh' ? 'protected-required' : change === 'stop' ? 'stopped' : 'unknown',
            );
            expect(f.capture()).toBeNull();
        },
    );

    it('fences scope changes triggered during DTO reflection before publishing the parsed selection', async () => {
        const f = await fixture();
        let changed = false;
        const value = new Proxy(admission(), {
            getOwnPropertyDescriptor(target, key) {
                if (key === 'selection' && !changed) {
                    changed = true;
                    f.identity.setAuthIdentityScope(OTHER);
                }
                return Reflect.getOwnPropertyDescriptor(target, key);
            },
        });
        f.native.readAdmission.mockResolvedValueOnce(value);
        await f.startup.refresh();
        expect(changed).toBe(true);
        expect(f.startup.state()).toEqual({ kind: 'unknown' });
        expect(f.capture()).toBeNull();
    });

    it('does not notify later observers with an obsolete protected snapshot after publication reentry', async () => {
        const f = await fixture();
        f.startup.subscribeState((state) => {
            if (state.kind === 'protected-required') f.identity.setAuthIdentityScope(OTHER);
        });
        const lateObserver = vi.fn();
        f.startup.subscribeState(lateObserver);
        await f.startup.refresh();
        expect(f.startup.state()).toEqual({ kind: 'unknown' });
        expect(lateObserver.mock.calls.some(([state]) => state.kind === 'protected-required')).toBe(false);
        expect(f.capture()).toBeNull();
    });

    it('isolates broken observers and removes an unsubscribed observer', async () => {
        const f = await fixture();
        expect(() =>
            f.startup.subscribeState(() => {
                throw new Error('private-observer-canary');
            }),
        ).not.toThrow();
        const observer = vi.fn();
        const stopObserver = f.startup.subscribeState(observer);
        expect(observer).toHaveBeenCalledWith({ kind: 'unknown' });
        stopObserver();
        observer.mockClear();
        await f.startup.refresh();
        expect(f.startup.state()).toEqual({ kind: 'protected-required' });
        expect(observer).not.toHaveBeenCalled();
    });

    it('stops idempotently without native logout, later refresh or scope adoption', async () => {
        const f = await fixture();
        f.startup.stop();
        const stopped = f.startup.state();
        f.startup.stop();
        f.identity.setAuthIdentityScope(OTHER);
        await f.startup.refresh();
        expect(f.startup.state()).toBe(stopped);
        expect(stopped).toEqual({ kind: 'stopped' });
        expect(f.capture()).toBeNull();
        for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
    });
});
