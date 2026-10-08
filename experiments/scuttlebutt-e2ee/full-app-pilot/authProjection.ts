/** Presentation only for the isolated full-App fixture. The existing Research
 * controller remains the sole Auth driver; this module creates no SDK, native
 * verifier, token cache, browser listener or refresh loop. Native account facts
 * are not a Supabase User, a private-message permission or encrypted readiness.
 */
import type { ResearchAccount, ResearchAuthController, ResearchAuthState } from '../bridge-web/auth';

export type FullAppResearchAuthSource = Pick<ResearchAuthController, 'getState' | 'subscribe'>;

export interface FullAppAuthProjectionState {
    readonly status: ResearchAuthState['status'] | 'detached' | 'inactive';
    /** Public native metadata only; the original credential binding stays private. */
    readonly nativeOwner: Readonly<Pick<ResearchAccount, 'accountId' | 'deviceId'>> | null;
    /** Presentation invalidation only, not the native credential generation. */
    readonly generation: number;
}

export interface FullAppAuthProjectionAttachment {
    /** Hide/deactivate synchronously before the composition suspends native Auth. */
    deactivate(): void;
    /** Await a fresh controller publication; never reuse a pre-hide Auth snapshot. */
    reactivate(): void;
    /** Terminal for this handle. A superseded handle cannot clear its successor. */
    detach(): void;
}

type Listener = (state: FullAppAuthProjectionState, previous: FullAppAuthProjectionState) => void;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BINDING = /^[A-Za-z0-9._:-]{1,128}$/;
const STATUSES = new Set<ResearchAuthState['status']>([
    'unsupported',
    'unavailable',
    'signed_out',
    'verifying',
    'authenticated',
]);

function exactMatch(pattern: RegExp, value: string): boolean {
    return pattern.exec(value)?.[0] === value;
}

function ownValue(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/** Frozen controller snapshots contain own data fields. Do not run diagnostic
 * getters or allow a partial/malformed account to become presentation identity.
 */
function inspect(state: ResearchAuthState): {
    status: ResearchAuthState['status'];
    account: ResearchAccount | null;
} {
    try {
        const status = ownValue(state, 'status');
        if (!STATUSES.has(status as ResearchAuthState['status'])) return { status: 'unavailable', account: null };
        if (status !== 'authenticated') return { status: status as ResearchAuthState['status'], account: null };
        const raw = ownValue(state, 'account');
        const accountId = ownValue(raw, 'accountId');
        const deviceId = ownValue(raw, 'deviceId');
        const credentialBinding = ownValue(raw, 'credentialBinding');
        if (
            ownValue(raw, 'serverVerified') !== true ||
            typeof accountId !== 'string' ||
            !exactMatch(UUID, accountId) ||
            typeof deviceId !== 'string' ||
            !exactMatch(UUID, deviceId) ||
            typeof credentialBinding !== 'string' ||
            !exactMatch(BINDING, credentialBinding)
        ) {
            return { status: 'unavailable', account: null };
        }
        return { status: 'authenticated', account: { accountId, deviceId, credentialBinding, serverVerified: true } };
    } catch {
        return { status: 'unavailable', account: null };
    }
}

function sameOwner(left: ResearchAccount | null, right: ResearchAccount | null): boolean {
    return (
        left === right ||
        (!!left &&
            !!right &&
            left.accountId === right.accountId &&
            left.deviceId === right.deviceId &&
            left.credentialBinding === right.credentialBinding)
    );
}

export function createFullAppAuthProjection() {
    // A malformed null publication must be inspected and close presentation;
    // it must not collide with the absence of a pre-hide snapshot fence.
    const noBlockedSnapshot = Symbol('no-blocked-auth-snapshot');
    let state: FullAppAuthProjectionState = Object.freeze({ status: 'detached', nativeOwner: null, generation: 0 });
    const initialState = state;
    const listeners = new Set<Listener>();
    let current: {
        source: FullAppResearchAuthSource;
        active: boolean;
        detached: boolean;
        unsubscribe: (() => void) | null;
        blockedSnapshot: ResearchAuthState | typeof noBlockedSnapshot;
        originalOwner: ResearchAccount | null;
    } | null = null;

    function publish(status: FullAppAuthProjectionState['status'], owner: ResearchAccount | null = null) {
        const previous = state;
        state = Object.freeze({
            status,
            nativeOwner: owner ? Object.freeze({ accountId: owner.accountId, deviceId: owner.deviceId }) : null,
            generation: previous.generation + 1,
        });
        for (const listener of [...listeners]) {
            try {
                listener(state, previous);
            } catch {
                // One presentation observer cannot prevent other views closing.
            }
        }
    }

    function stopSubscription(attachment: NonNullable<typeof current>) {
        const unsubscribe = attachment.unsubscribe;
        attachment.unsubscribe = null;
        try {
            unsubscribe?.();
        } catch {
            // The local identity/generation fence already rejects later callbacks.
        }
    }

    function attach(source: FullAppResearchAuthSource): FullAppAuthProjectionAttachment {
        const previous = current;
        const owned: NonNullable<typeof current> = {
            source,
            active: true,
            detached: false,
            unsubscribe: null,
            blockedSnapshot: noBlockedSnapshot,
            originalOwner: null,
        };
        // Reserve the new attachment before cleanup or presentation callbacks
        // can reenter. A later nested attach wins; it never grants native Auth.
        current = owned;
        if (previous) {
            previous.detached = true;
            previous.active = false;
            previous.originalOwner = null;
            stopSubscription(previous);
        }
        const eligible = () => current === owned && !owned.detached && owned.active;
        if (eligible()) publish('unavailable');
        const update = (snapshot: ResearchAuthState) => {
            if (!eligible() || snapshot === owned.blockedSnapshot) return;
            try {
                // A callback held across owner, binding or attachment changes
                // cannot re-publish an earlier controller-owned snapshot.
                if (source.getState() !== snapshot) {
                    owned.originalOwner = null;
                    if (eligible()) publish('unavailable');
                    return;
                }
                if (!eligible()) return;
                const observed = inspect(snapshot);
                // Snapshot/equality data is private and never added to App's
                // AuthState. Each fresh publication fences prior presentation.
                owned.originalOwner = observed.account;
                if (
                    source.getState() !== snapshot ||
                    !sameOwner(owned.originalOwner, inspect(snapshot).account) ||
                    !eligible()
                ) {
                    owned.originalOwner = null;
                    if (eligible()) publish('unavailable');
                    return;
                }
                publish(observed.status, observed.account);
            } catch {
                if (eligible()) {
                    owned.originalOwner = null;
                    publish('unavailable');
                }
            }
        };
        try {
            // Old unsubscribe/presentation callbacks may already have installed
            // a successor. Never create an observer for this superseded owner.
            if (current === owned && !owned.detached) {
                const unsubscribe = source.subscribe(update);
                if (current !== owned || owned.detached) {
                    unsubscribe();
                } else owned.unsubscribe = unsubscribe;
            }
        } catch {
            // A defective source may retain update before throwing. There is no
            // unsubscribe handle to trust; terminal local fencing prevents that
            // callback from reviving presentation. It supplies no native power.
            owned.detached = true;
            owned.active = false;
            owned.originalOwner = null;
            stopSubscription(owned);
            if (current === owned) {
                current = null;
                publish('unavailable');
            }
        }
        return Object.freeze({
            deactivate() {
                if (current !== owned || owned.detached) return;
                owned.active = false;
                owned.originalOwner = null;
                try {
                    owned.blockedSnapshot = source.getState();
                } catch {
                    owned.blockedSnapshot = noBlockedSnapshot;
                }
                publish('inactive');
            },
            reactivate() {
                if (current !== owned || owned.detached || owned.active) return;
                try {
                    // Publications made while hidden are also stale for the
                    // next visible window, even if a callback is delivered late.
                    owned.blockedSnapshot = source.getState();
                } catch {
                    owned.blockedSnapshot = noBlockedSnapshot;
                }
                owned.active = true;
                owned.originalOwner = null;
                // A fresh reverify/sign-in publication is required. The caller
                // owns that action through the same ResearchAuthController.
                publish('unavailable');
            },
            detach() {
                if (owned.detached) return;
                owned.detached = true;
                owned.active = false;
                owned.originalOwner = null;
                stopSubscription(owned);
                if (current !== owned) return;
                current = null;
                publish('detached');
            },
        });
    }

    return Object.freeze({
        getState: () => state,
        getInitialState: () => initialState,
        subscribe(listener: Listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        attach,
    });
}

/** This singleton is selected only by the isolated full-App build alias. */
export const fullAppAuthProjection = createFullAppAuthProjection();
export const attachFullAppResearchAuth = fullAppAuthProjection.attach;
