/**
 * ChatPage — "Crew Talk"
 * Best-in-class community chat with channels, PMs, and anti-toxicity design.
 * 
 * Premium features:
 * - Dynamic user-seeded color avatars
 * - Animated message entrance
 * - Glassmorphism panels
 * - Question prominence with glow
 * - Crew rank badges with progression
 * - Smooth view transitions
 * - Mod action menus
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('ChatPage');
import { ChatService, ChatChannel, ChatMessage, DirectMessage, DMConversation, DEFAULT_CHANNELS } from '../services/ChatService';
import { clientFilter, reportMessage, type ClientFilterResult } from '../services/ContentModerationService';
import { uploadProfilePhoto, batchFetchAvatars, getCachedAvatar, removeProfilePhoto, getProfile, updateProfile } from '../services/ProfilePhotoService';
import { LonelyHeartsPage } from './LonelyHeartsPage';

import { BgGeoManager } from '../services/BgGeoManager';
import { PinService, SavedPin } from '../services/PinService';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { toast } from './Toast';
import { ShipLogService } from '../services/ShipLogService';
import { TrackSharingService } from '../services/TrackSharingService';
import { ShipLogEntry } from '../types';
import { importGPXToEntries } from '../services/gpxService';
import { useSettings } from '../context/SettingsContext';
import { moderateMessage } from '../services/ContentModerationService';
import { GpsService } from '../services/GpsService';
import { t } from '../theme';
import { MarketplacePage } from './MarketplacePage';
import { AdminPanel } from './AdminPanel';
import { ChannelList } from './chat/ChannelList';
import { ChatMessageList } from './chat/ChatMessageList';
import { ChatComposer } from './chat/ChatComposer';
import { ChatProfileView } from './chat/ChatProfileView';
import { ChatHeader } from './chat/ChatHeader';
import { ChatDMInbox, ChatDMThread, ChatDMCompose } from './chat/ChatDMView';
import { ReportModal, PinDropSheet, PoiPickerSheet, TrackPickerSheet, TrackDisclaimerModal } from './chat/ChatAttachmentSheets';
import { SkeletonChannelList, SkeletonMessageList } from './ui/Skeleton';
import { ChatErrorBoundary } from './chat/ChatErrorBoundary';
import { triggerHaptic } from '../utils/system';
import { TypingIndicator } from './chat/TypingIndicator';
import { usePullToRefresh } from '../hooks/usePullToRefresh';

import {
    getAvatarGradient, timeAgo, getCrewRank, getStaticMapUrl,
    parsePinMessage, parseTrackMessage, CREW_RANKS,
    PIN_PREFIX, TRACK_PREFIX,
} from './chat/chatUtils';

// --- TYPES ---
type ChatView = 'channels' | 'messages' | 'dm_inbox' | 'dm_thread' | 'profile' | 'find_crew' | 'marketplace' | 'admin_panel';

// --- CSS KEYFRAMES (injected once) ---
const STYLE_ID = 'crew-talk-animations';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        @keyframes msgSlideIn {
            from { opacity: 0; transform: translateY(12px) scale(0.97); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes pulseGlow {
            0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
            50% { box-shadow: 0 0 20px 4px rgba(245, 158, 11, 0.15); }
        }
        @keyframes fadeSlideDown {
            from { opacity: 0; transform: translateY(-8px); }
            to { opacity: 1; transform: translateY(0); }
        }
        @keyframes shimmer {
            0% { background-position: -200% 0; }
            100% { background-position: 200% 0; }
        }
        .msg-enter { animation: msgSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) both; }
        .question-glow { animation: pulseGlow 3s ease-in-out infinite; }
        .fade-slide-down { animation: fadeSlideDown 0.25s ease-out both; }
    `;
    document.head.appendChild(style);
}

// --- MAIN COMPONENT ---
export const ChatPage: React.FC = () => {
    const { settings } = useSettings();

    // View state
    const [view, setView] = useState<ChatView>('channels');
    const [navDirection, setNavDirection] = useState<'forward' | 'back'>('forward');
    const [channels, setChannels] = useState<ChatChannel[]>([]);
    const [activeChannel, setActiveChannel] = useState<ChatChannel | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [dmConversations, setDmConversations] = useState<DMConversation[]>([]);
    const [dmThread, setDmThread] = useState<DirectMessage[]>([]);
    const [dmPartner, setDmPartner] = useState<{ id: string; name: string } | null>(null);
    const [isUserBlocked, setIsUserBlocked] = useState(false);
    const [showBlockConfirm, setShowBlockConfirm] = useState(false);
    const [unreadDMs, setUnreadDMs] = useState(0);

    // Compose
    const [messageText, setMessageText] = useState('');
    const [isQuestion, setIsQuestion] = useState(false);
    const [dmText, setDmText] = useState('');

    // Mod
    const [showModMenu, setShowModMenu] = useState<string | null>(null);
    const [isFirstVisit, setIsFirstVisit] = useState(true);
    const [showRankTooltip, setShowRankTooltip] = useState<string | null>(null);

    // Moderation
    const [filterWarning, setFilterWarning] = useState<ClientFilterResult | null>(null);
    const [reportingMsg, setReportingMsg] = useState<ChatMessage | null>(null);
    const [reportReason, setReportReason] = useState<'spam' | 'harassment' | 'hate_speech' | 'inappropriate' | 'other'>('inappropriate');
    const [reportSent, setReportSent] = useState(false);
    const [showProposalForm, setShowProposalForm] = useState(false);
    const [proposalName, setProposalName] = useState('');
    const [proposalDesc, setProposalDesc] = useState('');
    const [proposalIcon, setProposalIcon] = useState('🏝️');
    const [proposalSent, setProposalSent] = useState(false);
    const [proposalIsPrivate, setProposalIsPrivate] = useState(false);
    const [proposalParentId, setProposalParentId] = useState<string | null>(null);

    // Private channel state
    const [memberChannelIds, setMemberChannelIds] = useState<Set<string>>(new Set());
    const [joinRequestChannel, setJoinRequestChannel] = useState<ChatChannel | null>(null);
    const [joinRequestMessage, setJoinRequestMessage] = useState('');
    const [joinRequestSent, setJoinRequestSent] = useState(false);

    // Loading
    const [loading, setLoading] = useState(true);
    const [loadingStatus, setLoadingStatus] = useState('Connecting to Crew Talk…');

    // Helpful button per-user guard (persisted across sessions)
    const [likedMessages, setLikedMessages] = useState<Set<string>>(() => {
        try {
            const stored = localStorage.getItem('chat_liked_messages');
            return stored ? new Set(JSON.parse(stored)) : new Set();
        } catch (e) { log.warn('localStorage parse:', e); return new Set(); }
    });

    // Keyboard offset — shrinks chat container height so compose stays visible above iOS keyboard
    const [keyboardOffset, setKeyboardOffset] = useState(0);
    const [showTyping, setShowTyping] = useState(false);

    // Pull-to-refresh — actual message reload
    const pullRefresh = usePullToRefresh(async () => {
        if (activeChannel && view === 'messages') {
            triggerHaptic('medium');
            const fresh = await ChatService.getMessages(activeChannel.id);
            setMessages(fresh);
        }
    });

    // Typing indicator — show briefly after channel switch to add ambient life
    useEffect(() => {
        if (!activeChannel || view !== 'messages') return;
        setShowTyping(true);
        const timer = setTimeout(() => setShowTyping(false), 2500);
        return () => clearTimeout(timer);
    }, [activeChannel?.id]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        // Only track keyboard when compose bar is visible
        if (view !== 'messages' && view !== 'dm_thread') {
            setKeyboardOffset(0);
            return;
        }

        let kbShowHandle: any;
        let kbHideHandle: any;
        let usingNativePlugin = false;

        // Try Capacitor Keyboard plugin first (accurate on native iOS)
        import('@capacitor/keyboard').then(({ Keyboard }) => {
            usingNativePlugin = true;
            kbShowHandle = Keyboard.addListener('keyboardWillShow', (info) => {
                setKeyboardOffset(info.keyboardHeight > 0 ? info.keyboardHeight : 0);
            });
            kbHideHandle = Keyboard.addListener('keyboardWillHide', () => {
                setKeyboardOffset(0);
            });
        }).catch(() => {
            // Fallback to visualViewport for web (Capacitor plugin not available)
            const vv = window.visualViewport;
            if (!vv) return;
            const handleResize = () => {
                const offset = window.innerHeight - vv.height - vv.offsetTop;
                setKeyboardOffset(offset > 50 ? offset : 0);
            };
            vv.addEventListener('resize', handleResize);
            vv.addEventListener('scroll', handleResize);
            handleResize();
            // Store cleanup refs on window for the teardown below
            (window as any).__chatKbCleanup = () => {
                vv.removeEventListener('resize', handleResize);
                vv.removeEventListener('scroll', handleResize);
            };
        });

        return () => {
            if (usingNativePlugin) {
                kbShowHandle?.then?.((h: any) => h.remove());
                kbHideHandle?.then?.((h: any) => h.remove());
                // Also handle if they resolved synchronously
                if (kbShowHandle?.remove) kbShowHandle.remove();
                if (kbHideHandle?.remove) kbHideHandle.remove();
            }
            (window as any).__chatKbCleanup?.();
            delete (window as any).__chatKbCleanup;
        };
    }, [view]);

    // Profile Photos
    const [avatarMap, setAvatarMap] = useState<Map<string, string>>(new Map());
    const [myAvatarUrl, setMyAvatarUrl] = useState<string | null>(null);
    const [showPhotoUpload, setShowPhotoUpload] = useState(false);
    const [uploadProgress, setUploadProgress] = useState<string | null>(null);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [profileDisplayName, setProfileDisplayName] = useState('');
    const [profileVesselName, setProfileVesselName] = useState('');
    const [profileLoaded, setProfileLoaded] = useState(false);
    const [profileSaving, setProfileSaving] = useState(false);
    const [profileSaved, setProfileSaved] = useState(false);
    const [profileLookingForLove, setProfileLookingForLove] = useState(false);

    // Pin drop / Track share / POI
    const [showAttachMenu, setShowAttachMenu] = useState(false);
    const [showPinSheet, setShowPinSheet] = useState(false);
    const [showPoiSheet, setShowPoiSheet] = useState(false);
    const [pinLat, setPinLat] = useState(0);
    const [pinLng, setPinLng] = useState(0);
    const [pinCaption, setPinCaption] = useState('');
    const [pinLoading, setPinLoading] = useState(false);
    const [savedPins, setSavedPins] = useState<SavedPin[]>([]);

    // Track sharing
    const [showTrackPicker, setShowTrackPicker] = useState(false);
    const [voyageList, setVoyageList] = useState<{ voyageId: string; entryCount: number; distance: number; startTime: string; endTime: string; entries: ShipLogEntry[] }[]>([]);
    const [trackSharing, setTrackSharing] = useState(false);
    const [trackLoadingVoyages, setTrackLoadingVoyages] = useState(false);

    // Track import from chat
    const [importingTrackId, setImportingTrackId] = useState<string | null>(null);
    const [trackImportStatus, setTrackImportStatus] = useState<string | null>(null);
    const [showTrackDisclaimer, setShowTrackDisclaimer] = useState<{ trackId: string; title: string } | null>(null);

    // Refs
    const messageEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const poiMapRef = useRef<HTMLDivElement>(null);
    const poiMapInstance = useRef<any>(null);
    const poiMarkerRef = useRef<any>(null);
    const poiMapInitialized = useRef(false);

    // --- INIT ---
    useEffect(() => {
        // FAST PATH: Show channels immediately (from cache or defaults)
        // Don't wait for auth — channels are public data
        loadChannels().then((chs) => {
            // ── Auto-restore channel if returning from pin-view map ──
            const returnChannelId = sessionStorage.getItem('chat_return_to_channel');
            if (returnChannelId) {
                sessionStorage.removeItem('chat_return_to_channel');
                const ch = chs.find(c => c.id === returnChannelId);
                if (ch) {
                    // Re-open the channel the user was viewing before the pin tap
                    openChannel(ch);
                }
            }

            // Auth + profile load in background — non-blocking
            ChatService.initialize().then(async () => {
                loadUnreadCount();
                // Refresh channels from network (might have new ones)
                const fresh = await ChatService.getChannels();
                if (fresh.length > 0) setChannels(fresh);

                // Load chat profile
                ChatService.getCurrentUser().then(async (user) => {
                    if (user) {
                        const profile = await getProfile(user.id);
                        if (profile) {
                            setProfileDisplayName(profile.display_name || '');
                            setProfileVesselName(profile.vessel_name || settings.vessel?.name || '');
                            setProfileLookingForLove(profile.looking_for_love || false);
                            if (profile.avatar_url) setMyAvatarUrl(profile.avatar_url);
                        } else {
                            setProfileVesselName(settings.vessel?.name || '');
                        }
                        setProfileLoaded(true);
                    }
                });
            });
        });

        const visited = localStorage.getItem('crew_talk_visited');
        if (visited) setIsFirstVisit(false);

        const unsub = ChatService.subscribeToDMs((dm) => {
            setUnreadDMs(prev => prev + 1);
            setDmThread(prev => {
                if (dmPartner && dm.sender_id === dmPartner.id) {
                    return [...prev, dm];
                }
                return prev;
            });
        });

        return () => {
            unsub();
            ChatService.destroy();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const loadChannels = async (): Promise<ChatChannel[]> => {
        // getChannels returns cached data instantly (or fetches if no cache)
        const chs = await ChatService.getChannels();
        const result = chs.length > 0 ? chs : DEFAULT_CHANNELS.map((c, i) => ({
            ...c,
            id: `default-${i}`,
            created_at: new Date().toISOString(),
        }));
        setChannels(result);
        setLoading(false); // Channels visible — kill spinner immediately
        return result;
    };

    const loadUnreadCount = async () => {
        const count = await ChatService.getUnreadDMCount();
        setUnreadDMs(count);
    };

    // --- CHANNEL ACTIONS ---
    const openChannel = async (channel: ChatChannel) => {
        // Find Crew gets the crew board page
        if (channel.name === 'Find Crew') {
            setNavDirection('forward');
            setView('find_crew');
            return;
        }
        // Marketplace gets the gear exchange page
        if (channel.name === 'Marketplace') {
            setNavDirection('forward');
            setView('marketplace');
            return;
        }
        setActiveChannel(channel);
        setNavDirection('forward');
        setView('messages');
        // Persist last channel for tab-switch recovery
        localStorage.setItem('chat_last_channel', channel.id);
        setLoading(true);
        const msgs = await ChatService.getMessages(channel.id);
        setMessages(msgs);

        // Batch-fetch avatars for all message authors
        const userIds = [...new Set(msgs.map(m => m.user_id).filter(id => id !== 'self'))];
        if (userIds.length > 0) {
            batchFetchAvatars(userIds).then(map => {
                setAvatarMap(prev => {
                    const next = new Map(prev);
                    map.forEach((url, id) => next.set(id, url));
                    return next;
                });
            });
        }

        setLoading(false);

        ChatService.subscribeToChannel(channel.id, (newMsg) => {
            setMessages(prev => {
                // Check if this is our own message arriving from realtime — replace optimistic
                const optimisticIdx = prev.findIndex(
                    m => m.id.startsWith('opt-') && m.user_id === 'self' && m.message === newMsg.message
                );
                if (optimisticIdx >= 0) {
                    // Replace optimistic with real message
                    const next = [...prev];
                    next[optimisticIdx] = newMsg;
                    return next;
                }
                // Standard dedup for UPDATE events
                if (prev.find(m => m.id === newMsg.id)) {
                    return prev.map(m => m.id === newMsg.id ? newMsg : m);
                }
                return [...prev, newMsg];
            });
        });

        setTimeout(() => messageEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    };

    const sendChannelMessage = async (bypassFilter = false) => {
        if (!messageText.trim() || !activeChannel) return;
        const text = messageText.trim();

        // Layer 1: Client-side filter check (pre-send)
        if (!bypassFilter) {
            const check = clientFilter(text);
            if (check.blocked || check.warning) {
                setFilterWarning(check);
                return; // Don't send — show warning first
            }
        }
        setFilterWarning(null);
        setMessageText('');

        const optimistic: ChatMessage = {
            id: `opt-${Date.now()}`,
            channel_id: activeChannel.id,
            user_id: 'self',
            display_name: 'You',
            message: text,
            is_question: isQuestion,
            helpful_count: 0,
            is_pinned: false,
            deleted_at: null,
            created_at: new Date().toISOString(),
        };
        setMessages(prev => [...prev, optimistic]);
        setIsQuestion(false);

        // Message posts instantly; Gemini checks async (Layer 2)
        await ChatService.sendMessage(activeChannel.id, text, isQuestion);
        triggerHaptic('light');
        setTimeout(() => messageEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    };

    // --- PIN DROP ---
    const openPinDrop = async () => {
        setShowAttachMenu(false);
        setPinLoading(true);
        setPinCaption('');
        setShowPinSheet(true);

        // Load saved pins from Supabase
        PinService.getMyPins(15).then(pins => setSavedPins(pins)).catch(() => { });

        // Get GPS position
        try {
            const pos = BgGeoManager.getLastPosition();
            if (pos) {
                setPinLat(pos.latitude);
                setPinLng(pos.longitude);
            } else {
                // Fallback: try fresh position
                const freshPos = await BgGeoManager.getFreshPosition(60000, 10);
                if (freshPos) {
                    setPinLat(freshPos.latitude);
                    setPinLng(freshPos.longitude);
                } else {
                    // Default to Sydney Harbour
                    setPinLat(-33.8568);
                    setPinLng(151.2153);
                }
            }
        } catch (e) {
            log.warn('GPS fallback:', e);
            setPinLat(-33.8568);
            setPinLng(151.2153);
        }
        setPinLoading(false);
    };

    // Static map URL helper for Drop a Pin
    const getStaticMapUrl = (lat: number, lng: number, zoom = 13, w = 600, h = 200) => {
        const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
        if (!token || token.length < 10) return '';
        return `https://api.mapbox.com/styles/v1/mapbox/navigation-night-v1/static/pin-l+38bdf8(${lng},${lat})/${lng},${lat},${zoom},0/${w}x${h}@2x?access_token=${token}`;
    };

    // Open POI picker (Share Point of Interest)
    const openPoiPicker = () => {
        setShowAttachMenu(false);
        setShowPoiSheet(true);
        setPinCaption('');
        // Start at current GPS if available
        setPinLoading(true);
        GpsService.getCurrentPosition({ staleLimitMs: 30_000, timeoutSec: 8 }).then((pos) => {
            if (pos) {
                setPinLat(pos.latitude);
                setPinLng(pos.longitude);
            } else {
                setPinLat(-27.4698);
                setPinLng(153.0251);
            }
            setPinLoading(false);
        });
    };

    // Initialize Mapbox GL map for POI picker
    useEffect(() => {
        if (!showPoiSheet || pinLoading || !poiMapRef.current) return;
        if (poiMapInitialized.current) return;
        poiMapInitialized.current = true;

        // Inject Mapbox GL CSS if not already present
        if (!document.querySelector('link[href*="mapbox-gl"]')) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://api.mapbox.com/mapbox-gl-js/v3.9.4/mapbox-gl.css';
            document.head.appendChild(link);
        }

        import('mapbox-gl').then((mapboxgl) => {
            if (!poiMapRef.current || poiMapInstance.current) return;

            const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
            if (!token || token.length < 10) return;

            mapboxgl.default.accessToken = token;

            const map = new mapboxgl.default.Map({
                container: poiMapRef.current,
                style: 'mapbox://styles/mapbox/navigation-night-v1',
                center: [pinLng, pinLat],
                zoom: 12,
                attributionControl: false,
            });

            // Add navigation controls
            map.addControl(new mapboxgl.default.NavigationControl({ showCompass: false }), 'top-right');

            // Create draggable marker
            const marker = new mapboxgl.default.Marker({ color: '#38bdf8', draggable: true })
                .setLngLat([pinLng, pinLat])
                .addTo(map);
            poiMarkerRef.current = marker;

            marker.on('dragend', () => {
                const lngLat = marker.getLngLat();
                setPinLat(lngLat.lat);
                setPinLng(lngLat.lng);
            });

            // Tap map to move marker
            map.on('click', (e) => {
                marker.setLngLat(e.lngLat);
                setPinLat(e.lngLat.lat);
                setPinLng(e.lngLat.lng);
            });

            poiMapInstance.current = map;
        });
    }, [showPoiSheet, pinLoading]);

    // Cleanup Mapbox GL map when POI sheet closes
    useEffect(() => {
        if (!showPoiSheet && poiMapInstance.current) {
            poiMapInstance.current.remove();
            poiMapInstance.current = null;
            poiMarkerRef.current = null;
            poiMapInitialized.current = false;
        }
    }, [showPoiSheet]);

    // Send POI (reuses the same pin format)
    const sendPoi = async () => {
        if (!activeChannel) return;
        const text = `${PIN_PREFIX}${pinLat.toFixed(6)},${pinLng.toFixed(6)}|[POI] ${pinCaption.trim() || 'Point of interest'}`;
        setShowPoiSheet(false);
        setPinCaption('');

        setMessageText('');
        const optimistic: ChatMessage = {
            id: `opt-${Date.now()}`,
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

        PinService.savePin({
            latitude: pinLat,
            longitude: pinLng,
            caption: pinCaption.trim() || 'Point of interest',
        }).catch(() => { });

        setTimeout(() => messageEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    };

    // Open track picker — loads user's voyages grouped by voyageId
    const openTrackPicker = async () => {
        setShowAttachMenu(false);
        setShowTrackPicker(true);
        setTrackLoadingVoyages(true);
        try {
            const entries = await ShipLogService.getLogEntries(500);
            // ── Provenance filter: only show device-recorded voyages ──
            // Imported/community tracks cannot be re-shared
            const deviceEntries = entries.filter((e: ShipLogEntry) => !e.source || e.source === 'device');
            // Group by voyageId
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
                    // Prefer cumulativeDistanceNM, fallback to summing individual distanceNM
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
                .filter(v => v.entryCount >= 2) // Need at least 2 points for a track
                .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
            setVoyageList(list);
        } catch (e) {
            log.warn('Track picker load failed:', e);
            setVoyageList([]);
        } finally {
            setTrackLoadingVoyages(false);
        }
    };

    // Share a specific voyage to the chat
    const sendTrack = async (voyage: typeof voyageList[0]) => {
        if (!activeChannel || trackSharing) return;
        setTrackSharing(true);
        try {
            const startDate = new Date(voyage.startTime).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
            const title = `Voyage ${startDate} — ${voyage.distance}nm`;

            // Share via TrackSharingService (stores GPX in Supabase)
            const shared = await TrackSharingService.shareTrack(voyage.entries, {
                title,
                description: `${voyage.entryCount} waypoints, ${voyage.distance}nm`,
                tags: [],
                category: 'coastal',
                region: '',
            });

            if (shared) {
                // Send track message to chat
                const text = `${TRACK_PREFIX}${shared.id}|${title}`;
                setShowTrackPicker(false);

                const optimistic: ChatMessage = {
                    id: `opt-${Date.now()}`,
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
    };

    // Import a shared track from chat into user's logs
    const handleImportTrack = async (trackId: string, title: string) => {
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
            // Stamp as community download
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
    };

    const sendPin = async () => {
        if (!activeChannel) return;
        const text = `${PIN_PREFIX}${pinLat.toFixed(6)},${pinLng.toFixed(6)}|[LOC] ${pinCaption.trim() || 'My Location'}`;
        setShowPinSheet(false);
        setPinCaption('');

        // Send as regular message
        setMessageText('');
        const optimistic: ChatMessage = {
            id: `opt-${Date.now()}`,
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

        // Save pin to Supabase for history
        PinService.savePin({
            latitude: pinLat,
            longitude: pinLng,
            caption: pinCaption.trim() || 'Dropped a pin',
        }).catch(() => { });

        setTimeout(() => messageEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    };

    const handleReport = async () => {
        if (!reportingMsg) return;
        const userId = (await ChatService.getCurrentUser())?.id;
        if (!userId) return;
        await reportMessage(reportingMsg.id, userId, reportReason);
        // Auto-trigger Gemini re-check on the reported message
        moderateMessage(reportingMsg.id, reportingMsg.message, reportingMsg.user_id, reportingMsg.channel_id).catch(() => { });
        setReportSent(true);
        setTimeout(() => { setReportingMsg(null); setReportSent(false); }, 1500);
    };

    const handleProposeChannel = async () => {
        if (!proposalName.trim()) return;

        let ok = false;
        if (isAdmin) {
            // Admins create instantly — no pending review needed
            const ch = await ChatService.createChannel(
                proposalName.trim(), proposalDesc.trim() || 'A new channel',
                proposalIcon, proposalIsPrivate, undefined, proposalParentId || undefined
            );
            ok = !!ch;
            // Refresh channel list
            if (ok) {
                const updated = await ChatService.getChannels();
                setChannels(updated);
            }
        } else {
            // Non-admins propose — goes to pending for admin approval
            ok = await ChatService.proposeChannel(
                proposalName.trim(), proposalDesc.trim() || 'A new channel',
                proposalIcon, proposalIsPrivate, undefined, proposalParentId || undefined
            );
        }

        if (ok) {
            setProposalSent(true);
            toast.success(isAdmin ? `${proposalName.trim()} created!` : 'Proposal submitted for admin review!');
            setTimeout(() => {
                setShowProposalForm(false); setProposalSent(false);
                setProposalName(''); setProposalDesc('');
                setProposalIsPrivate(false); setProposalParentId(null);
            }, 2000);
        } else {
            toast.error('Failed to submit — please try again');
        }
    };

    // Load private channel memberships
    const loadMemberChannels = async () => {
        const ids = new Set<string>();
        for (const ch of channels) {
            if (ch.is_private) {
                const isMember = await ChatService.isChannelMember(ch.id);
                if (isMember) ids.add(ch.id);
            }
        }
        setMemberChannelIds(ids);
    };

    React.useEffect(() => {
        if (channels.length > 0) loadMemberChannels();
    }, [channels]);

    const handleRequestAccess = (ch: ChatChannel) => {
        setJoinRequestChannel(ch);
        setJoinRequestMessage('');
        setJoinRequestSent(false);
    };

    const handleSubmitJoinRequest = async () => {
        if (!joinRequestChannel) return;
        const ok = await ChatService.requestJoinChannel(joinRequestChannel.id, joinRequestMessage);
        if (ok) {
            setJoinRequestSent(true);
            toast.success(`Request sent to ${joinRequestChannel.name}!`);
            setTimeout(() => setJoinRequestChannel(null), 2000);
        } else {
            toast.error('Failed to send request — you may already have a pending request');
        }
    };

    // --- PHOTO UPLOAD ---
    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setUploadError(null);
        setUploadProgress('Starting...');

        const result = await uploadProfilePhoto(file, (step) => setUploadProgress(step));

        if (result.success && result.url) {
            setMyAvatarUrl(result.url);
            setUploadProgress(null);
            setShowPhotoUpload(false);
        } else {
            setUploadError(result.error || 'Upload failed');
            setUploadProgress(null);
        }

        // Reset file input
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleRemovePhoto = async () => {
        await removeProfilePhoto();
        setMyAvatarUrl(null);
        setShowPhotoUpload(false);
    };

    const getAvatar = (userId: string): string | null => {
        if (userId === 'self') return myAvatarUrl;
        return avatarMap.get(userId) || getCachedAvatar(userId) || null;
    };

    const handleSaveProfile = async () => {
        setProfileSaving(true);
        await updateProfile({
            display_name: profileDisplayName.trim() || undefined,
            vessel_name: profileVesselName.trim() || undefined,
            looking_for_love: profileLookingForLove,
        });
        setProfileSaving(false);
        setProfileSaved(true);
        // Brief success feedback, then return to channel list
        setTimeout(() => { setProfileSaved(false); setView('channels'); }, 1200);
    };

    // --- DM ACTIONS ---
    const openDMInbox = async () => {
        setNavDirection('forward');
        setView('dm_inbox');
        setLoading(true);
        const convs = await ChatService.getDMConversations();
        setDmConversations(convs);
        setLoading(false);
    };

    const openDMThread = async (userId: string, name: string) => {
        setDmPartner({ id: userId, name });
        setNavDirection('forward');
        setView('dm_thread');
        setShowBlockConfirm(false);
        setLoading(true);
        // Check block status + load thread in parallel
        const [thread, blocked] = await Promise.all([
            ChatService.getDMThread(userId),
            ChatService.isBlocked(userId),
        ]);
        setDmThread(thread);
        setIsUserBlocked(blocked);
        setLoading(false);
        setUnreadDMs(prev => Math.max(0, prev - 1));
    };

    const sendDMMessage = async () => {
        if (!dmText.trim() || !dmPartner) return;
        const text = dmText.trim();
        setDmText('');

        const optimistic: DirectMessage = {
            id: `opt-${Date.now()}`,
            sender_id: 'self',
            recipient_id: dmPartner.id,
            sender_name: 'You',
            message: text,
            read: true,
            created_at: new Date().toISOString(),
        };
        setDmThread(prev => [...prev, optimistic]);
        triggerHaptic('light');
        const result = await ChatService.sendDM(dmPartner.id, text);
        if (result === 'blocked') {
            // Remove optimistic message and show blocked state
            setDmThread(prev => prev.filter(m => m.id !== optimistic.id));
            setIsUserBlocked(true);
        }
    };

    // --- BLOCK / UNBLOCK ---
    const handleBlockUser = async () => {
        if (!dmPartner) return;
        const ok = await ChatService.blockUser(dmPartner.id);
        if (ok) {
            setIsUserBlocked(true);
            setShowBlockConfirm(false);
        }
    };

    const handleUnblockUser = async () => {
        if (!dmPartner) return;
        const ok = await ChatService.unblockUser(dmPartner.id);
        if (ok) setIsUserBlocked(false);
    };

    // --- MOD ACTIONS ---
    const handleDeleteMessage = useCallback(async (msgId: string) => {
        await ChatService.deleteMessage(msgId);
        triggerHaptic('heavy');
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, deleted_at: new Date().toISOString() } : m));
        setShowModMenu(null);
    }, []);

    const handlePinMessage = useCallback(async (msgId: string, pinned: boolean) => {
        await ChatService.pinMessage(msgId, !pinned);
        triggerHaptic('medium');
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, is_pinned: !pinned } : m));
        setShowModMenu(null);
    }, []);

    const handleMuteUser = useCallback(async (userId: string, hours: number) => {
        await ChatService.muteUser(userId, hours);
        setShowModMenu(null);
    }, []);

    // Confirm dialog state for mod actions
    const [confirmAction, setConfirmAction] = useState<{
        title: string;
        message: string;
        destructive: boolean;
        onConfirm: () => Promise<void>;
    } | null>(null);

    const handleBlockUserPlatform = useCallback(async (userId: string, name: string) => {
        setConfirmAction({
            title: 'Block User',
            message: `Block ${name} from the platform? This will permanently prevent them from sending messages.`,
            destructive: true,
            onConfirm: async () => {
                const ok = await ChatService.blockUserPlatform(userId);
                if (ok) toast.success(`${name} has been blocked from the platform`);
                setShowModMenu(null);
                setConfirmAction(null);
            },
        });
    }, []);

    const handleMakeAdmin = useCallback(async (userId: string, name: string) => {
        setConfirmAction({
            title: 'Promote to Admin',
            message: `Make ${name} an Admin? Admins can delete posts, pin messages, mute users, and create channels.`,
            destructive: false,
            onConfirm: async () => {
                const ok = await ChatService.setRole(userId, 'admin');
                if (ok) toast.success(`${name} is now an Admin`);
                setShowModMenu(null);
                setConfirmAction(null);
            },
        });
    }, []);

    const handleMarkHelpful = useCallback(async (msgId: string) => {
        // Prevent multiple likes per user per message
        if (likedMessages.has(msgId)) return;
        await ChatService.markHelpful(msgId);
        triggerHaptic('light');
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, helpful_count: m.helpful_count + 1 } : m));
        setLikedMessages(prev => {
            const next = new Set(prev);
            next.add(msgId);
            try { localStorage.setItem('chat_liked_messages', JSON.stringify([...next])); } catch (e) { console.warn('[ChatPage]', e); }
            return next;
        });
    }, [likedMessages]);

    const dismissWelcome = () => {
        setIsFirstVisit(false);
        localStorage.setItem('crew_talk_visited', 'true');
    };

    const goBack = () => {
        setShowModMenu(null);
        setNavDirection('back');
        if (view === 'messages') { setView('channels'); setActiveChannel(null); }
        else if (view === 'dm_thread') { setView('dm_inbox'); setDmPartner(null); }
        else if (view === 'dm_inbox') { setView('channels'); }
        else if (view === 'profile') { setView('channels'); }

        else if (view === 'find_crew') { setView('channels'); }
        else if (view === 'marketplace') { setView('channels'); }
        else if (view === 'admin_panel') { setView('channels'); }
    };

    const isMod = ChatService.isMod();
    const isAdmin = ChatService.isAdmin();
    const isModerator = ChatService.isModerator();
    const isMuted = ChatService.isMuted();
    const mutedUntil = ChatService.getMutedUntil();

    const pinnedMessages = messages.filter(m => m.is_pinned && !m.deleted_at);
    const regularMessages = messages.filter(m => !m.is_pinned);

    // --- RENDER ---
    return (
        <div
            className="flex flex-col h-full bg-slate-950 text-white overflow-hidden"
            style={keyboardOffset > 0 ? { height: `calc(100% - ${keyboardOffset}px)`, transition: 'height 0.15s ease-out' } : undefined}
        >

            {/* ═══════════════════ HEADER ═══════════════════ */}
            <ChatHeader
                view={view}
                activeChannel={activeChannel}
                dmPartnerName={dmPartner?.name}
                myAvatarUrl={myAvatarUrl}
                unreadDMs={unreadDMs}
                messageCount={messages.length}
                isUserBlocked={isUserBlocked}
                hasDMPartner={!!dmPartner}
                onGoBack={goBack}
                onOpenProfile={() => { setNavDirection('forward'); setView('profile'); }}
                onOpenDMInbox={openDMInbox}
                onToggleBlock={() => setShowBlockConfirm(true)}
            />

            {/* ═══════════ WELCOME BANNER ═══════════ */}
            {isFirstVisit && view === 'channels' && (
                <div className="mx-4 mt-3 fade-slide-down" role="banner" aria-label="Welcome to Crew Talk">
                    <div className="relative p-5 rounded-2xl overflow-hidden">
                        {/* Premium glassmorphism bg */}
                        <div className="absolute inset-0 bg-gradient-to-br from-sky-500/[0.08] via-indigo-500/[0.05] to-purple-500/[0.06] border border-sky-400/15 rounded-2xl" />
                        <div className="absolute inset-0 backdrop-blur-sm" />
                        <div className="relative">
                            <div className="flex items-start justify-between mb-3">
                                <div>
                                    <p className="text-base font-bold text-sky-300">Welcome aboard, sailor! 🌊</p>
                                    <p className="text-xs text-white/50 mt-0.5">Your crew is ready to help</p>
                                </div>
                                <button onClick={dismissWelcome} aria-label="Dismiss welcome message" className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-white/40 hover:text-white/70 text-sm transition-all min-w-[44px] min-h-[44px]">✕</button>
                            </div>
                            <div className="space-y-2.5">
                                <div className="flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.04]">
                                    <span className="text-lg">📢</span>
                                    <p className="text-xs text-white/60">Tap the <span className="text-amber-400 font-semibold">horn</span> to mark your message as a question — the crew will help</p>
                                </div>
                                <div className="flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.04]">
                                    <span className="text-lg">📍</span>
                                    <p className="text-xs text-white/60">Use <span className="text-sky-400 font-semibold">➕</span> to drop pins, share POIs, or send voyage tracks</p>
                                </div>
                                <div className="flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.04]">
                                    <span className="text-lg">⭐</span>
                                    <p className="text-xs text-white/60">Help others to rank up: {CREW_RANKS.slice(0, 4).map(r => `${r.badge}`).join(' → ')}</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}



            {/* Hidden file input */}
            <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={handleFileSelect}
            />

            {/* ═══════════ STATUS BANNERS ═══════════ */}
            {!navigator.onLine && (
                <div className="mx-4 mt-2 px-3 py-2 rounded-xl bg-amber-500/[0.06] border border-amber-500/10 text-amber-400/80 text-[11px] text-center fade-slide-down">
                    📡 Offline — messages will be sent when you reconnect
                </div>
            )}
            {isMuted && mutedUntil && (
                <div className="mx-4 mt-2 px-3 py-2 rounded-xl bg-red-500/[0.06] border border-red-500/10 text-red-400/80 text-[11px] text-center fade-slide-down">
                    🔇 Muted until {mutedUntil.toLocaleTimeString()} — you can still read messages
                </div>
            )}

            {/* ═══════════════════ CONTENT ═══════════════════ */}
            <ChatErrorBoundary>
                <div
                    key={view}
                    ref={pullRefresh.containerRef}
                    className={`flex-1 overflow-y-auto overscroll-contain overscroll-glow ${navDirection === 'back' ? 'chat-slide-back' : 'chat-slide-forward'}`}
                    {...pullRefresh.handlers}
                >
                    {/* Pull-to-refresh indicator */}
                    {pullRefresh.pullDistance > 0 && (
                        <div
                            className="flex items-center justify-center transition-all duration-150"
                            style={{ height: pullRefresh.pullDistance }}
                        >
                            {pullRefresh.isRefreshing ? (
                                <div className="w-5 h-5 border-2 border-sky-400/30 rounded-full border-t-sky-400 animate-spin" />
                            ) : (
                                <span className={`text-white/30 text-sm transition-transform ${pullRefresh.pullDistance > 28 ? 'rotate-180' : ''}`}>↓</span>
                            )}
                        </div>
                    )}
                    {loading && view === 'channels' && (
                        <div className="pb-24">
                            <SkeletonChannelList />
                            <div className="flex justify-center pt-2">
                                <span className="text-xs text-white/40">{loadingStatus}</span>
                            </div>
                        </div>
                    )}
                    {loading && view === 'messages' && (
                        <div className="pb-24">
                            <SkeletonMessageList />
                        </div>
                    )}

                    {/* ══════ FIND CREW BOARD ══════ */}
                    {view === 'find_crew' && !loading && (
                        <LonelyHeartsPage
                            onOpenDM={(userId, name) => {
                                openDMThread(userId, name);
                            }}
                        />
                    )}
                    {/* ══════ MARKETPLACE ══════ */}
                    {view === 'marketplace' && !loading && (
                        <MarketplacePage
                            onBack={() => setView('channels')}
                            onOpenDM={(sellerId, sellerName) => {
                                openDMThread(sellerId, sellerName);
                            }}
                        />
                    )}

                    {/* ══════ FULL-PAGE PROFILE ══════ */}
                    {view === 'profile' && !loading && (
                        <ChatProfileView
                            myAvatarUrl={myAvatarUrl}
                            uploadProgress={uploadProgress}
                            uploadError={uploadError}
                            profileDisplayName={profileDisplayName}
                            setProfileDisplayName={setProfileDisplayName}
                            profileVesselName={profileVesselName}
                            setProfileVesselName={setProfileVesselName}
                            profileSaving={profileSaving}
                            profileSaved={profileSaved}
                            vesselPlaceholder={settings.vessel?.name || ''}
                            fileInputRef={fileInputRef}
                            onSaveProfile={handleSaveProfile}
                            onRemovePhoto={handleRemovePhoto}
                        />
                    )}

                    {/* ══════ CHANNEL LIST ══════ */}
                    {view === 'channels' && !loading && (
                        <ChannelList
                            channels={channels}
                            onOpenChannel={openChannel}
                            onRequestAccess={handleRequestAccess}
                            isMod={isMod}
                            showProposalForm={showProposalForm}
                            setShowProposalForm={setShowProposalForm}
                            proposalIcon={proposalIcon}
                            setProposalIcon={setProposalIcon}
                            proposalName={proposalName}
                            setProposalName={setProposalName}
                            proposalDesc={proposalDesc}
                            setProposalDesc={setProposalDesc}
                            proposalIsPrivate={proposalIsPrivate}
                            setProposalIsPrivate={setProposalIsPrivate}
                            proposalSent={proposalSent}
                            onProposeChannel={handleProposeChannel}
                            isAdmin={isAdmin}
                            onOpenAdmin={() => { setNavDirection('forward'); setView('admin_panel'); }}
                            memberChannelIds={memberChannelIds}
                            proposalParentId={proposalParentId}
                            setProposalParentId={setProposalParentId}
                        />
                    )}

                    {/* ══════ ADMIN PANEL ══════ */}
                    {view === 'admin_panel' && !loading && (
                        <AdminPanel isOpen={true} onClose={() => setView('channels')} />
                    )}

                    {/* ══════ JOIN REQUEST MODAL ══════ */}
                    {joinRequestChannel && (
                        <div className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/70" onClick={() => setJoinRequestChannel(null)}>
                            <div
                                className="w-full max-w-lg bg-slate-950 border-t border-purple-500/20 rounded-t-3xl shadow-2xl p-5 space-y-4"
                                onClick={e => e.stopPropagation()}
                                role="dialog"
                                aria-modal="true"
                                aria-label={`Request access to ${joinRequestChannel.name}`}
                            >
                                <div className="flex items-center gap-3">
                                    <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-purple-500/20 to-indigo-500/10 border border-purple-500/30 flex items-center justify-center text-xl">
                                        🔒
                                    </div>
                                    <div>
                                        <h3 className="text-sm font-bold text-white">Request Access</h3>
                                        <p className="text-[11px] text-purple-400/60">{joinRequestChannel.name} — Private Channel</p>
                                    </div>
                                </div>

                                <p className="text-xs text-white/50">
                                    This is a private channel. Write a message to the channel owner explaining why you'd like to join.
                                </p>

                                <textarea
                                    value={joinRequestMessage}
                                    onChange={e => setJoinRequestMessage(e.target.value)}
                                    placeholder="Why do you want to join this channel?"
                                    aria-label="Join request message"
                                    rows={3}
                                    className="w-full px-3.5 py-3 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-purple-500/40 transition-colors resize-none min-h-[80px]"
                                />

                                <div className="flex gap-2">
                                    <button
                                        onClick={() => setJoinRequestChannel(null)}
                                        aria-label="Cancel request"
                                        className="flex-1 py-3 rounded-xl bg-white/[0.04] text-sm text-white/60 font-medium min-h-[48px]"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={handleSubmitJoinRequest}
                                        disabled={joinRequestSent}
                                        aria-label="Submit join request"
                                        className="flex-1 py-3 rounded-xl bg-purple-500/20 border border-purple-500/30 text-sm text-purple-400 font-bold active:scale-95 disabled:opacity-50 min-h-[48px]"
                                    >
                                        {joinRequestSent ? '✓ Request Sent!' : '🙏 Submit Request'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ══════ MESSAGE VIEW ══════ */}
                    {view === 'messages' && !loading && (
                        <>
                            <ChatMessageList
                                messages={messages}
                                pinnedMessages={pinnedMessages}
                                isMod={isMod}
                                isAdmin={isAdmin}
                                isModerator={isModerator}
                                likedMessages={likedMessages}
                                showModMenu={showModMenu}
                                showRankTooltip={showRankTooltip}
                                importingTrackId={importingTrackId}
                                getAvatar={getAvatar}
                                onOpenDMThread={openDMThread}
                                onMarkHelpful={handleMarkHelpful}
                                onReportMsg={(msg) => { setReportingMsg(msg); setReportSent(false); }}
                                onToggleModMenu={(msgId) => setShowModMenu(showModMenu === msgId ? null : msgId)}
                                onDeleteMessage={handleDeleteMessage}
                                onPinMessage={handlePinMessage}
                                onMuteUser={handleMuteUser}
                                onBlockUser={handleBlockUserPlatform}
                                onMakeAdmin={handleMakeAdmin}
                                onSetRankTooltip={setShowRankTooltip}
                                onShowTrackDisclaimer={setShowTrackDisclaimer}
                                messageEndRef={messageEndRef}
                            />
                            {/* Typing indicator — shown briefly after channel switch */}
                            {showTyping && <TypingIndicator />}
                        </>
                    )}

                    {/* ══════ DM INBOX ══════ */}
                    {view === 'dm_inbox' && !loading && (
                        <ChatDMInbox conversations={dmConversations} onOpenThread={openDMThread} />
                    )}

                    {/* ══════ DM THREAD ══════ */}
                    {view === 'dm_thread' && !loading && (
                        <ChatDMThread thread={dmThread} partnerName={dmPartner?.name} />
                    )}
                </div>
            </ChatErrorBoundary>

            {/* ═══════════ REPORT MODAL ═══════════ */}
            {reportingMsg && (
                <ReportModal
                    reportingMsg={reportingMsg}
                    reportSent={reportSent}
                    reportReason={reportReason}
                    setReportReason={setReportReason}
                    onSubmit={handleReport}
                    onClose={() => setReportingMsg(null)}
                />
            )}

            {/* ═══════════ DROP A PIN (static map) ═══════════ */}
            {showPinSheet && view === 'messages' && (
                <PinDropSheet
                    pinLat={pinLat}
                    pinLng={pinLng}
                    pinCaption={pinCaption}
                    setPinCaption={setPinCaption}
                    setPinLat={setPinLat}
                    setPinLng={setPinLng}
                    pinLoading={pinLoading}
                    savedPins={savedPins}
                    onSendPin={sendPin}
                    onClose={() => setShowPinSheet(false)}
                />
            )}

            {/* ═══════════ SHARE POI (interactive Mapbox GL) ═══════════ */}
            {showPoiSheet && view === 'messages' && (
                <PoiPickerSheet
                    pinLat={pinLat}
                    pinLng={pinLng}
                    pinCaption={pinCaption}
                    setPinCaption={setPinCaption}
                    pinLoading={pinLoading}
                    poiMapRef={poiMapRef}
                    onSendPoi={sendPoi}
                    onClose={() => setShowPoiSheet(false)}
                />
            )}

            {/* ═══════════ SHARE TRACK PICKER ═══════════ */}
            {showTrackPicker && view === 'messages' && (
                <TrackPickerSheet
                    voyageList={voyageList}
                    trackLoadingVoyages={trackLoadingVoyages}
                    trackSharing={trackSharing}
                    onSendTrack={sendTrack}
                    onClose={() => setShowTrackPicker(false)}
                />
            )}

            {/* ═══════════════════ COMPOSE BAR ═══════════════════ */}
            {view === 'messages' && (
                <ChatComposer
                    messageText={messageText}
                    setMessageText={setMessageText}
                    isQuestion={isQuestion}
                    setIsQuestion={setIsQuestion}
                    filterWarning={filterWarning}
                    setFilterWarning={setFilterWarning}
                    isMuted={isMuted}
                    mutedUntil={mutedUntil}
                    showAttachMenu={showAttachMenu}
                    setShowAttachMenu={setShowAttachMenu}
                    keyboardOffset={keyboardOffset}
                    inputRef={inputRef}
                    onSend={(bypass) => sendChannelMessage(bypass)}
                    onOpenPinDrop={openPinDrop}
                    onOpenPoiPicker={openPoiPicker}
                    onOpenTrackPicker={openTrackPicker}
                />
            )}

            {/* DM compose */}
            {view === 'dm_thread' && (
                <ChatDMCompose
                    dmText={dmText}
                    setDmText={setDmText}
                    partnerName={dmPartner?.name}
                    keyboardOffset={keyboardOffset}
                    isUserBlocked={isUserBlocked}
                    showBlockConfirm={showBlockConfirm}
                    setShowBlockConfirm={setShowBlockConfirm}
                    onSendDM={sendDMMessage}
                    onBlock={handleBlockUser}
                    onUnblock={handleUnblockUser}
                />
            )}

            {/* ═══════════ TRACK IMPORT DISCLAIMER MODAL ═══════════ */}
            {showTrackDisclaimer && (
                <TrackDisclaimerModal
                    track={showTrackDisclaimer}
                    onImport={handleImportTrack}
                    onClose={() => setShowTrackDisclaimer(null)}
                />
            )}

            {/* ═══════════ TRACK IMPORT STATUS TOAST ═══════════ */}
            {trackImportStatus && (
                <div className="fixed bottom-28 left-1/2 -translate-x-1/2 z-[9998] px-5 py-3 rounded-xl shadow-2xl border max-w-[320px] text-center"
                    style={{
                        background: trackImportStatus!.startsWith('✅') ? 'rgba(6,78,59,0.95)' : 'rgba(127,29,29,0.95)',
                        borderColor: trackImportStatus!.startsWith('✅') ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)',

                    }}>
                    <p className={`text-sm font-bold ${trackImportStatus!.startsWith('✅') ? 'text-emerald-300' : 'text-red-300'}`}>
                        {trackImportStatus}
                    </p>
                </div>
            )}
            {/* Mod action confirm dialog */}
            <ConfirmDialog
                isOpen={!!confirmAction}
                title={confirmAction?.title || ''}
                message={confirmAction?.message || ''}
                destructive={confirmAction?.destructive || false}
                confirmLabel={confirmAction?.destructive ? 'Block' : 'Confirm'}
                onConfirm={confirmAction?.onConfirm || (() => { })}
                onCancel={() => setConfirmAction(null)}
            />
        </div>
    );
};

export default ChatPage;
