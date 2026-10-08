/**
 * Explicit App routing injection only. A selection grants no authentication,
 * encryption, peer trust or native readiness; ChatPage retains its validators.
 *
 * The render-time latch precedes App hooks, not module evaluation. An isolated
 * entry must deny legacy BEFORE importing App and its Auth/bootstrap graph.
 * No SDK, native controls, storage, transport or activation flag lives here.
 */
import type { ChatPageSelection } from '../../../components/ChatPage';
import { requireNativePrivateMessagesForProcess } from './privateMessageCutover';

export type AppPrivateMessageSelection = Exclude<ChatPageSelection, { kind: 'legacy' }>;

export interface AppPrivateMessageSelectionProps {
    /** Initial absence preserves ordinary routing; an explicit invalid value refuses. */
    privateMessageSelection?: AppPrivateMessageSelection;
}

const unavailable = Object.freeze({ kind: 'native-unavailable' as const });

/** Selection-value boundary: deny unconditionally before inspecting the value. */
export function normalizeAppPrivateMessageSelection(value: unknown): AppPrivateMessageSelection {
    requireNativePrivateMessagesForProcess();
    try {
        const selection = value;
        if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return unavailable;
        const kind = Reflect.get(selection, 'kind');
        if (kind !== 'native-pilot') return unavailable;
        const runtime = Reflect.get(selection, 'runtime');
        if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return unavailable;
        // Snapshot the routing fields only. Runtime method/authority validation
        // remains at ChatPage and the native pilot; this grants nothing.
        return Object.freeze({
            kind: 'native-pilot',
            runtime: runtime as Extract<ChatPageSelection, { kind: 'native-pilot' }>['runtime'],
        });
    } catch {
        return unavailable;
    }
}

/**
 * Trusted React-props convenience, NOT an untrusted-props admission boundary.
 * Object.hasOwn can run a Proxy ownership trap before presence is known; denying
 * before that check would change ordinary absent-prop builds. Trap failure denies
 * only AFTER that trap and cannot undo work it already dispatched. An isolated
 * entry must deny before importing App or inspecting untrusted props/proxies.
 */
export function getAppPrivateMessageSelection(props: unknown): ChatPageSelection | undefined {
    if (!props || (typeof props !== 'object' && typeof props !== 'function')) return undefined;
    try {
        if (!Object.hasOwn(props, 'privateMessageSelection')) return undefined;
    } catch {
        requireNativePrivateMessagesForProcess();
        return unavailable;
    }

    // Presence is now known. Deny BEFORE the props getter, then normalize the
    // selection value without releasing denial on invalid input or later absence.
    requireNativePrivateMessagesForProcess();
    try {
        return normalizeAppPrivateMessageSelection(Reflect.get(props, 'privateMessageSelection'));
    } catch {
        return unavailable;
    }
}
