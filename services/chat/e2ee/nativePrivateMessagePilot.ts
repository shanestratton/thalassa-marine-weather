/**
 * Uninstalled, opt-in SDK-to-native bridge for the private-message pilot.
 * Supabase supplies a bearer, never native account/device/key authority. The
 * native implementation must verify /user and enforce durable auth-fence tickets.
 * This file does not implement that plugin, crypto, relay, or token storage.
 */
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../authIdentityScope';
import {
    createPrivateMessagePilotRuntime,
    type NativePrivateMessageAuthority,
    type NativePrivateMessageReadiness,
    type NativePrivateMessageResult,
    type PrivateMessageFailure,
    type PrivateMessageNativePort,
    type PrivateMessagePilotRuntime,
} from './privateMessagePilot';

interface PilotSessionToken {
    access_token: string;
}

/** Structural subset of the real Supabase client's auth API. */
export interface PrivateMessageSupabaseAuth {
    getSession(): Promise<{ data: { session: PilotSessionToken | null }; error: unknown }>;
    onAuthStateChange(callback: (event: string, session: PilotSessionToken | null) => void): {
        data: { subscription: { unsubscribe(): void } };
    };
}

/**
 * Required native control contract, NOT an implemented Capacitor plugin.
 * fenceSession must durably invalidate existing credentials before resolving.
 * verify preserves owner generation/pending ciphertext; sign_out deactivates it.
 * Native creates authFence, binds it to the reserved native epoch and refuses
 * stale-fence Auth/commits. JS request IDs or SDK user fields grant no authority.
 * Calling a stale completion must never sign out a newer native session.
 */
export interface PrivateMessageNativePlugin extends PrivateMessageNativePort {
    fenceSession(options: {
        mode: 'verify' | 'sign_out';
    }): Promise<{ status: 'fenced'; authFence: string } | { status: 'unavailable'; reason: PrivateMessageFailure }>;
    authenticate(options: { accessToken: string; authFence: string }): Promise<NativePrivateMessageReadiness>;
}

export type NativePrivateMessageSessionState = 'stopped' | 'checking' | 'ready' | 'signed_out' | 'unavailable';

export interface NativePrivateMessagePilotSession {
    readonly runtime: PrivateMessagePilotRuntime;
    /** Does not start until explicitly called; the shipping app never calls it. */
    start(): void;
    /** Reverify current token, for foreground/resume or explicit retry. */
    refresh(): Promise<void>;
    /** Closes this pilot, not the Supabase account. Returns local native outcome. */
    dispose(): Promise<boolean>;
    state(): NativePrivateMessageSessionState;
    subscribeState(listener: (state: NativePrivateMessageSessionState) => void): () => void;
}

const closed = (reason: PrivateMessageFailure = 'unavailable') => ({ status: 'unavailable' as const, reason });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const exactMatch = (pattern: RegExp, value: unknown): value is string =>
    typeof value === 'string' && pattern.exec(value)?.[0] === value;
const validBearer = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 8192 &&
    exactMatch(/^[A-Za-z0-9._~+/-]+=*$/, value);

function validAuthority(value: NativePrivateMessageAuthority): boolean {
    return (
        !!value &&
        value.serverVerified === true &&
        exactMatch(UUID, value.accountId) &&
        exactMatch(UUID, value.deviceId) &&
        exactMatch(/^[A-Za-z0-9._:-]{1,128}$/, value.lifecycleVersion) &&
        Object.keys(value).every((key) => ['accountId', 'deviceId', 'lifecycleVersion', 'serverVerified'].includes(key))
    );
}

function sameAuthority(a: NativePrivateMessageAuthority, b: NativePrivateMessageAuthority): boolean {
    return (
        a.accountId === b.accountId &&
        a.deviceId === b.deviceId &&
        a.lifecycleVersion === b.lifecycleVersion &&
        b.serverVerified === true
    );
}

/** No auto-install, environment toggle, localStorage switch, logger or cache. */
export function createNativePrivateMessagePilotSession(options: {
    auth: PrivateMessageSupabaseAuth;
    native: PrivateMessageNativePlugin;
    /** Default is 30s, below native's conservative 60s verification lease. */
    reverifyMilliseconds?: number;
}): NativePrivateMessagePilotSession {
    const { auth, native } = options;
    const interval = options.reverifyMilliseconds ?? 30_000;
    if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 30_000) {
        throw new Error('Invalid private-message pilot reverify interval');
    }
    let started = false;
    let disposed = false;
    let revision = 0;
    let phase: NativePrivateMessageSessionState = 'stopped';
    let ready: { authority: NativePrivateMessageAuthority; scope: AuthIdentityScope; revision: number } | null = null;
    let unsubscribeAuth: (() => void) | null = null;
    let unsubscribeScope: (() => void) | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const listeners = new Set<(state: NativePrivateMessageSessionState) => void>();
    const activeSubscriptions = new Set<() => void>();

    function publish(next: NativePrivateMessageSessionState) {
        phase = next;
        for (const listener of [...listeners]) {
            try {
                listener(next);
            } catch {
                /* No error contents enter telemetry. */
            }
        }
    }
    function fenceView(next: NativePrivateMessageSessionState): number {
        revision += 1;
        ready = null;
        for (const close of [...activeSubscriptions]) {
            try {
                close();
            } catch {
                /* One listener cannot interrupt native fencing. */
            }
        }
        publish(next);
        return revision;
    }
    const current = (ticket: number) => started && !disposed && ticket === revision;
    function captured() {
        if (!ready || phase !== 'ready' || !current(ready.revision) || !isAuthIdentityScopeCurrent(ready.scope))
            return null;
        return ready;
    }
    function validReady(
        value: NativePrivateMessageReadiness,
        scope: AuthIdentityScope,
    ): value is Extract<NativePrivateMessageReadiness, { status: 'ready' }> {
        return (
            value?.status === 'ready' &&
            validAuthority(value.authority) &&
            value.authority.accountId === scope.userId &&
            Array.isArray(value.supportedContent) &&
            value.supportedContent.length === 1 &&
            value.supportedContent[0] === 'text'
        );
    }
    function nativeFence(mode: 'verify' | 'sign_out') {
        // Dispatch outside Auth callbacks without awaiting another SDK call in
        // the callback; Supabase may hold its own auth lock during that callback.
        return Promise.resolve().then(() => native.fenceSession({ mode }));
    }
    async function verify(
        ticket: number,
        scope: AuthIdentityScope,
        token: unknown,
        fence: ReturnType<typeof nativeFence>,
    ): Promise<void> {
        try {
            const result = await fence;
            if (!current(ticket) || !isAuthIdentityScopeCurrent(scope)) return;
            if (
                result?.status !== 'fenced' ||
                !exactMatch(/^[A-Za-z0-9._:-]{1,128}$/, result.authFence) ||
                !validBearer(token)
            ) {
                publish('unavailable');
                return;
            }
            const value = await native.authenticate({ accessToken: token, authFence: result.authFence });
            if (!current(ticket) || !isAuthIdentityScopeCurrent(scope)) return;
            if (!validReady(value, scope)) {
                publish('unavailable');
                return;
            }
            ready = { authority: { ...value.authority }, scope, revision: ticket };
            publish('ready');
        } catch {
            if (current(ticket)) {
                ready = null;
                publish('unavailable');
            }
        }
    }
    async function refresh(): Promise<void> {
        if (!started || disposed) return;
        const scope = getAuthIdentityScope();
        const ticket = fenceView(scope.userId ? 'checking' : 'signed_out');
        const fence = nativeFence(scope.userId ? 'verify' : 'sign_out');
        // Always consume a rejected native fence even when SDK boot also fails.
        const guardedFence = fence.catch(() => closed());
        if (!scope.userId) {
            const result = await guardedFence;
            if (current(ticket) && result.status !== 'fenced') publish('unavailable');
            return;
        }
        try {
            // A queued native call is not a durable fence. Do not acquire the
            // SDK bearer until native confirms its old credential is unusable.
            const fenced = await guardedFence;
            if (!current(ticket) || !isAuthIdentityScopeCurrent(scope)) return;
            if (fenced.status !== 'fenced' || !exactMatch(/^[A-Za-z0-9._:-]{1,128}$/, fenced.authFence)) {
                publish('unavailable');
                return;
            }
            const result = await auth.getSession();
            if (!current(ticket) || !isAuthIdentityScopeCurrent(scope)) return;
            if (result.error || !result.data?.session) {
                await guardedFence;
                // A confirmed absent SDK session is logout, not a failed
                // verification that may retain the sealed active generation.
                if (!result.error && current(ticket)) {
                    const ended = await native.fenceSession({ mode: 'sign_out' });
                    if (current(ticket) && ended.status !== 'fenced') {
                        publish('unavailable');
                        return;
                    }
                }
                if (current(ticket)) publish(result.error ? 'unavailable' : 'signed_out');
                return;
            }
            await verify(ticket, scope, result.data.session.access_token, guardedFence);
        } catch {
            await guardedFence;
            if (current(ticket)) publish('unavailable');
        }
    }
    function onAuth(event: string, session: PilotSessionToken | null) {
        if (!started || disposed) return;
        const scope = getAuthIdentityScope();
        const signedOut = event === 'SIGNED_OUT' || !session;
        const ticket = fenceView(signedOut ? 'signed_out' : 'checking');
        const fence = nativeFence(signedOut ? 'sign_out' : 'verify');
        if (signedOut) {
            void fence
                .then((result) => {
                    if (current(ticket) && result.status !== 'fenced') publish('unavailable');
                })
                .catch(() => {
                    if (current(ticket)) publish('unavailable');
                });
            return;
        }
        void verify(ticket, scope, session.access_token, fence);
    }

    async function operation<T>(
        authority: NativePrivateMessageAuthority,
        run: () => Promise<NativePrivateMessageResult<T>>,
    ): Promise<NativePrivateMessageResult<T>> {
        const before = captured();
        if (!before || !sameAuthority(before.authority, authority)) return closed('stale_authority');
        try {
            const result = await run();
            const after = captured();
            if (after !== before) return closed('stale_authority');
            return result;
        } catch {
            return closed();
        }
    }
    const port: PrivateMessageNativePort = {
        subscribeReadiness(listener) {
            const changed = () => listener();
            listeners.add(changed);
            return () => {
                listeners.delete(changed);
            };
        },
        async readiness() {
            const before = captured();
            if (!before) return closed(phase === 'signed_out' ? 'signed_out' : 'unavailable');
            try {
                const result = await native.readiness();
                if (
                    captured() !== before ||
                    !validReady(result, before.scope) ||
                    !sameAuthority(before.authority, result.authority)
                )
                    return closed('stale_authority');
                return result;
            } catch {
                return closed();
            }
        },
        getInbox: (request) => operation(request.authority, () => native.getInbox(request)),
        getThread: (request) => operation(request.authority, () => native.getThread(request)),
        sendText: (request) => operation(request.authority, () => native.sendText(request)),
        retryPending: (request) => operation(request.authority, () => native.retryPending(request)),
        getBlockStatus: (request) => operation(request.authority, () => native.getBlockStatus(request)),
        async setBlocked(request) {
            const before = captured();
            if (!before || !sameAuthority(before.authority, request.authority)) return closed('stale_authority');
            // A native peer control may advance its lifecycle revision. Close
            // the old rendering lease before dispatch; native must serialize
            // the control itself against Auth/logout and durable peer changes.
            const ticket = fenceView('checking');
            try {
                const result = await native.setBlocked(request);
                if (!current(ticket) || !isAuthIdentityScopeCurrent(before.scope)) return closed('stale_authority');
                if (result.status !== 'ok') {
                    publish('unavailable');
                    return result;
                }
                const latest = await native.readiness();
                if (!current(ticket) || !isAuthIdentityScopeCurrent(before.scope)) return closed('stale_authority');
                if (
                    !validReady(latest, before.scope) ||
                    !validAuthority(result.authority) ||
                    latest.authority.deviceId !== before.authority.deviceId ||
                    !sameAuthority(latest.authority, result.authority) ||
                    result.value?.peerAccountId !== request.peerAccountId ||
                    result.value.blockedByMe !== request.blocked
                ) {
                    publish('unavailable');
                    return closed('stale_authority');
                }
                ready = { authority: { ...latest.authority }, scope: before.scope, revision: ticket };
                publish('ready');
                return result;
            } catch {
                if (current(ticket)) publish('unavailable');
                return closed();
            }
        },
        async subscribe(request, listener) {
            const before = captured();
            if (!before || !sameAuthority(before.authority, request.authority)) {
                listener(closed('stale_authority'));
                return () => undefined;
            }
            let nativeClose: (() => void) | null = null;
            let cancelled = false;
            const close = () => {
                if (cancelled) return;
                cancelled = true;
                activeSubscriptions.delete(close);
                try {
                    nativeClose?.();
                } catch {
                    /* Remain locally closed. */
                }
                try {
                    listener(closed('stale_authority'));
                } catch {
                    /* Stay closed. */
                }
            };
            activeSubscriptions.add(close);
            try {
                nativeClose = await native.subscribe(request, (event) => {
                    if (!cancelled && captured() === before) {
                        try {
                            listener(event);
                        } catch {
                            /* Do not leak callback error contents. */
                        }
                    }
                });
                if (cancelled || captured() !== before) {
                    try {
                        nativeClose();
                    } catch {
                        /* Late subscription cannot publish. */
                    }
                    close();
                }
            } catch {
                close();
            }
            return close;
        },
    };
    const runtime = createPrivateMessagePilotRuntime(port);
    return {
        runtime,
        state: () => phase,
        subscribeState(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        start() {
            if (started || disposed) return;
            started = true;
            try {
                const before = revision;
                const subscription = auth.onAuthStateChange(onAuth).data.subscription;
                unsubscribeAuth = () => subscription.unsubscribe();
                unsubscribeScope = subscribeAuthIdentityScope(() => {
                    void refresh();
                });
                // Subscribe before boot read. A synchronous INITIAL_SESSION
                // event is authoritative; don't immediately supersede it.
                if (revision === before) void refresh();
                timer = setInterval(() => {
                    if (phase !== 'checking') void refresh();
                }, interval);
            } catch {
                fenceView('unavailable');
                void nativeFence('sign_out').catch(() => undefined);
            }
        },
        refresh,
        async dispose() {
            if (disposed) return phase === 'stopped';
            disposed = true;
            started = false;
            try {
                unsubscribeAuth?.();
            } catch {
                /* Continue native close. */
            }
            try {
                unsubscribeScope?.();
            } catch {
                /* Continue native close. */
            }
            if (timer) clearInterval(timer);
            fenceView('stopped');
            try {
                const result = await native.fenceSession({ mode: 'sign_out' });
                if (result.status === 'fenced') return true;
            } catch {
                /* No error contents or credentials leave this boundary. */
            }
            publish('unavailable');
            return false;
        },
    };
}
