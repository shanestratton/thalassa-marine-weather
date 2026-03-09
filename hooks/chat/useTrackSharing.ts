/**
 * useTrackSharing — Extracted from ChatPage.
 * Manages voyages loading, sharing tracks to chat, and importing community tracks.
 */
import { useState, useCallback } from 'react';
import { ChatService, ChatMessage } from '../../services/ChatService';
import { ShipLogService } from '../../services/ShipLogService';
import { TrackSharingService } from '../../services/TrackSharingService';
import { importGPXToEntries } from '../../services/gpxService';
import { ShipLogEntry } from '../../types';
import { createLogger } from '../../utils/createLogger';
import { TRACK_PREFIX } from '../../components/chat/chatUtils';

const log = createLogger('useTrackSharing');

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

    // --- State ---
    const [showTrackPicker, setShowTrackPicker] = useState(false);
    const [voyageList, setVoyageList] = useState<VoyageSummary[]>([]);
    const [trackSharing, setTrackSharing] = useState(false);
    const [trackLoadingVoyages, setTrackLoadingVoyages] = useState(false);

    // Track import
    const [importingTrackId, setImportingTrackId] = useState<string | null>(null);
    const [trackImportStatus, setTrackImportStatus] = useState<string | null>(null);
    const [showTrackDisclaimer, setShowTrackDisclaimer] = useState<{ trackId: string; title: string } | null>(null);

    // --- Actions ---

    const openTrackPicker = useCallback(async () => {
        setShowAttachMenu(false);
        setShowTrackPicker(true);
        setTrackLoadingVoyages(true);
        try {
            const entries = await ShipLogService.getLogEntries(500);
            const deviceEntries = entries.filter((e: ShipLogEntry) => !e.source || e.source === 'device');
            const grouped = new Map<string, ShipLogEntry[]>();
            for (const e of deviceEntries) {
                if (!e.voyageId) continue;
                const arr = grouped.get(e.voyageId) || [];
                arr.push(e);
                grouped.set(e.voyageId, arr);
            }
            const list = Array.from(grouped.entries())
                .map(([voyageId, entries]) => {
                    const sorted = entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
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
                .filter(v => v.entryCount >= 2)
                .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
            setVoyageList(list);
        } catch (e) {
            log.warn('Track picker load failed:', e);
            setVoyageList([]);
        } finally {
            setTrackLoadingVoyages(false);
        }
    }, [setShowAttachMenu]);

    const sendTrack = useCallback(async (voyage: VoyageSummary) => {
        if (!activeChannel || trackSharing) return;
        setTrackSharing(true);
        try {
            const startDate = new Date(voyage.startTime).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
            const title = `Voyage ${startDate} — ${voyage.distance}nm`;

            const shared = await TrackSharingService.shareTrack(voyage.entries, {
                title,
                description: `${voyage.entryCount} waypoints, ${voyage.distance}nm`,
                tags: [],
                category: 'coastal',
                region: '',
            });

            if (shared) {
                const text = `${TRACK_PREFIX}${shared.id}|${title}`;
                setShowTrackPicker(false);

                const optimistic: ChatMessage = {
                    id: `opt-${crypto.randomUUID()}`,
                    channel_id: activeChannel.id,
                    user_id: 'self',
                    display_name: 'You',
                    message: text,
                    is_question: false,
                    helpful_count: 0,
                    is_pinned: false,
                    deleted_at: null,
                    created_at: new Date().toISOString(),
                };
                setMessages(prev => [...prev, optimistic]);
                await ChatService.sendMessage(activeChannel.id, text, false);
                setTimeout(() => messageEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
            }
        } catch (err) {
            log.error('Failed to share track:', err);
        } finally {
            setTrackSharing(false);
        }
    }, [activeChannel, trackSharing, setMessages, messageEndRef]);

    const handleImportTrack = useCallback(async (trackId: string, title: string) => {
        setShowTrackDisclaimer(null);
        setImportingTrackId(trackId);
        setTrackImportStatus(null);
        try {
            setTrackImportStatus('⏳ Downloading track…');
            const gpxData = await TrackSharingService.downloadTrack(trackId, true);
            if (!gpxData) {
                setTrackImportStatus('❌ Download failed — no data returned');
                return;
            }
            setTrackImportStatus('⏳ Parsing GPX data…');
            let entries;
            try {
                entries = importGPXToEntries(gpxData);
            } catch (parseErr) {
                log.error('GPX parse failed:', parseErr);
                setTrackImportStatus('❌ Invalid GPX data — cannot parse');
                return;
            }
            if (entries.length === 0) {
                setTrackImportStatus('❌ No valid entries in track');
                return;
            }
            entries.forEach((e: Record<string, unknown>) => { e.source = 'community_download'; });
            setTrackImportStatus(`⏳ Saving ${entries.length} entries…`);
            const { savedCount } = await ShipLogService.importGPXVoyage(entries);
            setTrackImportStatus(`✅ Imported "${title}" — ${savedCount} entries`);
        } catch (err) {
            log.error('Track import failed:', err);
            const msg = err instanceof Error ? err.message : 'Unknown error';
            setTrackImportStatus(`❌ Import failed — ${msg}`);
        } finally {
            setImportingTrackId(null);
            setTimeout(() => setTrackImportStatus(null), 5000);
        }
    }, []);

    return {
        // State
        showTrackPicker, setShowTrackPicker,
        voyageList,
        trackSharing,
        trackLoadingVoyages,
        importingTrackId,
        trackImportStatus,
        showTrackDisclaimer, setShowTrackDisclaimer,

        // Actions
        openTrackPicker,
        sendTrack,
        handleImportTrack,
    };
}
