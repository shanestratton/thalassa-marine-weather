import React, { Suspense } from 'react';
import type { PrivateMessagePilotRuntime, PrivateMessageRuntime } from '../services/chat/e2ee/privateMessagePilot';

/** Explicit selection, not plugin detection, environment state or a rollout flag. */
export type ChatPageSelection =
    | { kind: 'legacy' }
    | { kind: 'native-pilot'; runtime: PrivateMessagePilotRuntime }
    | { kind: 'native-unavailable' };

export interface ChatPageProps {
    onBack?: () => void;
    selection?: ChatPageSelection;
    /** Compatibility for existing deliberate research injection. */
    privateMessageRuntime?: PrivateMessageRuntime;
}

const LegacyPage = React.lazy(() => import('./LegacyChatPage').then((module) => ({ default: module.LegacyChatPage })));
const NativePage = React.lazy(() =>
    import('./chat/PrivateMessagePilotPage').then((module) => ({ default: module.PrivateMessagePilotPage })),
);
const renderingKeys = new WeakMap<PrivateMessagePilotRuntime, number>();
let nextRenderingKey = 0;
function nativeRenderingKey(runtime: PrivateMessagePilotRuntime): number {
    let key = renderingKeys.get(runtime);
    if (key === undefined) {
        key = ++nextRenderingKey;
        renderingKeys.set(runtime, key);
    }
    return key;
}

function nativeRuntime(value: unknown): value is PrivateMessagePilotRuntime {
    try {
        if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'native-pilot') return false;
        return ['getInbox', 'getThread', 'sendText', 'retryPending', 'getBlockStatus', 'setBlocked', 'subscribe'].every(
            (key) => key in value && typeof Reflect.get(value, key) === 'function',
        );
    } catch {
        return false;
    }
}
function disabledRuntime(value: unknown): boolean {
    try {
        return (
            !!value &&
            typeof value === 'object' &&
            Object.keys(value).length === 1 &&
            'kind' in value &&
            value.kind === 'disabled'
        );
    } catch {
        return false;
    }
}
function selectedPage(
    props: ChatPageProps,
): { kind: 'legacy' } | { kind: 'native-pilot'; runtime: unknown } | { kind: 'native-unavailable' } {
    try {
        if (Object.prototype.hasOwnProperty.call(props, 'selection')) {
            const selected = props.selection;
            if (!selected || typeof selected !== 'object') return { kind: 'native-unavailable' };
            if (selected.kind === 'legacy') return { kind: 'legacy' };
            if (selected.kind === 'native-pilot') return { kind: 'native-pilot', runtime: selected.runtime };
            return { kind: 'native-unavailable' };
        }
        if (
            !Object.prototype.hasOwnProperty.call(props, 'privateMessageRuntime') ||
            disabledRuntime(props.privateMessageRuntime)
        )
            return { kind: 'legacy' };
        return { kind: 'native-pilot', runtime: props.privateMessageRuntime };
    } catch {
        return { kind: 'native-unavailable' };
    }
}

export const NativePrivateMessageUnavailable: React.FC<{ onBack?: () => void }> = ({ onBack }) => (
    <div data-chat-page className="flex h-full flex-col bg-slate-950 text-white p-4">
        {onBack && (
            <button type="button" onClick={onBack} className="min-h-[44px] text-sky-200">
                Back
            </button>
        )}
        <div role="status" className="rounded-xl border border-amber-300/30 bg-amber-500/10 p-3">
            <p className="text-sm font-bold text-amber-200">Encryption test—not reviewed</p>
            <p className="mt-2 text-sm text-white/70">
                The native private message test is unavailable. Sending is blocked.
            </p>
        </div>
    </div>
);

class NativePageBoundary extends React.Component<
    { onBack?: () => void; children: React.ReactNode },
    { failed: boolean }
> {
    state = { failed: false };
    static getDerivedStateFromError() {
        return { failed: true };
    }
    render() {
        return this.state.failed ? <NativePrivateMessageUnavailable onBack={this.props.onBack} /> : this.props.children;
    }
}

export const ChatPage: React.FC<ChatPageProps> = React.memo((props) => {
    const { onBack } = props;
    const selected = selectedPage(props);
    if (selected.kind === 'legacy')
        return (
            <Suspense fallback={<p role="status">Loading chat…</p>}>
                <LegacyPage onBack={onBack} />
            </Suspense>
        );
    if (selected.kind !== 'native-pilot' || !nativeRuntime(selected.runtime))
        return <NativePrivateMessageUnavailable onBack={onBack} />;
    const key = nativeRenderingKey(selected.runtime);
    return (
        <NativePageBoundary key={key} onBack={onBack}>
            <Suspense fallback={<p role="status">Checking the native encryption test…</p>}>
                <NativePage key={key} runtime={selected.runtime} onBack={onBack} />
            </Suspense>
        </NativePageBoundary>
    );
});

export default ChatPage;
