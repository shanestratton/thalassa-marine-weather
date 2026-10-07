/**
 * Explicit isolated startup only. Construct BEFORE importing private consumers,
 * including application Auth/bootstrap, queues and push callbacks. Importing
 * this module alone does not activate a pilot or change ordinary build defaults.
 *
 * Construction synchronously latches process-wide legacy denial. Native facts
 * below affect presentation only: no result grants Auth, peer trust, encryption,
 * readiness or legacy permission. There is no SDK/token/storage/network logic,
 * enrollment, automatic refresh, sign-out, release or downgrade here.
 */
import { getAuthIdentityScope, subscribeAuthIdentityScope, type AuthIdentityScope } from '../../authIdentityScope';
import { requireNativePrivateMessagesForProcess, type PrivateMessageCutoverPolicy } from './privateMessageCutover';

export type NativePrivateMessageStartupKind =
    | 'checking'
    | 'unknown'
    | 'protected-required'
    | 'unavailable'
    | 'signed_out'
    | 'stopped';

export interface NativePrivateMessageStartupState {
    readonly kind: NativePrivateMessageStartupKind;
}

export interface NativePrivateMessageStartup {
    /** Explicit read only. Scope changes never start native work. */
    refresh(): Promise<void>;
    state(): Readonly<NativePrivateMessageStartupState>;
    subscribeState(listener: (state: Readonly<NativePrivateMessageStartupState>) => void): () => void;
    /** Fence this view and unsubscribe only; NEVER native logout/disposal. */
    stop(): void;
}

interface AdmissionFact {
    readonly status: 'private_admission';
    readonly accountId: string;
    readonly deviceId: string;
    readonly credentialBinding: string;
    readonly selection: 'protected-required' | 'unknown';
}
interface StartupScope {
    readonly key: string;
    readonly userId: string | null;
    readonly generation: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const uuid = (value: unknown): value is string =>
    typeof value === 'string' && value !== NIL_UUID && UUID.exec(value)?.[0] === value;
const stateValue = (kind: NativePrivateMessageStartupKind) => Object.freeze({ kind });

function copyScope(value: AuthIdentityScope): StartupScope {
    return Object.freeze({ key: value.key, userId: value.userId, generation: value.generation });
}
function scopeKind(scope: StartupScope): 'unknown' | 'signed_out' | 'unavailable' {
    if (scope.userId === null && scope.key === 'anonymous') return 'signed_out';
    return uuid(scope.userId) &&
        scope.key === `user:${scope.userId}` &&
        Number.isSafeInteger(scope.generation) &&
        scope.generation >= 0
        ? 'unknown'
        : 'unavailable';
}
function admissionFact(value: unknown): Readonly<AdmissionFact> | null {
    try {
        if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null;
        const names = ['status', 'accountId', 'deviceId', 'credentialBinding', 'selection'];
        const keys = Reflect.ownKeys(value);
        if (keys.length !== names.length || keys.some((key) => typeof key !== 'string' || !names.includes(key)))
            return null;
        const copy: Record<string, unknown> = {};
        for (const name of names) {
            const descriptor = Object.getOwnPropertyDescriptor(value, name);
            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
            copy[name] = descriptor.value;
        }
        if (
            copy.status !== 'private_admission' ||
            !uuid(copy.accountId) ||
            !uuid(copy.deviceId) ||
            !uuid(copy.credentialBinding) ||
            (copy.selection !== 'protected-required' && copy.selection !== 'unknown')
        )
            return null;
        return Object.freeze({
            status: 'private_admission',
            accountId: copy.accountId,
            deviceId: copy.deviceId,
            credentialBinding: copy.credentialBinding,
            selection: copy.selection,
        });
    } catch {
        return null;
    }
}

export function createNativePrivateMessageStartup(options: {
    native: { readAdmission(): Promise<unknown> };
    policy?: Pick<PrivateMessageCutoverPolicy, 'requireNativePrivateMessagesForProcess'>;
}): Readonly<NativePrivateMessageStartup> {
    // FIRST effect: a provisional/anonymous scope, missing native adapter or
    // synchronous observer reentry cannot leave a startup legacy window open.
    const policy = options.policy ?? { requireNativePrivateMessagesForProcess };
    policy.requireNativePrivateMessagesForProcess();

    let revision = 0;
    let stopped = false;
    let view = stateValue(scopeKind(copyScope(getAuthIdentityScope())));
    const listeners = new Set<(state: Readonly<NativePrivateMessageStartupState>) => void>();
    const publish = (kind: NativePrivateMessageStartupKind) => {
        const snapshot = (view = stateValue(kind));
        const publicationRevision = revision;
        for (const listener of [...listeners]) {
            if (revision !== publicationRevision || view !== snapshot) break;
            if (!listeners.has(listener)) continue;
            try {
                listener(snapshot);
            } catch {
                /* Fixed view; no callback diagnostic publication. */
            }
        }
    };
    const current = (ticket: number, scope: StartupScope) => {
        const actual = getAuthIdentityScope();
        return (
            !stopped &&
            revision === ticket &&
            actual.key === scope.key &&
            actual.userId === scope.userId &&
            actual.generation === scope.generation
        );
    };
    const unsubscribe = subscribeAuthIdentityScope(() => {
        if (stopped) return;
        revision += 1;
        publish(scopeKind(copyScope(getAuthIdentityScope())));
    });

    return Object.freeze({
        state: () => view,
        subscribeState(listener: (state: Readonly<NativePrivateMessageStartupState>) => void) {
            if (typeof listener !== 'function' || stopped || listeners.size >= 32) return () => undefined;
            listeners.add(listener);
            try {
                listener(view);
            } catch {
                /* Observer failures grant nothing. */
            }
            return () => {
                listeners.delete(listener);
            };
        },
        async refresh() {
            if (stopped) return;
            // Capture before the checking notification: synchronous reentry
            // must not rebind an original action to a newer account/revision.
            const scope = copyScope(getAuthIdentityScope());
            const ticket = ++revision;
            const kind = scopeKind(scope);
            if (kind !== 'unknown') {
                publish(kind);
                return;
            }
            publish('checking');
            if (!current(ticket, scope)) return;
            try {
                const raw = await options.native.readAdmission();
                if (!current(ticket, scope)) return;
                const fact = admissionFact(raw);
                if (!current(ticket, scope)) return;
                if (!fact || fact.accountId !== scope.userId) {
                    publish('unavailable');
                    return;
                }
                // These bound scalars are denial facts only. Native owns its
                // original credential-epoch/publication guard; local scope alone
                // cannot detect a same-account native lease replacement.
                publish(fact.selection);
            } catch {
                if (current(ticket, scope)) publish('unavailable');
            }
        },
        stop() {
            if (stopped) return;
            stopped = true;
            revision += 1;
            unsubscribe();
            publish('stopped');
            listeners.clear();
        },
    });
}
