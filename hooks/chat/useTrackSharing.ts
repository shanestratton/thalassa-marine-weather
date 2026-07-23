/**
 * useTrackSharing — Extracted from ChatPage.
 * Manages voyages loading, sharing tracks to chat, and importing community tracks.
 */
import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { ChatService, ChatMessage, type ChatMessageSendResult } from '../../services/ChatService';
import { ShipLogService } from '../../services/ShipLogService';
import { TrackSharingService } from '../../services/TrackSharingService';
import { importGPXToEntries } from '../../services/gpxService';
import { ShipLogEntry } from '../../types';
import { createLogger } from '../../utils/createLogger';
import { TRACK_PREFIX } from '../../components/chat/chatUtils';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import { toast } from '../../components/Toast';

const log = createLogger('useTrackSharing');
const subscribeIdentitySnapshot = (notify: () => void): (() => void) => subscribeAuthIdentityScope(() => notify());
const getIdentitySnapshot = (): AuthIdentityScope => getAuthIdentityScope();

function reconcileOptimisticMessage(
    messages: ChatMessage[],
    optimisticId: string,
    result: ChatMessageSendResult,
): ChatMessage[] {
    const optimisticIndex = messages.findIndex((message) => message.id === optimisticId);
    if (result === 'queued') {
        return optimisticIndex < 0
            ? messages
            : messages.map((message) =>
                  message.id === optimisticId ? { ...message, delivery_status: 'queued' } : message,
              );
    }
    if (!result) return optimisticIndex < 0 ? messages : messages.filter((message) => message.id !== optimisticId);
    if (optimisticIndex < 0) {
        return messages.some((message) => message.id === result.id) ? messages : [...messages, result];
    }
    const next = [...messages];
    next[optimisticIndex] = result;
    return next;
}

export interface VoyageSummary {
    voyageId: string;
    entryCount: number;
    distance: number;
    startTime: string;
    endTime: string;
    entries: ShipLogEntry[];
}

export interface UseTrackSharingOptions {
    activeChannel: { id: string } | null;
    setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
    messageEndRef: React.RefObject<HTMLDivElement | null>;
    setShowAttachMenu: (show: boolean) => void;
}

export function useTrackSharing(options: UseTrackSharingOptions) {
    const { activeChannel, setMessages, messageEndRef, setShowAttachMenu } = options;
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getIdentitySnapshot, getIdentitySnapshot);

    // --- State ---
    const [storedShowTrackPicker, rawSetShowTrackPicker] = useState(false);
    const [storedVoyageList, setVoyageList] = useState<VoyageSummary[]>([]);
    const [storedTrackSharing, setTrackSharing] = useState(false);
    const [storedTrackLoadingVoyages, setTrackLoadingVoyages] = useState(false);

    // Track import
    const [storedImportingTrackId, setImportingTrackId] = useState<string | null>(null);
    const [storedTrackImportStatus, setTrackImportStatus] = useState<string | null>(null);
    const [storedShowTrackDisclaimer, rawSetShowTrackDisclaimer] = useState<{
        trackId: string;
        title: string;
    } | null>(null);

    const stateOwnerRef = useRef(identityScope);
    const mountedRef = useRef(true);
    const pickerRequestRef = useRef(0);
    const shareRequestRef = useRef(0);
    const importRequestRef = useRef(0);
    const shareBusyRef = useRef(false);
    const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const activeChannelIdRef = useRef(activeChannel?.id ?? null);
    activeChannelIdRef.current = activeChannel?.id ?? null;

    const stateBelongsToCurrentIdentity =
        stateOwnerRef.current.key === identityScope.key &&
        stateOwnerRef.current.generation === identityScope.generation &&
        isAuthIdentityScopeCurrent(stateOwnerRef.current);

    // Gate every returned value during the render in which the identity fence
    // moves. Account A is therefore hidden before an effect gets a chance to run.
    const showTrackPicker = stateBelongsToCurrentIdentity ? storedShowTrackPicker : false;
    const voyageList = stateBelongsToCurrentIdentity ? storedVoyageList : [];
    const trackSharing = stateBelongsToCurrentIdentity ? storedTrackSharing : false;
    const trackLoadingVoyages = stateBelongsToCurrentIdentity ? storedTrackLoadingVoyages : false;
    const importingTrackId = stateBelongsToCurrentIdentity ? storedImportingTrackId : null;
    const trackImportStatus = stateBelongsToCurrentIdentity ? storedTrackImportStatus : null;
    const showTrackDisclaimer = stateBelongsToCurrentIdentity ? storedShowTrackDisclaimer : null;

    const setShowTrackPicker = useCallback<React.Dispatch<React.SetStateAction<boolean>>>(
        (value) => {
            if (isAuthIdentityScopeCurrent(identityScope)) rawSetShowTrackPicker(value);
        },
        [identityScope],
    );
    const setShowTrackDisclaimer = useCallback<
        React.Dispatch<React.SetStateAction<{ trackId: string; title: string } | null>>
    >(
        (value) => {
            if (isAuthIdentityScopeCurrent(identityScope)) rawSetShowTrackDisclaimer(value);
        },
        [identityScope],
    );

    useEffect(() => {
        stateOwnerRef.current = identityScope;
        pickerRequestRef.current += 1;
        shareRequestRef.current += 1;
        importRequestRef.current += 1;
        shareBusyRef.current = false;
        if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
        if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
        scrollTimerRef.current = null;
        statusTimerRef.current = null;
        rawSetShowTrackPicker(false);
        setVoyageList([]);
        setTrackSharing(false);
        setTrackLoadingVoyages(false);
        setImportingTrackId(null);
        setTrackImportStatus(null);
        rawSetShowTrackDisclaimer(null);
    }, [identityScope]);

    useEffect(() => {
        shareRequestRef.current += 1;
        shareBusyRef.current = false;
        setTrackSharing(false);
        if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = null;
    }, [activeChannel?.id]);

    useEffect(
        () => () => {
            mountedRef.current = false;
            pickerRequestRef.current += 1;
            shareRequestRef.current += 1;
            importRequestRef.current += 1;
            if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
            if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
        },
        [],
    );

    // --- Actions ---

    const openTrackPicker = useCallback(async () => {
        const scope = identityScope;
        if (!isAuthIdentityScopeCurrent(scope)) return;
        const requestId = ++pickerRequestRef.current;
        const isCurrent = () =>
            mountedRef.current && requestId === pickerRequestRef.current && isAuthIdentityScopeCurrent(scope);
        setShowAttachMenu(false);
        rawSetShowTrackPicker(true);
        setTrackLoadingVoyages(true);
        try {
            const entries = await ShipLogService.getLogEntries(500);
            if (!isCurrent()) return;
            const deviceEntries = entries
                .filter((e: ShipLogEntry) => !e.source || e.source === 'device')
                .map((entry: ShipLogEntry) => ({ ...entry }));
            const grouped = new Map<string, ShipLogEntry[]>();
            for (const e of deviceEntries) {
                if (!e.voyageId) continue;
                const arr = grouped.get(e.voyageId) || [];
                arr.push(e);
                grouped.set(e.voyageId, arr);
            }
            const list = Array.from(grouped.entries())
                .map(([voyageId, entries]) => {
                    const sorted = entries.sort(
                        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
                    );
                    const last = sorted[sorted.length - 1];
                    let dist = last.cumulativeDistanceNM || 0;
                    if (dist === 0) {
                        dist = sorted.reduce((sum, e) => sum + (e.distanceNM || 0), 0);
                    }
                    return {
                        voyageId,
                        entryCount: sorted.length,
                        distance: Math.round(dist * 10) / 10,
                        startTime: sorted[0].timestamp,
                        endTime: last.timestamp,
                        entries: sorted,
                    };
                })
                .filter((v) => v.entryCount >= 2)
                .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
            if (isCurrent()) setVoyageList(list);
        } catch (e) {
            if (isCurrent()) {
                log.warn('Track picker load failed:', e);
                setVoyageList([]);
            }
        } finally {
            if (isCurrent()) setTrackLoadingVoyages(false);
        }
    }, [identityScope, setShowAttachMenu]);

    const sendTrack = useCallback(
        async (voyage: VoyageSummary) => {
            const scope = identityScope;
            const channelId = activeChannel?.id;
            if (
                !channelId ||
                shareBusyRef.current ||
                !isAuthIdentityScopeCurrent(scope) ||
                activeChannelIdRef.current !== channelId
            ) {
                return;
            }
            const voyageSnapshot: VoyageSummary = {
                ...voyage,
                entries: voyage.entries.map((entry) => ({ ...entry })),
            };
            const requestId = ++shareRequestRef.current;
            const isCurrent = () =>
                mountedRef.current &&
                requestId === shareRequestRef.current &&
                activeChannelIdRef.current === channelId &&
                isAuthIdentityScopeCurrent(scope);
            shareBusyRef.current = true;
            setTrackSharing(true);
            try {
                const startDate = new Date(voyageSnapshot.startTime).toLocaleDateString('en-AU', {
                    day: 'numeric',
                    month: 'short',
                });
                const title = `Voyage ${startDate} — ${voyageSnapshot.distance}nm`;

                const shared = await TrackSharingService.shareTrack(voyageSnapshot.entries, {
                    title,
                    description: `${voyageSnapshot.entryCount} waypoints, ${voyageSnapshot.distance}nm`,
                    tags: [],
                    category: 'coastal',
                    region: '',
                });

                if (shared && isCurrent()) {
                    const text = `${TRACK_PREFIX}${shared.id}|${title}`;
                    rawSetShowTrackPicker(false);

                    const optimistic: ChatMessage = {
                        id: `opt-${crypto.randomUUID()}`,
                        channel_id: channelId,
                        user_id: 'self',
                        display_name: 'You',
                        message: text,
                        is_question: false,
                        helpful_count: 0,
                        is_pinned: false,
                        deleted_at: null,
                        created_at: new Date().toISOString(),
                        delivery_status: 'sending',
                    };
                    setMessages((prev) => (isCurrent() ? [...prev, optimistic] : prev));
                    const result = await ChatService.sendMessage(channelId, text, false).catch(() => null);
                    if (!isCurrent()) return;
                    setMessages((prev) =>
                        isCurrent() ? reconcileOptimisticMessage(prev, optimistic.id, result) : prev,
                    );
                    if (!result) {
                        await TrackSharingService.deleteSharedTrack(shared.id).catch(() => false);
                        if (!isCurrent()) return;
                        rawSetShowTrackPicker(true);
                        toast.error("The track couldn't be posted to chat. Please try again.");
                        return;
                    }
                    if (result === 'queued') {
                        toast.info('Track post queued — it will send when the connection returns.');
                    }
                    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
                    scrollTimerRef.current = setTimeout(() => {
                        scrollTimerRef.current = null;
                        if (isCurrent()) messageEndRef.current?.scrollIntoView({ behavior: 'smooth' });
                    }, 50);
                }
            } catch (err) {
                if (isCurrent()) {
                    log.error('Failed to share track:', err);
                    toast.error("The track couldn't be shared. Please try again.");
                }
            } finally {
                if (isCurrent()) {
                    shareBusyRef.current = false;
                    setTrackSharing(false);
                }
            }
        },
        [activeChannel, identityScope, setMessages, messageEndRef],
    );

    const handleImportTrack = useCallback(
        async (trackId: string, title: string) => {
            const scope = identityScope;
            const normalizedTrackId = trackId.trim();
            const titleSnapshot = title;
            if (!normalizedTrackId || !isAuthIdentityScopeCurrent(scope)) return;
            const requestId = ++importRequestRef.current;
            const isCurrent = () =>
                mountedRef.current && requestId === importRequestRef.current && isAuthIdentityScopeCurrent(scope);
            if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
            statusTimerRef.current = null;
            rawSetShowTrackDisclaimer(null);
            setImportingTrackId(normalizedTrackId);
            setTrackImportStatus(null);
            try {
                setTrackImportStatus('⏳ Downloading track…');
                const gpxData = await TrackSharingService.downloadTrack(normalizedTrackId, true);
                if (!isCurrent()) return;
                if (!gpxData) {
                    setTrackImportStatus('❌ Download failed — no data returned');
                    return;
                }
                setTrackImportStatus('⏳ Parsing GPX data…');
                let entries: Partial<ShipLogEntry>[];
                try {
                    entries = importGPXToEntries(gpxData);
                } catch (parseErr) {
                    if (isCurrent()) {
                        log.error('GPX parse failed:', parseErr);
                        setTrackImportStatus('❌ Invalid GPX data — cannot parse');
                    }
                    return;
                }
                if (!isCurrent()) return;
                if (entries.length === 0) {
                    setTrackImportStatus('❌ No valid entries in track');
                    return;
                }
                const communityEntries = entries.map((entry) => ({
                    ...entry,
                    source: 'community_download' as const,
                }));
                setTrackImportStatus(`⏳ Saving ${communityEntries.length} entries…`);
                const { savedCount } = await ShipLogService.importGPXVoyage(communityEntries);
                if (isCurrent()) {
                    setTrackImportStatus(`✅ Imported "${titleSnapshot}" — ${savedCount} entries`);
                }
            } catch (err) {
                if (isCurrent()) {
                    log.error('Track import failed:', err);
                    const msg = err instanceof Error ? err.message : 'Unknown error';
                    setTrackImportStatus(`❌ Import failed — ${msg}`);
                }
            } finally {
                if (isCurrent()) {
                    setImportingTrackId(null);
                    statusTimerRef.current = setTimeout(() => {
                        statusTimerRef.current = null;
                        if (isCurrent()) setTrackImportStatus(null);
                    }, 5000);
                }
            }
        },
        [identityScope],
    );

    return {
        // State
        showTrackPicker,
        setShowTrackPicker,
        voyageList,
        trackSharing,
        trackLoadingVoyages,
        importingTrackId,
        trackImportStatus,
        showTrackDisclaimer,
        setShowTrackDisclaimer,

        // Actions
        openTrackPicker,
        sendTrack,
        handleImportTrack,
    };
}
