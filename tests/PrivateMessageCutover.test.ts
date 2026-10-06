/** Deterministic process-local denial fixtures, not Auth, crypto or live relay evidence. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthIdentityScope } from '../services/authIdentityScope';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import * as cutoverExports from '../services/chat/e2ee/privateMessageCutover';
import {
    createPrivateMessageCutoverPolicy,
    type PrivateMessageCutoverPolicy,
} from '../services/chat/e2ee/privateMessageCutover';

vi.mock('../services/supabase', () => {
    throw new Error('Cutover must not load production Supabase');
});
vi.mock('../stores/authStore', () => {
    throw new Error('Cutover must not initialize production Auth');
});
vi.mock('../services/ChatService', () => {
    throw new Error('Cutover must not initialize legacy chat');
});

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const carol = '33333333-3333-4333-8333-333333333333';
const scopeFor = (userId: string, generation = 0): AuthIdentityScope => ({ key: `user:${userId}`, userId, generation });

function fixture() {
    let current: AuthIdentityScope = Object.freeze(scopeFor(alice));
    const changes = new Set<() => void>();
    const policy = createPrivateMessageCutoverPolicy(
        () => current,
        (listener) => {
            changes.add(listener);
            return () => {
                changes.delete(listener);
            };
        },
    );
    return {
        policy,
        current: () => current,
        select: (scope: AuthIdentityScope) => {
            current = scope;
            for (const listener of [...changes]) listener();
        },
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('private-message cutover denial and original-scope permits', () => {
    it('defaults to legacy with opaque frozen hints and no native authority or reset API', () => {
        const { policy, current } = fixture();
        const permit = policy.captureLegacyPrivateMessagePermit(current(), bob);
        expect(permit).not.toBeNull();
        expect(Object.isFrozen(permit)).toBe(true);
        expect(Object.getPrototypeOf(permit)).toBeNull();
        expect(Reflect.ownKeys(permit!)).toEqual([]);
        expect(JSON.stringify(permit)).toBe('{}');
        expect(policy.isLegacyPrivateMessagePermitCurrent(permit)).toBe(true);
        expect(Object.isFrozen(policy)).toBe(true);
        expect(Object.keys(policy).sort()).toEqual([
            'cancelLegacyPrivateMessageAbortSignal',
            'captureLegacyPrivateMessageAbortScope',
            'captureLegacyPrivateMessagePermit',
            'isLegacyPrivateMessageAbortSignalCurrent',
            'isLegacyPrivateMessageAbortSignalOwned',
            'isLegacyPrivateMessagePermitCurrent',
            'requireNativePrivateMessagesForScope',
            'subscribePrivateMessageCutover',
        ]);
        expect(Object.keys(cutoverExports).sort()).toEqual([
            'PrivateMessageLegacyUnavailableError',
            'cancelLegacyPrivateMessageAbortSignal',
            'captureLegacyPrivateMessageAbortScope',
            'captureLegacyPrivateMessagePermit',
            'createPrivateMessageCutoverPolicy',
            'isLegacyPrivateMessageAbortSignalCurrent',
            'isLegacyPrivateMessageAbortSignalOwned',
            'isLegacyPrivateMessagePermitCurrent',
            'isPrivateMessageLegacyUnavailable',
            'requireNativePrivateMessagesForScope',
            'subscribePrivateMessageCutover',
        ]);
    });

    it('latches denial before notifying and never grants native readiness', () => {
        const { policy, current } = fixture();
        const permit = policy.captureLegacyPrivateMessagePermit(current(), bob);
        const observed: Array<{ oldPermitCurrent: boolean; freshLegacyAdmitted: boolean }> = [];
        const listener = vi.fn(() => {
            observed.push({
                oldPermitCurrent: policy.isLegacyPrivateMessagePermitCurrent(permit),
                freshLegacyAdmitted: policy.captureLegacyPrivateMessagePermit(current(), bob) !== null,
            });
        });
        policy.subscribePrivateMessageCutover(listener);
        expect(policy.requireNativePrivateMessagesForScope(current())).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(observed).toEqual([{ oldPermitCurrent: false, freshLegacyAdmitted: false }]);
        expect(listener.mock.calls[0]).toEqual([]);
        expect(policy.requireNativePrivateMessagesForScope(current())).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(policy.captureLegacyPrivateMessagePermit(current())).toBeNull();
    });

    it('keeps a native-required account denied after view cleanup, sign-out and same-account return', () => {
        const { policy, current, select } = fixture();
        const stop = policy.subscribePrivateMessageCutover(vi.fn());
        policy.requireNativePrivateMessagesForScope(current());
        stop();
        select({ key: 'anonymous', userId: null, generation: 1 });
        expect(policy.captureLegacyPrivateMessagePermit(current())).toBeNull();
        select(scopeFor(alice, 2));
        expect(policy.captureLegacyPrivateMessagePermit(current(), bob)).toBeNull();
        expect(policy.requireNativePrivateMessagesForScope(current())).toBe(true);
    });

    it('preserves another account legacy lane while denying a latched sender or peer', () => {
        const { policy, current, select } = fixture();
        policy.requireNativePrivateMessagesForScope(current());
        select(scopeFor(bob, 1));
        const otherPeer = policy.captureLegacyPrivateMessagePermit(current(), carol);
        expect(policy.isLegacyPrivateMessagePermitCurrent(otherPeer)).toBe(true);
        expect(policy.captureLegacyPrivateMessagePermit(current(), alice)).toBeNull();
        expect(policy.captureLegacyPrivateMessagePermit(current())).toBeNull();
        expect(policy.requireNativePrivateMessagesForScope(scopeFor(alice, 0))).toBe(false);
        expect(policy.isLegacyPrivateMessagePermitCurrent(otherPeer)).toBe(true);
    });

    it('requires exact full current scope for denial admission and permit capture', () => {
        const { policy, current, select } = fixture();
        const notification = vi.fn();
        policy.subscribePrivateMessageCutover(notification);
        for (const stale of [scopeFor(bob), scopeFor(alice, 1), { ...current(), key: 'wrong-key' }]) {
            expect(policy.requireNativePrivateMessagesForScope(stale)).toBe(false);
            expect(policy.captureLegacyPrivateMessagePermit(stale, bob)).toBeNull();
        }
        expect(notification).not.toHaveBeenCalled();
        const permit = policy.captureLegacyPrivateMessagePermit({ ...current() }, bob);
        expect(policy.isLegacyPrivateMessagePermitCurrent(permit)).toBe(true);
        select({ ...current(), userId: bob });
        expect(policy.isLegacyPrivateMessagePermitCurrent(permit)).toBe(false);
    });

    it('uses one fixed no-input refusal without accepting raw error lookalikes', () => {
        const error = new cutoverExports.PrivateMessageLegacyUnavailableError();
        expect(error.message).toBe('Legacy private messaging is unavailable.');
        expect(cutoverExports.isPrivateMessageLegacyUnavailable(error)).toBe(true);
        expect(cutoverExports.isPrivateMessageLegacyUnavailable(new Error(error.message))).toBe(false);
        expect(cutoverExports.isPrivateMessageLegacyUnavailable({ name: error.name, message: error.message })).toBe(
            false,
        );
        expect(cutoverExports.isPrivateMessageLegacyUnavailable(null)).toBe(false);
    });

    it('rejects Alice-Bob-Alice generation ABA after an asynchronous operation', async () => {
        const { policy, current, select } = fixture();
        const permit = policy.captureLegacyPrivateMessagePermit(current(), carol);
        const held = deferred<string>();
        const publish = vi.fn();
        const result = (async () => {
            const value = await held.promise;
            if (policy.isLegacyPrivateMessagePermitCurrent(permit)) publish(value);
        })();
        select(scopeFor(bob, 1));
        select(scopeFor(alice, 2));
        held.resolve('Held plaintext fixture');
        await result;
        expect(publish).not.toHaveBeenCalled();
    });

    it('retains original scope scalars and never revives an observed alias-mutated permit', () => {
        const mutable = { key: `user:${alice}`, userId: alice, generation: 0 };
        const policy = createPrivateMessageCutoverPolicy(() => mutable);
        const permit = policy.captureLegacyPrivateMessagePermit(mutable, bob);
        expect(policy.isLegacyPrivateMessagePermitCurrent(permit)).toBe(true);
        mutable.generation = 1;
        expect(policy.isLegacyPrivateMessagePermitCurrent(permit)).toBe(false);
        mutable.generation = 0;
        expect(policy.isLegacyPrivateMessagePermitCurrent(permit)).toBe(false);
        expect(() => Object.assign(permit!, { scope: mutable, revision: 0 })).toThrow();
    });

    it('rejects forged, copied, proxied and separately owned permits', () => {
        const { policy, current } = fixture();
        const permit = policy.captureLegacyPrivateMessagePermit(current(), bob)!;
        const otherPolicy = createPrivateMessageCutoverPolicy(current);
        for (const forged of [
            null,
            undefined,
            0,
            true,
            () => undefined,
            {},
            { ...permit },
            Object.freeze(Object.create(null)),
            new Proxy(permit, {}),
            otherPolicy.captureLegacyPrivateMessagePermit(current(), bob),
        ]) {
            expect(policy.isLegacyPrivateMessagePermitCurrent(forged)).toBe(false);
        }
        expect(otherPolicy.isLegacyPrivateMessagePermitCurrent(permit)).toBe(false);
        expect(policy.isLegacyPrivateMessagePermitCurrent(permit)).toBe(true);
    });

    it('invalidates outstanding hints on a policy revision even for another peer', () => {
        const { policy, current, select } = fixture();
        const old = policy.captureLegacyPrivateMessagePermit(current(), carol);
        select(scopeFor(bob, 1));
        policy.requireNativePrivateMessagesForScope(current());
        select(scopeFor(alice, 2));
        expect(policy.isLegacyPrivateMessagePermitCurrent(old)).toBe(false);
        expect(policy.captureLegacyPrivateMessagePermit(current(), bob)).toBeNull();
        expect(policy.captureLegacyPrivateMessagePermit(current(), carol)).not.toBeNull();
    });

    it('cancels both queued dispatch and publication after an explicit native selection', async () => {
        const { policy, current } = fixture();
        const beforeDispatch = policy.captureLegacyPrivateMessagePermit(current(), bob);
        const beforePublication = policy.captureLegacyPrivateMessagePermit(current(), bob);
        const held = deferred<void>();
        const dispatch = vi.fn();
        const publish = vi.fn();
        const dispatchResult = (async () => {
            await held.promise;
            if (policy.isLegacyPrivateMessagePermitCurrent(beforeDispatch)) dispatch();
        })();
        // A remote operation already dispatched cannot be recalled; only its
        // held local publication is represented and suppressed by this fixture.
        const publicationResult = (async () => {
            await held.promise;
            if (policy.isLegacyPrivateMessagePermitCurrent(beforePublication)) publish();
        })();
        policy.requireNativePrivateMessagesForScope(current());
        held.resolve(undefined);
        await Promise.all([dispatchResult, publicationResult]);
        expect(dispatch).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });

    it.each([
        { key: 'anonymous', userId: null, generation: 0 },
        { key: 'user:', userId: '', generation: 0 },
        { key: 'user:alice\n', userId: 'alice\n', generation: 0 },
        { key: `user:${'a'.repeat(129)}`, userId: 'a'.repeat(129), generation: 0 },
        { ...scopeFor(alice), generation: -1 },
        { ...scopeFor(alice), generation: Number.MAX_SAFE_INTEGER + 1 },
    ])('rejects malformed or anonymous current scope %# without a denial mutation', (scope) => {
        const policy = createPrivateMessageCutoverPolicy(() => scope);
        const changed = vi.fn();
        policy.subscribePrivateMessageCutover(changed);
        expect(policy.captureLegacyPrivateMessagePermit(scope)).toBeNull();
        expect(policy.requireNativePrivateMessagesForScope(scope)).toBe(false);
        expect(changed).not.toHaveBeenCalled();
    });

    it('bounds peer identifiers and suppresses scope-reader exceptions without diagnostics', () => {
        const { policy, current } = fixture();
        for (const peer of ['', 'bad\0peer', 'bad\npeer', 'x'.repeat(129)])
            expect(policy.captureLegacyPrivateMessagePermit(current(), peer)).toBeNull();
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const broken = createPrivateMessageCutoverPolicy(() => {
            throw new Error('Raw fixture detail');
        });
        expect(broken.captureLegacyPrivateMessagePermit(current(), bob)).toBeNull();
        expect(broken.requireNativePrivateMessagesForScope(current())).toBe(false);
        expect(broken.isLegacyPrivateMessagePermitCurrent({})).toBe(false);
        expect(error).not.toHaveBeenCalled();
    });

    it('fails every legacy account closed on the seventeenth latch without evicting older denials', () => {
        const { policy, current, select } = fixture();
        const changed = vi.fn();
        policy.subscribePrivateMessageCutover(changed);
        for (let index = 0; index < 16; index += 1) {
            select(scopeFor(`fixture-account-${index}`, index));
            expect(policy.requireNativePrivateMessagesForScope(current())).toBe(true);
        }
        select(scopeFor(carol, 16));
        const stillLegacy = policy.captureLegacyPrivateMessagePermit(current(), bob);
        expect(policy.isLegacyPrivateMessagePermitCurrent(stillLegacy)).toBe(true);
        expect(policy.requireNativePrivateMessagesForScope(current())).toBe(true);
        expect(policy.isLegacyPrivateMessagePermitCurrent(stillLegacy)).toBe(false);
        select(scopeFor(bob, 17));
        expect(policy.captureLegacyPrivateMessagePermit(current())).toBeNull();
        select(scopeFor('fixture-account-0', 18));
        expect(policy.captureLegacyPrivateMessagePermit(current())).toBeNull();
        expect(policy.requireNativePrivateMessagesForScope(current())).toBe(true);
        expect(changed).toHaveBeenCalledTimes(17);
    });
});

describe('owned original-permit abort scopes', () => {
    it('retains signal ownership after cancellation/disposal and refuses foreign or proxy signals', () => {
        const { policy, current } = fixture();
        const permit = policy.captureLegacyPrivateMessagePermit(current(), bob);
        const disposed = policy.captureLegacyPrivateMessageAbortScope(permit)!;
        const cancelled = policy.captureLegacyPrivateMessageAbortScope(permit)!;
        const foreign = new AbortController();
        expect(policy.isLegacyPrivateMessageAbortSignalOwned(disposed.signal)).toBe(true);
        expect(policy.isLegacyPrivateMessageAbortSignalCurrent(disposed.signal)).toBe(true);
        for (const signal of [foreign.signal, {}, null, new Proxy(disposed.signal, {})]) {
            expect(policy.isLegacyPrivateMessageAbortSignalOwned(signal)).toBe(false);
            expect(policy.isLegacyPrivateMessageAbortSignalCurrent(signal)).toBe(false);
            policy.cancelLegacyPrivateMessageAbortSignal(signal);
        }
        expect(foreign.signal.aborted).toBe(false);
        disposed.dispose();
        policy.cancelLegacyPrivateMessageAbortSignal(cancelled.signal);
        policy.cancelLegacyPrivateMessageAbortSignal(cancelled.signal);
        for (const request of [disposed, cancelled]) {
            expect(request.signal.aborted).toBe(true);
            expect(policy.isLegacyPrivateMessageAbortSignalOwned(request.signal)).toBe(true);
            expect(policy.isLegacyPrivateMessageAbortSignalCurrent(request.signal)).toBe(false);
        }
        const other = createPrivateMessageCutoverPolicy(current);
        expect(other.isLegacyPrivateMessageAbortSignalOwned(cancelled.signal)).toBe(false);
        other.cancelLegacyPrivateMessageAbortSignal(cancelled.signal);
    });

    it('releases constructor-refused pending admission and preserves the original permit', () => {
        const { policy, current } = fixture();
        const permit = policy.captureLegacyPrivateMessagePermit(current(), bob);
        const OriginalController = AbortController;
        vi.stubGlobal(
            'AbortController',
            class {
                constructor() {
                    throw new Error('Raw allocation fixture');
                }
            },
        );
        expect(policy.captureLegacyPrivateMessageAbortScope(permit)).toBeNull();
        vi.stubGlobal('AbortController', OriginalController);
        const requests = Array.from({ length: 32 }, () => policy.captureLegacyPrivateMessageAbortScope(permit));
        expect(requests.every((request) => request !== null)).toBe(true);
        requests.forEach((request) => request?.dispose());
    });

    it('wires singleton cancellation directly to the real tiny local scope fence', () => {
        setAuthIdentityScope(null);
        setAuthIdentityScope(alice);
        const original = getAuthIdentityScope();
        const permit = cutoverExports.captureLegacyPrivateMessagePermit(original, bob);
        const request = cutoverExports.captureLegacyPrivateMessageAbortScope(permit)!;
        expect(request.signal.aborted).toBe(false);
        setAuthIdentityScope(bob);
        expect(request.signal.aborted).toBe(true);
        expect(cutoverExports.captureLegacyPrivateMessageAbortScope(permit)).toBeNull();
        request.dispose();
        setAuthIdentityScope(null);
    });
    it('aborts every owned request before arbitrary UI cutover listeners, with opaque frozen control', () => {
        const { policy, current } = fixture();
        const permit = policy.captureLegacyPrivateMessagePermit(current(), bob);
        const first = policy.captureLegacyPrivateMessageAbortScope(permit)!;
        const second = policy.captureLegacyPrivateMessageAbortScope(permit)!;
        const observed: boolean[][] = [];
        policy.subscribePrivateMessageCutover(() => observed.push([first.signal.aborted, second.signal.aborted]));
        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.keys(first).sort()).toEqual(['dispose', 'signal']);
        expect(first.signal.aborted).toBe(false);
        policy.requireNativePrivateMessagesForScope(current());
        expect(observed).toEqual([[true, true]]);
        first.dispose();
        first.dispose();
        second.dispose();
        expect(policy.captureLegacyPrivateMessageAbortScope(permit)).toBeNull();
    });

    it('aborts immediately on identity departure and never refreshes the original permit on ABA', () => {
        const { policy, current, select } = fixture();
        const permit = policy.captureLegacyPrivateMessagePermit(current(), bob);
        const request = policy.captureLegacyPrivateMessageAbortScope(permit)!;
        select(scopeFor(bob, 1));
        expect(request.signal.aborted).toBe(true);
        select(scopeFor(alice, 2));
        expect(policy.captureLegacyPrivateMessageAbortScope(permit)).toBeNull();
        expect(
            policy.captureLegacyPrivateMessageAbortScope(policy.captureLegacyPrivateMessagePermit(current(), bob)),
        ).not.toBeNull();
    });

    it('does not revive old permits when a fixture scope adapter reports scalar ABA', () => {
        const { policy, current, select } = fixture();
        const permit = policy.captureLegacyPrivateMessagePermit(current(), bob);
        const request = policy.captureLegacyPrivateMessageAbortScope(permit)!;
        select(scopeFor(bob, 1));
        select(scopeFor(alice, 0));
        expect(request.signal.aborted).toBe(true);
        expect(policy.isLegacyPrivateMessagePermitCurrent(permit)).toBe(false);
        expect(policy.captureLegacyPrivateMessageAbortScope(permit)).toBeNull();
    });

    it('caps live owned scopes at 32, releases disposed slots and cancels disposed signals idempotently', () => {
        const { policy, current } = fixture();
        const permit = policy.captureLegacyPrivateMessagePermit(current(), bob);
        const requests = Array.from({ length: 32 }, () => policy.captureLegacyPrivateMessageAbortScope(permit)!);
        expect(requests.every((scope) => !!scope && !scope.signal.aborted)).toBe(true);
        expect(policy.captureLegacyPrivateMessageAbortScope(permit)).toBeNull();
        requests[0].dispose();
        requests[0].dispose();
        expect(requests[0].signal.aborted).toBe(true);
        const replacement = policy.captureLegacyPrivateMessageAbortScope(permit)!;
        expect(replacement.signal.aborted).toBe(false);
        expect(policy.captureLegacyPrivateMessageAbortScope(permit)).toBeNull();
        for (const request of requests) request.dispose();
        replacement.dispose();
        expect(policy.captureLegacyPrivateMessageAbortScope(permit)).not.toBeNull();
    });

    it('refuses forged and separately owned permits without consuming admission slots', () => {
        const { policy, current } = fixture();
        const other = createPrivateMessageCutoverPolicy(current);
        const valid = policy.captureLegacyPrivateMessagePermit(current(), bob);
        for (const permit of [
            {},
            Object.freeze(Object.create(null)),
            other.captureLegacyPrivateMessagePermit(current(), bob),
        ])
            expect(policy.captureLegacyPrivateMessageAbortScope(permit)).toBeNull();
        const requests = Array.from({ length: 32 }, () => policy.captureLegacyPrivateMessageAbortScope(valid));
        expect(requests.every((request) => request !== null)).toBe(true);
        requests.forEach((request) => request?.dispose());
    });

    it('denies reentrant admission during abort, including nested policy changes before UI publication', () => {
        const { policy, current, select } = fixture();
        const old = policy.captureLegacyPrivateMessagePermit(current(), bob);
        const first = policy.captureLegacyPrivateMessageAbortScope(old)!;
        const second = policy.captureLegacyPrivateMessageAbortScope(old)!;
        const admissions: unknown[] = [],
            published: boolean[][] = [];
        first.signal.addEventListener('abort', () => {
            select(scopeFor(bob, 1));
            const permitted = policy.captureLegacyPrivateMessagePermit(current(), carol);
            admissions.push(policy.captureLegacyPrivateMessageAbortScope(permitted));
            policy.requireNativePrivateMessagesForScope(current());
        });
        policy.subscribePrivateMessageCutover(() => published.push([first.signal.aborted, second.signal.aborted]));
        policy.requireNativePrivateMessagesForScope(current());
        expect(admissions).toEqual([null]);
        expect(published.length).toBeGreaterThan(0);
        expect(published.every((signals) => signals.every(Boolean))).toBe(true);
        expect(policy.captureLegacyPrivateMessageAbortScope(old)).toBeNull();
    });

    it('rechecks the owned original permit after registration and releases a raced admission', () => {
        let current = scopeFor(alice),
            changeDuringCheck = false;
        const signals: AbortSignal[] = [];
        const OriginalController = AbortController;
        vi.stubGlobal(
            'AbortController',
            class extends OriginalController {
                constructor() {
                    super();
                    signals.push(this.signal);
                }
            },
        );
        const policy = createPrivateMessageCutoverPolicy(() => {
            if (changeDuringCheck && signals.length > 0) current = scopeFor(bob, 1);
            return current;
        });
        const permit = policy.captureLegacyPrivateMessagePermit(current, carol);
        changeDuringCheck = true;
        expect(policy.captureLegacyPrivateMessageAbortScope(permit)).toBeNull();
        expect(signals).toHaveLength(1);
        expect(signals[0].aborted).toBe(true);
        changeDuringCheck = false;
        const fresh = policy.captureLegacyPrivateMessagePermit(current, carol);
        const requests = Array.from({ length: 32 }, () => policy.captureLegacyPrivateMessageAbortScope(fresh));
        expect(requests.every((request) => request !== null)).toBe(true);
        requests.forEach((request) => request?.dispose());
    });

    it('fails abort admission closed when scope notification setup refuses', () => {
        const policy = createPrivateMessageCutoverPolicy(
            () => scopeFor(alice),
            () => {
                throw new Error('Raw scope adapter fixture');
            },
        );
        const permit = policy.captureLegacyPrivateMessagePermit(scopeFor(alice), bob);
        expect(permit).not.toBeNull();
        expect(policy.captureLegacyPrivateMessageAbortScope(permit)).toBeNull();
    });

    it('reserves pending scope checks under the same cap when a getter reenters admission', () => {
        const current = scopeFor(alice);
        let nesting = false,
            started = false;
        let permit: unknown;
        const nested: Array<ReturnType<PrivateMessageCutoverPolicy['captureLegacyPrivateMessageAbortScope']>> = [];
        const policy = createPrivateMessageCutoverPolicy(() => {
            if (started && !nesting) {
                nesting = true;
                for (let index = 0; index < 32; index += 1)
                    nested.push(policy.captureLegacyPrivateMessageAbortScope(permit));
                nesting = false;
            }
            return current;
        });
        permit = policy.captureLegacyPrivateMessagePermit(current, bob);
        started = true;
        const outer = policy.captureLegacyPrivateMessageAbortScope(permit);
        const admitted = [outer, ...nested].filter((value) => value !== null);
        expect(admitted).toHaveLength(32);
        expect(nested.some((value) => value === null)).toBe(true);
        admitted.forEach((request) => request?.dispose());
    });
});

describe('bounded signal-only cutover subscription fixtures', () => {
    it('isolates listener failures and respects cancellation before another listener turn', () => {
        const { policy, current } = fixture();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const cancelled = vi.fn();
        const survivor = vi.fn();
        let cancel!: () => void;
        policy.subscribePrivateMessageCutover(() => {
            cancel();
            throw new Error('Raw listener detail');
        });
        cancel = policy.subscribePrivateMessageCutover(cancelled);
        policy.subscribePrivateMessageCutover(survivor);
        expect(() => policy.requireNativePrivateMessagesForScope(current())).not.toThrow();
        expect(cancelled).not.toHaveBeenCalled();
        expect(survivor).toHaveBeenCalledTimes(1);
        expect(survivor.mock.calls[0]).toEqual([]);
        expect(consoleError).not.toHaveBeenCalled();
        cancel();
    });

    it('queues reentrant changes without recursive listener stacks or restoring old permits', () => {
        const { policy, current, select } = fixture();
        const permit = policy.captureLegacyPrivateMessagePermit(current(), bob);
        let depth = 0,
            maximumDepth = 0,
            visits = 0;
        const oldPermitObservations: boolean[] = [],
            admittedDenials: boolean[] = [];
        policy.subscribePrivateMessageCutover(() => {
            depth += 1;
            maximumDepth = Math.max(maximumDepth, depth);
            visits += 1;
            oldPermitObservations.push(policy.isLegacyPrivateMessagePermitCurrent(permit));
            if (current().userId === alice) {
                select(scopeFor(bob, 1));
                admittedDenials.push(policy.requireNativePrivateMessagesForScope(current()));
            } else admittedDenials.push(policy.requireNativePrivateMessagesForScope(current()));
            depth -= 1;
        });
        policy.requireNativePrivateMessagesForScope(current());
        expect(maximumDepth).toBe(1);
        expect(visits).toBe(2);
        expect(oldPermitObservations).toEqual([false, false]);
        expect(admittedDenials).toEqual([true, true]);
        expect(policy.captureLegacyPrivateMessagePermit(current(), carol)).toBeNull();
    });

    it('does not replay a notification into a newly added listener, and self-cancellation persists', () => {
        const { policy, current, select } = fixture();
        const late = vi.fn();
        let stop!: () => void;
        const first = vi.fn(() => {
            stop();
            policy.subscribePrivateMessageCutover(late);
        });
        stop = policy.subscribePrivateMessageCutover(first);
        policy.requireNativePrivateMessagesForScope(current());
        expect(first).toHaveBeenCalledTimes(1);
        expect(late).not.toHaveBeenCalled();
        select(scopeFor(bob, 1));
        policy.requireNativePrivateMessagesForScope(current());
        expect(first).toHaveBeenCalledTimes(1);
        expect(late).toHaveBeenCalledTimes(1);
    });

    it('admits at most 32 live listeners without eviction and frees a cancelled slot', () => {
        const { policy, current, select } = fixture();
        const admitted = Array.from({ length: 32 }, () => vi.fn());
        const stops = admitted.map((listener) => policy.subscribePrivateMessageCutover(listener));
        const overflow = vi.fn();
        const refusedStop = policy.subscribePrivateMessageCutover(overflow);
        policy.requireNativePrivateMessagesForScope(current());
        for (const listener of admitted) expect(listener).toHaveBeenCalledTimes(1);
        expect(overflow).not.toHaveBeenCalled();
        refusedStop();
        stops[0]();
        stops[0]();
        const replacement = vi.fn();
        policy.subscribePrivateMessageCutover(replacement);
        select(scopeFor(bob, 1));
        policy.requireNativePrivateMessagesForScope(current());
        expect(admitted[0]).toHaveBeenCalledTimes(1);
        expect(replacement).toHaveBeenCalledTimes(1);
        expect(overflow).not.toHaveBeenCalled();
    });
});
