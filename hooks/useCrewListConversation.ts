/**
 * useCrewListConversation
 *
 * State and refresh behaviour for the isolated Crew List conversation lane.
 * It intentionally calls only the consent-gated Crew List service methods —
 * never the app-wide direct-message service.  Every asynchronous result is
 * fenced to the active authenticated identity, so an account change cannot
 * render one sailor's private messages for another.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from '../components/Toast';
import { createLogger } from '../utils/createLogger';
import { LonelyHeartsService, type CrewIntroMessage } from '../services/LonelyHeartsService';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../services/authIdentityScope';

const log = createLogger('CrewListConversation');
const REFRESH_INTERVAL_MS = 15_000;

function subscribeIdentitySnapshot(onStoreChange: () => void): () => void {
    return subscribeAuthIdentityScope(() => onStoreChange());
}

function normalizeIntroductionId(value: string | null): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
}

function loadKey(scope: ReturnType<typeof getAuthIdentityScope>, requestId: string | null): string | null {
    return requestId ? `${scope.generation}:${scope.key}:${requestId}` : null;
}

function mergeMessage(messages: CrewIntroMessage[], sent: CrewIntroMessage): CrewIntroMessage[] {
    if (messages.some((message) => message.id === sent.id)) return messages;
    return [...messages, sent].sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export function useCrewListConversation(introRequestId: string | null) {
    // Subscribe so a sign-out or account change immediately clears private UI
    // rather than waiting for a network request to settle.
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getAuthIdentityScope, getAuthIdentityScope);

    const [messages, setMessages] = useState<CrewIntroMessage[]>([]);
    const [draft, setDraft] = useState('');
    const [loading, setLoading] = useState(false);
    const [sending, setSending] = useState(false);
    const [unavailable, setUnavailable] = useState(false);
    const [loadedFor, setLoadedFor] = useState<string | null>(null);
    const operationVersion = useRef(0);
    const previousIntroductionId = useRef<string | null>(null);
    const previousIdentityGeneration = useRef(identityScope.generation);

    const load = useCallback(async () => {
        const scope = getAuthIdentityScope();
        const requestId = normalizeIntroductionId(introRequestId);
        const version = ++operationVersion.current;
        const target = loadKey(scope, requestId);

        if (!scope.userId || !requestId) {
            if (version === operationVersion.current) {
                setMessages([]);
                setUnavailable(false);
                setLoadedFor(target);
                setLoading(false);
            }
            return;
        }

        setLoading(true);
        try {
            // Resolve the accepted, server-created conversation first. An
            // empty message list is a valid brand-new chat; a missing
            // conversation is not and must not leave a composer active.
            const conversation = await LonelyHeartsService.getCrewIntroConversation(requestId);
            if (version !== operationVersion.current || !isAuthIdentityScopeCurrent(scope)) return;

            if (!conversation) {
                setMessages([]);
                setUnavailable(true);
                setLoadedFor(target);
                setLoading(false);
                return;
            }

            const nextMessages = await LonelyHeartsService.getCrewIntroMessages(requestId, 200);
            if (version !== operationVersion.current || !isAuthIdentityScopeCurrent(scope)) return;

            setMessages(nextMessages);
            setUnavailable(false);
            setLoadedFor(target);
        } catch (error) {
            if (version !== operationVersion.current || !isAuthIdentityScopeCurrent(scope)) return;
            log.warn('Crew List conversation refresh failed:', error);
            // Do not imply an accepted connection has vanished because of a
            // transient fetch failure. Preserve any messages already rendered.
        } finally {
            if (version === operationVersion.current && isAuthIdentityScopeCurrent(scope)) setLoading(false);
        }
    }, [introRequestId]);

    useEffect(() => {
        if (previousIdentityGeneration.current === identityScope.generation) return;
        previousIdentityGeneration.current = identityScope.generation;
        // This is an identity boundary, not a normal navigation update. Clear
        // every potentially private bit of UI before the new identity's fetch
        // can complete, including an unsent composer draft.
        operationVersion.current += 1;
        setMessages([]);
        setDraft('');
        setSending(false);
        setUnavailable(false);
        setLoadedFor(null);
    }, [identityScope.generation, identityScope.key]);

    useEffect(() => {
        const requestId = normalizeIntroductionId(introRequestId);
        if (previousIntroductionId.current !== requestId) {
            previousIntroductionId.current = requestId;
            setDraft('');
        }

        void load();
        if (!requestId || typeof document === 'undefined') return undefined;

        const refreshWhenVisible = () => {
            if (document.visibilityState === 'visible') void load();
        };
        const intervalId = window.setInterval(() => {
            if (document.visibilityState === 'visible') void load();
        }, REFRESH_INTERVAL_MS);
        document.addEventListener('visibilitychange', refreshWhenVisible);

        return () => {
            window.clearInterval(intervalId);
            document.removeEventListener('visibilitychange', refreshWhenVisible);
        };
    }, [identityScope.generation, introRequestId, load]);

    const send = useCallback(async () => {
        const scope = getAuthIdentityScope();
        const requestId = normalizeIntroductionId(introRequestId);
        const message = draft.trim();
        const target = loadKey(scope, requestId);
        if (!scope.userId || !requestId || !message || sending || unavailable || loadedFor !== target) return;

        // Invalidate an in-flight polling request before appending a sent
        // message, so an older fetch can never erase the local confirmation.
        const version = ++operationVersion.current;
        setSending(true);
        try {
            const sent = await LonelyHeartsService.sendCrewIntroMessage(requestId, message);
            if (version !== operationVersion.current || !isAuthIdentityScopeCurrent(scope)) return;

            if (!sent) {
                toast.error('That message could not be sent. The introduction may have been paused or blocked.');
                return;
            }

            setMessages((current) => mergeMessage(current, sent));
            setDraft('');
            setLoadedFor(target);
        } catch (error) {
            if (version !== operationVersion.current || !isAuthIdentityScopeCurrent(scope)) return;
            log.warn('Crew List message send failed:', error);
            toast.error('That message could not be sent. Please try again.');
        } finally {
            if (version === operationVersion.current && isAuthIdentityScopeCurrent(scope)) setSending(false);
        }
    }, [draft, introRequestId, loadedFor, sending, unavailable]);

    const activeRequestId = normalizeIntroductionId(introRequestId);
    const expectedLoadedFor = loadKey(identityScope, activeRequestId);
    const showingCurrentConversation = loadedFor === expectedLoadedFor;

    return {
        // Do not permit one render of a prior account's or prior introduction's
        // content while React schedules the effect that clears its state.
        messages: showingCurrentConversation ? messages : [],
        draft: showingCurrentConversation ? draft : '',
        loading: Boolean(activeRequestId && identityScope.userId && (!showingCurrentConversation || loading)),
        sending: showingCurrentConversation && sending,
        unavailable: showingCurrentConversation && unavailable,
        setDraft,
        send,
        refresh: load,
    };
}
