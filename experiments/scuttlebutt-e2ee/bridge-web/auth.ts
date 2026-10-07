import { Capacitor, registerPlugin } from '@capacitor/core';
import { createClient } from '@supabase/supabase-js';
import type { ResearchPrivateMessagePluginBindings } from './privateMessagePort';

// This research port authenticates an account only. It grants no permission to
// send/read messages and must never be adapted into PM readiness by a Boolean.
export const RESEARCH_LABEL = 'Encryption test—not reviewed';
export const RESEARCH_SUPABASE_URL = 'https://kmtupdvwdgbhtssqqova.supabase.co';
export const RESEARCH_PLUGIN_NAME = 'ScuttlebuttResearchAuth';

export interface ResearchAccount {
    readonly accountId: string;
    readonly deviceId: string;
    readonly credentialBinding: string;
    readonly serverVerified: true;
}

export type NativeAccountResult = { status: 'authenticated'; account: ResearchAccount } | { status: 'unavailable' };
export type NativeFenceResult = { status: 'fenced'; authFence: string } | { status: 'unavailable' };
export type NativeConfigurationResult =
    | {
          status: 'configured';
          research: true;
          label: typeof RESEARCH_LABEL;
          supabaseUrl: typeof RESEARCH_SUPABASE_URL;
          publicApiKey: string;
      }
    | { status: 'unavailable' };

export interface ResearchAuthNativePlugin {
    configuration(): Promise<NativeConfigurationResult>;
    fenceSession(options: { mode: 'verify' | 'sign_out' }): Promise<NativeFenceResult>;
    authenticate(options: { accessToken: string; authFence: string }): Promise<NativeAccountResult>;
    currentAccount(): Promise<NativeAccountResult>;
}

// A single Research native host may outlive a React window/composition. All
// credential fences on that exact proxy are FIFO: terminal disposal of an old
// controller must finish before a replacement controller issues its new lease.
// This is JS dispatch ordering, not proof of native completion or revocation.
const nativeFenceTails = new WeakMap<ResearchAuthNativePlugin, Promise<void>>();
function queuedNativeFence(
    native: ResearchAuthNativePlugin,
    eligible: () => boolean,
    mode: 'verify' | 'sign_out',
): Promise<NativeFenceResult> {
    const previous = nativeFenceTails.get(native) ?? Promise.resolve();
    const next = previous.then(() => (eligible() ? native.fenceSession({ mode }) : { status: 'unavailable' as const }));
    nativeFenceTails.set(
        native,
        next.then(
            () => {},
            () => {},
        ),
    );
    return next;
}

interface SdkSession {
    access_token: string;
}
type SdkSessionResult = { data: { session: SdkSession | null }; error: unknown };

/** A narrow SDK seam for deterministic fixtures; the app uses the real SDK. */
export interface ResearchAuthSdk {
    getSession(): Promise<SdkSessionResult>;
    signInWithPassword(options: { email: string; password: string }): Promise<SdkSessionResult>;
    signOut(options: { scope: 'local' }): Promise<{ error: unknown }>;
    onAuthStateChange(callback: (event: string, session: SdkSession | null) => void): {
        data: { subscription: { unsubscribe(): void } };
    };
    stopAutoRefresh?(): void;
}

export const MEMORY_AUTH_OPTIONS = Object.freeze({
    auth: Object.freeze({
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: 'thalassa-scuttlebutt-research-memory-only',
    }),
});

export interface ResearchSdkConfiguration {
    readonly supabaseUrl: typeof RESEARCH_SUPABASE_URL;
    readonly publicApiKey: string;
}
export interface ResearchAuthDependencies {
    native: ResearchAuthNativePlugin;
    supported(): boolean;
    createSdk(configuration: ResearchSdkConfiguration, options: typeof MEMORY_AUTH_OPTIONS): ResearchAuthSdk;
}
export interface ResearchAuthState {
    readonly status: 'unsupported' | 'unavailable' | 'signed_out' | 'verifying' | 'authenticated';
    readonly account: ResearchAccount | null;
}
// Presentation only: these fixed labels neither grant nor retain account authority.
export type ResearchAuthUnavailableReason = 'verification_failed' | 'verification_lost' | 'credentials_rejected' | null;

// One Capacitor proxy for the one native host. Messaging projects its own
// research-only method interface onto this proxy, never registers a second one.
export const researchNativePlugin = registerPlugin<
    ResearchAuthNativePlugin &
        ResearchPrivateMessagePluginBindings & {
            messagePrivateAdmission(options: { credentialBinding: string }): Promise<unknown>;
        }
>(RESEARCH_PLUGIN_NAME);

const runtime: ResearchAuthDependencies = {
    native: researchNativePlugin,
    supported: () =>
        Capacitor.isNativePlatform() &&
        Capacitor.getPlatform() === 'ios' &&
        Capacitor.isPluginAvailable(RESEARCH_PLUGIN_NAME),
    createSdk: (configuration, options) => {
        const client = createClient(configuration.supabaseUrl, configuration.publicApiKey, options);
        return {
            getSession: () => client.auth.getSession(),
            signInWithPassword: (credentials) => client.auth.signInWithPassword(credentials),
            signOut: (scope) => client.auth.signOut(scope),
            onAuthStateChange: (callback) => client.auth.onAuthStateChange(callback),
            stopAutoRefresh: () => client.auth.stopAutoRefresh(),
        };
    },
};

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactMatch(pattern: RegExp, value: unknown): value is string {
    return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}

/** This only rejects privileged/malformed configuration; it does not verify JWT signatures. */
export function isResearchPublicApiKey(value: unknown): value is string {
    if (exactMatch(/^sb_publishable_[A-Za-z0-9_-]{8,256}$/, value)) return true;
    if (typeof value !== 'string' || value.length > 4096) return false;
    const parts = value.split('.');
    if (parts.length !== 3 || !parts.every((part) => exactMatch(/^[A-Za-z0-9_-]{1,3072}$/, part))) return false;
    try {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as unknown;
        return (
            object(payload) &&
            payload.role === 'anon' &&
            (payload.ref === undefined || payload.ref === 'kmtupdvwdgbhtssqqova')
        );
    } catch {
        return false;
    }
}

function validConfiguration(value: unknown): value is Extract<NativeConfigurationResult, { status: 'configured' }> {
    return (
        object(value) &&
        value.status === 'configured' &&
        value.research === true &&
        value.label === RESEARCH_LABEL &&
        value.supabaseUrl === RESEARCH_SUPABASE_URL &&
        isResearchPublicApiKey(value.publicApiKey)
    );
}
function validFence(value: unknown): value is Extract<NativeFenceResult, { status: 'fenced' }> {
    return object(value) && value.status === 'fenced' && exactMatch(/^[A-Za-z0-9._:-]{1,128}$/, value.authFence);
}
function validAccount(value: unknown): value is Extract<NativeAccountResult, { status: 'authenticated' }> {
    if (!object(value) || value.status !== 'authenticated' || !object(value.account)) return false;
    const account = value.account;
    return (
        account.serverVerified === true &&
        exactMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, account.accountId) &&
        exactMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, account.deviceId) &&
        exactMatch(/^[A-Za-z0-9._:-]{1,128}$/, account.credentialBinding)
    );
}
function validToken(value: unknown): value is string {
    return exactMatch(/^[A-Za-z0-9._~+/-]{1,8192}=*$/, value) && value.length <= 8192;
}
function sameAccount(left: ResearchAccount, right: ResearchAccount) {
    return (
        left.accountId === right.accountId &&
        left.deviceId === right.deviceId &&
        left.credentialBinding === right.credentialBinding
    );
}
function invalidSdkCredentials(error: unknown): boolean {
    try {
        // Read only the SDK's own literal code. Never match/serialize a message,
        // traverse an error cause, or invoke an untrusted diagnostic getter.
        return object(error) && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'invalid_credentials';
    } catch {
        return false;
    }
}

export class ResearchAuthController {
    private state: ResearchAuthState = Object.freeze({ status: 'unavailable', account: null });
    private unavailableReason: ResearchAuthUnavailableReason = null;
    private readonly listeners = new Set<(state: ResearchAuthState) => void>();
    private revision = 0;
    private initialized = false;
    private disposed = false;
    private initialization?: Promise<void>;
    private sdk?: ResearchAuthSdk;
    private configuration?: ResearchSdkConfiguration;
    private subscription?: { unsubscribe(): void };
    private intent: 'signed_in' | 'signed_out' = 'signed_out';
    // Identity continuity is metadata only, never a message capability. An
    // account switch requires explicit sign-out, including after lease expiry.
    private owner: Pick<ResearchAccount, 'accountId' | 'deviceId'> | null = null;
    private sdkTail: Promise<unknown> = Promise.resolve();
    private sdkDispatch: { revision: number; kind: 'acquire' | 'sign_out' } | null = null;
    private suspended = false;
    private suspension: Promise<void> = Promise.resolve();

    constructor(private readonly dependencies: ResearchAuthDependencies = runtime) {}

    getState(): ResearchAuthState {
        return this.state;
    }

    getUnavailableReason(): ResearchAuthUnavailableReason {
        return this.unavailableReason;
    }

    /** Presentation continuity only; this has no credential or message authority. */
    getPublicPairingOwner(): Readonly<Pick<ResearchAccount, 'accountId' | 'deviceId'>> | null {
        return this.owner;
    }

    canSignIn(): boolean {
        return this.initialized && !!this.sdk && !this.disposed;
    }

    canSignOut(): boolean {
        // An inactive/incomplete cold selection cannot be adopted, but must
        // still permit the explicit native logout fence after configuration.
        return !!this.configuration && !this.disposed;
    }

    subscribe(listener: (state: ResearchAuthState) => void): () => void {
        this.listeners.add(listener);
        listener(this.state);
        return () => this.listeners.delete(listener);
    }

    initialize(): Promise<void> {
        if (!this.initialization) this.initialization = this.initializeOnce();
        return this.initialization;
    }

    private async initializeOnce(): Promise<void> {
        const ticket = this.begin('verifying');
        try {
            if (!this.dependencies.supported()) {
                if (this.current(ticket)) this.publish('unsupported');
                return;
            }
            const configuration = await this.dependencies.native.configuration();
            if (!this.current(ticket)) return;
            if (!validConfiguration(configuration)) throw new Error('Unavailable');
            const sdkConfiguration: ResearchSdkConfiguration = Object.freeze({
                supabaseUrl: RESEARCH_SUPABASE_URL,
                publicApiKey: configuration.publicApiKey,
            });
            this.configuration = sdkConfiguration;
            // Cold launch has no bearer or displayed authority. Native verify
            // suspends credentials while retaining only a strictly reopened
            // selected owner; fresh same-account Auth is still mandatory.
            const fenced = await queuedNativeFence(this.dependencies.native, () => this.current(ticket), 'verify');
            if (!this.current(ticket)) return;
            if (!validFence(fenced)) throw new Error('Unavailable');
            this.createSdk(sdkConfiguration);
            this.publish('signed_out');
        } catch {
            this.fail(ticket);
        }
    }

    private createSdk(configuration: ResearchSdkConfiguration): void {
        const sdk = this.dependencies.createSdk(configuration, MEMORY_AUTH_OPTIONS);
        try {
            const subscription = sdk.onAuthStateChange((event, session) => this.authChanged(event, session)).data
                .subscription;
            this.sdk = sdk;
            this.subscription = subscription;
        } catch {
            sdk.stopAutoRefresh?.();
            throw new Error('Unavailable');
        }
        this.initialized = true;
    }

    async signIn(email: string, password: string): Promise<void> {
        if (!this.initialized || !this.sdk || this.disposed) return;
        this.suspended = false;
        const ticket = this.begin('verifying');
        if (!this.current(ticket)) return;
        this.intent = 'signed_in';
        if (!email.trim() || email.length > 320 || !password || password.length > 1024) {
            this.fail(ticket);
            return;
        }
        await this.verify(ticket, () => this.sdk!.signInWithPassword({ email: email.trim(), password }), this.owner);
    }

    async reverify(): Promise<void> {
        if (!this.initialized || !this.sdk || this.disposed) return;
        // A canceled first sign-in may have populated SDK memory, but never
        // established a verified owner. Require explicit credentials again.
        if (this.suspended && !this.owner) {
            this.publish('unavailable');
            return;
        }
        this.suspended = false;
        const ticket = this.begin('verifying');
        if (!this.current(ticket)) return;
        this.intent = 'signed_in';
        await this.verify(ticket, () => this.sdk!.getSession(), this.owner);
    }

    /**
     * An explicit pairing action may renew a previously verified native owner.
     * Its result belongs only to this renewal, never to a later login. It does
     * not enroll a device, preserve trust, extend a lease, or send a message.
     */
    async reverifyForPairing(): Promise<ResearchAccount | null> {
        if (
            !this.initialized ||
            !this.sdk ||
            this.disposed ||
            !this.dependencies.supported() ||
            !this.owner ||
            (this.state.status !== 'authenticated' && this.state.status !== 'unavailable')
        ) {
            return null;
        }
        const expectedOwner = this.owner;
        this.suspended = false;
        const ticket = this.begin('verifying');
        if (!this.current(ticket)) return null;
        this.intent = 'signed_in';
        await this.verify(ticket, () => this.sdk!.getSession(), expectedOwner);
        if (!this.current(ticket) || !this.dependencies.supported()) return null;
        const renewed = this.state.status === 'authenticated' ? this.state.account : null;
        if (!renewed || renewed.accountId !== expectedOwner.accountId || renewed.deviceId !== expectedOwner.deviceId) {
            return null;
        }
        return renewed;
    }

    private async verify(
        ticket: number,
        acquire: () => Promise<SdkSessionResult>,
        expectedOwner: Pick<ResearchAccount, 'accountId' | 'deviceId'> | null,
    ): Promise<void> {
        if (!this.current(ticket)) return;
        try {
            await this.suspension;
            if (!this.current(ticket)) return;
            const fenced = await queuedNativeFence(this.dependencies.native, () => this.current(ticket), 'verify');
            if (!this.current(ticket)) return;
            if (!validFence(fenced)) throw new Error('Unavailable');
            // Serial SDK work also checks the ticket at actual dispatch. A
            // queued token acquisition is forbidden after a newer sign-out.
            let result: SdkSessionResult;
            try {
                result = await this.sdkCall(ticket, 'acquire', acquire);
            } catch (error) {
                this.fail(ticket, invalidSdkCredentials(error) ? 'credentials_rejected' : 'verification_failed');
                return;
            }
            if (!this.current(ticket)) return;
            if (result.error || !result.data?.session) {
                if (!result.error) await this.close(ticket, false, 'verify');
                else
                    this.fail(
                        ticket,
                        invalidSdkCredentials(result.error) ? 'credentials_rejected' : 'verification_failed',
                    );
                return;
            }
            const token = result.data.session.access_token;
            if (!validToken(token)) throw new Error('Unavailable');
            const account = await this.dependencies.native.authenticate({
                accessToken: token,
                authFence: fenced.authFence,
            });
            if (!this.current(ticket)) return;
            if (!validAccount(account)) throw new Error('Unavailable');
            if (
                expectedOwner &&
                (account.account.accountId !== expectedOwner.accountId ||
                    account.account.deviceId !== expectedOwner.deviceId)
            ) {
                throw new Error('Unavailable');
            }
            const confirmed = await this.dependencies.native.currentAccount();
            if (!this.current(ticket)) return;
            if (!validAccount(confirmed) || !sameAccount(account.account, confirmed.account))
                throw new Error('Unavailable');
            this.owner = Object.freeze({
                accountId: confirmed.account.accountId,
                deviceId: confirmed.account.deviceId,
            });
            this.publish('authenticated', confirmed.account);
        } catch {
            this.fail(ticket);
        }
    }

    /** Clear displayed authority before either native or SDK asynchronous work. */
    suspend(): void {
        if (this.disposed || !this.initialized) return;
        this.suspended = true;
        this.intent = 'signed_out';
        const ticket = this.begin('unavailable');
        // Cancel queued/held token work synchronously, preserving sealed owner
        // continuity. A stale suspension must never fence a newer verification.
        this.suspension = this.suspension.then(async () => {
            if (this.disposed || !this.suspended || ticket !== this.revision) return;
            try {
                await queuedNativeFence(
                    this.dependencies.native,
                    () => !this.disposed && this.suspended && ticket === this.revision,
                    'verify',
                );
            } catch {
                /* Access remains unavailable. */
            }
        });
    }

    /** Explicit logout alone discards the selected native owner continuity. */
    async signOut(): Promise<void> {
        if (!this.canSignOut()) return;
        this.suspended = false;
        this.intent = 'signed_out';
        this.owner = null;
        const ticket = this.begin('verifying');
        await this.close(ticket, true, 'sign_out');
    }

    private async close(ticket: number, clearSdk: boolean, mode: 'verify' | 'sign_out'): Promise<void> {
        if (!this.current(ticket)) return;
        await this.suspension;
        if (!this.current(ticket)) return;
        this.intent = 'signed_out';
        // Expiry/absent tokens must revoke credentials, not destroy a ratchet.
        // Only the explicit sign-out action discards owner continuity.
        if (mode === 'sign_out') this.owner = null;
        let nativeClosed = false;
        try {
            const fenced = await queuedNativeFence(this.dependencies.native, () => this.current(ticket), mode);
            if (!this.current(ticket)) return;
            nativeClosed = validFence(fenced);
        } catch {
            if (!this.current(ticket)) return;
        }
        if (!this.current(ticket)) return;
        this.intent = 'signed_out';
        // Token removal is allowed even when native fencing failed. It is not
        // token acquisition and must never turn that native failure into success.
        let sdkClosed = true;
        if (clearSdk && this.sdk) {
            try {
                const result = await this.sdkCall(ticket, 'sign_out', () => this.sdk!.signOut({ scope: 'local' }));
                sdkClosed = !result.error;
            } catch {
                sdkClosed = false;
            }
        }
        // Cold verification may have failed before SDK creation. A successful
        // explicit native logout makes fresh selection possible, but never
        // turns the failed continuation into authenticated state.
        if (this.current(ticket) && nativeClosed && sdkClosed && !this.sdk && mode === 'sign_out') {
            try {
                if (!this.configuration) throw new Error('Unavailable');
                this.createSdk(this.configuration);
            } catch {
                sdkClosed = false;
            }
        }
        if (this.current(ticket)) {
            if (!nativeClosed || !sdkClosed) {
                if (mode === 'verify') this.fail(ticket);
                else this.publish('unavailable'); // Explicit logout clears any previous diagnostic.
            } else this.publish('signed_out');
        }
    }

    /** Account metadata is native-owned; SDK user/device claims are never used. */
    async checkCurrentAccount(): Promise<void> {
        if (this.state.status !== 'authenticated' || !this.state.account || this.disposed) return;
        const ticket = this.revision;
        const expected = this.state.account;
        try {
            const result = await this.dependencies.native.currentAccount();
            if (!this.current(ticket)) return;
            if (!validAccount(result) || !sameAccount(result.account, expected)) this.fail(ticket, 'verification_lost');
        } catch {
            this.fail(ticket, 'verification_lost');
        }
    }

    private authChanged(event: string, _session: SdkSession | null): void {
        if (this.disposed || this.suspended || !this.initialized || event === 'INITIAL_SESSION') return;
        // Supabase calls listeners while holding its Auth lock. This callback
        // returns synchronously: no SDK method is awaited or called here.
        if (this.sdkDispatch) {
            if (event !== 'SIGNED_OUT' || this.sdkDispatch.kind === 'sign_out') return;
        }
        if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN' || event === 'USER_UPDATED') {
            if (this.intent === 'signed_in') {
                const expectedOwner = this.owner;
                const ticket = this.begin('verifying');
                queueMicrotask(() => {
                    if (this.current(ticket)) void this.verify(ticket, () => this.sdk!.getSession(), expectedOwner);
                });
                return;
            }
        }
        // Unsolicited sessions, expiry and recovery events cannot open an owner.
        // Clear SDK memory and fence native credentials, but retain the sealed
        // owner for a later explicit same-account login (not account recovery).
        this.intent = 'signed_out';
        const ticket = this.begin('verifying');
        queueMicrotask(() => {
            if (this.current(ticket)) void this.close(ticket, true, 'verify');
        });
    }

    private sdkCall<T>(ticket: number, kind: 'acquire' | 'sign_out', operation: () => Promise<T>): Promise<T> {
        const result = this.sdkTail.then(async () => {
            if (!this.current(ticket)) throw new Error('Unavailable');
            this.sdkDispatch = { revision: ticket, kind };
            try {
                return await operation();
            } finally {
                this.sdkDispatch = null;
            }
        });
        this.sdkTail = result.catch(() => undefined);
        return result;
    }

    private current(ticket: number): boolean {
        return !this.disposed && !this.suspended && ticket === this.revision;
    }

    private begin(status: ResearchAuthState['status']): number {
        this.revision += 1;
        const ticket = this.revision;
        this.publish(status);
        return ticket;
    }

    private fail(ticket: number, reason: ResearchAuthUnavailableReason = 'verification_failed'): void {
        if (!this.current(ticket)) return;
        this.intent = 'signed_out';
        this.publish('unavailable', null, reason);
    }

    private publish(
        status: ResearchAuthState['status'],
        account: ResearchAccount | null = null,
        reason: ResearchAuthUnavailableReason = null,
    ): void {
        // Install the diagnostic synchronously before observers see the state.
        // Beginning, success, logout and disposal use the default cleared label.
        this.unavailableReason = status === 'unavailable' ? reason : null;
        this.state = Object.freeze({
            status,
            account: account
                ? Object.freeze({
                      accountId: account.accountId,
                      deviceId: account.deviceId,
                      credentialBinding: account.credentialBinding,
                      serverVerified: true as const,
                  })
                : null,
        });
        for (const listener of this.listeners) {
            try {
                listener(this.state);
            } catch {
                // A rendering observer cannot interrupt native fencing.
            }
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.revision += 1;
        const terminal = this.revision;
        this.intent = 'signed_out';
        this.owner = null;
        if (this.configuration) {
            this.suspension = queuedNativeFence(
                this.dependencies.native,
                () => this.disposed && this.revision === terminal,
                'verify',
            ).then(
                () => {},
                () => {},
            );
        }
        try {
            this.subscription?.unsubscribe();
        } catch {
            /* Credential denial is already queued. */
        }
        try {
            this.sdk?.stopAutoRefresh?.();
        } catch {
            /* Do not expose SDK diagnostics or skip the terminal fence. */
        }
        this.publish('unavailable');
        this.listeners.clear();
    }
}
