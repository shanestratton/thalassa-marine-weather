import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePrivateMessagePilotDMs } from '../../hooks/chat/usePrivateMessagePilotDMs';
import { useKeyboardOffset } from '../../hooks/useKeyboardOffset';
import type { PrivateMessagePilotRuntime } from '../../services/chat/e2ee/privateMessagePilot';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';
import {
    PrivateMessagePilotCompose,
    PrivateMessagePilotInbox,
    PrivateMessagePilotNotice,
    PrivateMessagePilotThread,
} from './PrivateMessagePilotView';

const ignoreDirection = () => undefined;
export const PrivateMessagePilotPage: React.FC<{ runtime: PrivateMessagePilotRuntime; onBack?: () => void }> = ({
    runtime,
    onBack,
}) => {
    const [view, setView] = useState('dm_inbox');
    const [loading, setLoading] = useState(false);
    const [closed, setClosed] = useState(
        () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    );
    const [failed, setFailed] = useState(false);
    const viewRevision = useRef(0);
    const alive = useRef(true);
    const dm = usePrivateMessagePilotDMs({
        setView,
        setNavDirection: ignoreDirection,
        setLoading,
        privateMessageRuntime: runtime,
    });
    const keyboardOffset = useKeyboardOffset(!closed && !failed && view === 'dm_thread');
    const {
        subscribe,
        openDMInbox,
        currentUserId,
        identityGeneration,
        closePrivateMessageView,
        getPrivateMessageViewRevision,
    } = dm;
    const renderedScope = useRef({ runtime, currentUserId, identityGeneration });
    useLayoutEffect(() => {
        const previous = renderedScope.current;
        if (
            previous.runtime !== runtime ||
            previous.currentUserId !== currentUserId ||
            previous.identityGeneration !== identityGeneration
        )
            viewRevision.current += 1;
        renderedScope.current = { runtime, currentUserId, identityGeneration };
    }, [runtime, currentUserId, identityGeneration]);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            viewRevision.current += 1;
        };
    }, []);
    const safeAction = useCallback(
        (action: () => Promise<unknown> | void) => {
            const ticket = viewRevision.current;
            let nativeViewTicket = getPrivateMessageViewRevision();
            const scope = getAuthIdentityScope();
            const refuse = () => {
                if (
                    !alive.current ||
                    ticket !== viewRevision.current ||
                    nativeViewTicket !== getPrivateMessageViewRevision() ||
                    !isAuthIdentityScopeCurrent(scope)
                )
                    return;
                closePrivateMessageView();
                setFailed(true);
            };
            try {
                const pending = action();
                nativeViewTicket = getPrivateMessageViewRevision();
                void Promise.resolve(pending).catch(refuse);
            } catch {
                refuse();
            }
        },
        [closePrivateMessageView, getPrivateMessageViewRevision],
    );

    useEffect(() => {
        if (closed || failed) return;
        const ticket = viewRevision.current;
        let nativeViewTicket = getPrivateMessageViewRevision();
        let stop: (() => void) | undefined;
        try {
            safeAction(openDMInbox);
            nativeViewTicket = getPrivateMessageViewRevision();
            stop = subscribe();
        } catch {
            if (
                alive.current &&
                ticket === viewRevision.current &&
                nativeViewTicket === getPrivateMessageViewRevision()
            ) {
                closePrivateMessageView();
                setFailed(true);
            }
        }
        return () => {
            try {
                stop?.();
            } catch {
                /* Rendering stays fenced. */
            }
        };
    }, [
        subscribe,
        openDMInbox,
        currentUserId,
        identityGeneration,
        closed,
        failed,
        safeAction,
        closePrivateMessageView,
        getPrivateMessageViewRevision,
    ]);

    useEffect(() => {
        const close = () => {
            // Local presentation privacy only. Native Auth, keys and durable
            // pending records are untouched; reopening is an explicit read.
            viewRevision.current += 1;
            closePrivateMessageView();
            setClosed(true);
        };
        const visibility = () => {
            if (document.visibilityState === 'hidden') close();
        };
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('pagehide', close);
        return () => {
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('pagehide', close);
        };
    }, [closePrivateMessageView]);

    if (closed || failed)
        return (
            <div data-chat-page className="flex h-full flex-col bg-slate-950 text-white">
                {onBack && (
                    <button type="button" onClick={onBack} className="mx-4 min-h-[44px] text-sky-200">
                        Back
                    </button>
                )}
                <PrivateMessagePilotNotice
                    statusText={
                        closed
                            ? 'Private message view closed. Recheck native availability to reopen.'
                            : 'The native private message test is unavailable. Sending is blocked.'
                    }
                />
                <button
                    type="button"
                    className="mx-4 min-h-[44px] text-sky-200"
                    onClick={() => {
                        if (document.visibilityState === 'hidden') return;
                        viewRevision.current += 1;
                        setView('dm_inbox');
                        setFailed(false);
                        setClosed(false);
                    }}
                >
                    Retry native availability
                </button>
            </div>
        );

    return (
        <div data-chat-page className="flex min-h-0 flex-col h-full bg-slate-950 text-white overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/10">
                <button
                    type="button"
                    className="min-h-[44px] text-sky-200"
                    onClick={() => {
                        if (view === 'dm_thread') {
                            dm.setDmPartner(null);
                            safeAction(openDMInbox);
                        } else onBack?.();
                    }}
                >
                    Back
                </button>
                <p className="text-base font-bold">
                    {view === 'dm_thread' ? dm.dmPartner?.name : 'Private message test'}
                </p>
                <span />
            </div>
            <PrivateMessagePilotNotice statusText={dm.pilotStatusText} />
            <div className="flex-1 min-h-0 overflow-y-auto">
                {loading ? (
                    <p className="px-4 py-3" role="status">
                        Checking the native encryption test…
                    </p>
                ) : view === 'dm_thread' ? (
                    <PrivateMessagePilotThread thread={dm.dmThread} partnerName={dm.dmPartner?.name} />
                ) : (
                    <>
                        <PrivateMessagePilotInbox
                            conversations={dm.dmConversations}
                            onOpenThread={(id, name) => safeAction(() => dm.openDMThread(id, name))}
                        />
                        {dm.pilotStatusText && (
                            <button
                                type="button"
                                onClick={() => safeAction(openDMInbox)}
                                className="mx-4 min-h-[44px] text-sky-200"
                            >
                                Retry native availability
                            </button>
                        )}
                    </>
                )}
            </div>
            {view === 'dm_thread' && (
                <>
                    {dm.pilotUnresolvedCount > 0 && !loading && (
                        <p className="mx-4 text-sm text-white/60" role="status">
                            {dm.pilotUnresolvedCount} native message records are unavailable.
                        </p>
                    )}
                    {dm.pilotPendingAttemptId && !loading && (
                        <button
                            type="button"
                            onClick={() => safeAction(dm.retryPilotPendingMessage)}
                            disabled={dm.pilotRetryDisabled}
                            className="mx-4 min-h-[44px] text-sky-200 disabled:text-white/40"
                        >
                            Retry pending message
                        </button>
                    )}
                    {!loading && (
                        <button
                            type="button"
                            onClick={() => safeAction(dm.refreshNativeMessages)}
                            disabled={dm.blockStatusLoading}
                            className="mx-4 min-h-[44px] text-sky-200"
                        >
                            Refresh native messages
                        </button>
                    )}
                    {dm.pilotStatusText && !loading && (
                        <button
                            type="button"
                            onClick={() => safeAction(dm.retryBlockStatus)}
                            className="mx-4 min-h-[44px] text-sky-200"
                        >
                            Retry native permissions
                        </button>
                    )}
                    <PrivateMessagePilotCompose
                        dmText={dm.dmText}
                        setDmText={dm.setDmText}
                        partnerName={dm.dmPartner?.name}
                        keyboardOffset={keyboardOffset}
                        isUserBlocked={dm.isUserBlocked}
                        blockStatusLoading={dm.blockStatusLoading}
                        blockStatusError={dm.blockStatusError}
                        onRetryBlockStatus={() => safeAction(dm.retryBlockStatus)}
                        onSendDM={() => safeAction(dm.sendDMMessage)}
                        pilotSendDisabled={dm.pilotSendDisabled}
                    />
                </>
            )}
        </div>
    );
};

export default PrivateMessagePilotPage;
