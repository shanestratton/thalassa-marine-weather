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
import { ChatService, ChatChannel, ChatMessage, DirectMessage, DMConversation, DEFAULT_CHANNELS } from '../services/ChatService';
import { clientFilter, reportMessage, type ClientFilterResult } from '../services/ContentModerationService';
import { uploadProfilePhoto, batchFetchAvatars, getCachedAvatar, removeProfilePhoto, getProfile, updateProfile } from '../services/ProfilePhotoService';
import { LonelyHeartsPage } from './LonelyHeartsPage';
import { DatingSwipePage } from './DatingSwipePage';
import { BgGeoManager } from '../services/BgGeoManager';
import { PinService, SavedPin } from '../services/PinService';
import { ShipLogService } from '../services/ShipLogService';
import { TrackSharingService } from '../services/TrackSharingService';
import { ShipLogEntry } from '../types';
import { importGPXToEntries } from '../services/gpxService';
import { useSettings } from '../context/SettingsContext';
import { moderateMessage } from '../services/ContentModerationService';
import { t } from '../theme';
import { MarketplacePage } from './MarketplacePage';

// --- PIN / TRACK MESSAGE PARSING ---
const PIN_PREFIX = '📍PIN:';
const TRACK_PREFIX = '🗺️TRACK:';

function parsePinMessage(msg: string): { lat: number; lng: number; caption: string } | null {
    if (!msg.startsWith(PIN_PREFIX)) return null;
    const rest = msg.slice(PIN_PREFIX.length);
    const [coords, ...captionParts] = rest.split('|');
    const [latStr, lngStr] = coords.split(',');
    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);
    if (isNaN(lat) || isNaN(lng)) return null;
    return { lat, lng, caption: captionParts.join('|').trim() };
}

function parseTrackMessage(msg: string): { trackId: string; title: string } | null {
    if (!msg.startsWith(TRACK_PREFIX)) return null;
    const rest = msg.slice(TRACK_PREFIX.length);
    const [trackId, ...titleParts] = rest.split('|');
    return { trackId: trackId.trim(), title: titleParts.join('|').trim() || 'Shared Track' };
}

function getStaticMapUrl(lat: number, lng: number, zoom = 13, w = 300, h = 180): string {
    const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
    if (token && token.length > 10) {
        return `https://api.mapbox.com/styles/v1/mapbox/navigation-night-v1/static/pin-l+ff4466(${lng},${lat})/${lng},${lat},${zoom},0/${w}x${h}@2x?access_token=${token}&logo=false&attribution=false`;
    }
    // Fallback to OSM static tile
    return `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}&zoom=${zoom}&size=${w}x${h}&markers=${lat},${lng},ol-marker`;
}

// --- TYPES ---
type ChatView = 'channels' | 'messages' | 'dm_inbox' | 'dm_thread' | 'profile' | 'lonely_hearts' | 'find_crew' | 'marketplace';

// --- AVATAR COLOR SYSTEM ---
const AVATAR_GRADIENTS = [
    'from-sky-400 to-blue-600',
    'from-emerald-400 to-teal-600',
    'from-violet-400 to-purple-600',
    'from-rose-400 to-pink-600',
    'from-amber-400 to-orange-600',
    'from-cyan-400 to-sky-600',
    'from-fuchsia-400 to-violet-600',
    'from-lime-400 to-emerald-600',
    'from-orange-400 to-red-600',
    'from-indigo-400 to-blue-700',
];

const getAvatarGradient = (userId: string): string => {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
        hash = ((hash << 5) - hash) + userId.charCodeAt(i);
        hash |= 0;
    }
    return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
};

// --- HELPERS ---
const timeAgo = (dateStr: string): string => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString();
};

const CREW_RANKS: { min: number; badge: string; title: string }[] = [
    { min: 200, badge: '👑', title: 'Fleet Admiral' },
    { min: 100, badge: '🏆', title: 'Captain' },
    { min: 50, badge: '⭐', title: 'First Mate' },
    { min: 20, badge: '🎖️', title: 'Bosun' },
    { min: 5, badge: '⚓', title: 'Able Seaman' },
    { min: 0, badge: '🚢', title: 'Deckhand' },
];

const getCrewRank = (helpful: number) => {
    return CREW_RANKS.find(r => helpful >= r.min) || CREW_RANKS[CREW_RANKS.length - 1];
};

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

    // Loading
    const [loading, setLoading] = useState(true);
    const [loadingStatus, setLoadingStatus] = useState('Connecting to Crew Talk…');

    // Helpful button per-user guard (persisted across sessions)
    const [likedMessages, setLikedMessages] = useState<Set<string>>(() => {
        try {
            const stored = localStorage.getItem('chat_liked_messages');
            return stored ? new Set(JSON.parse(stored)) : new Set();
        } catch { return new Set(); }
    });

    // Keyboard offset — shrinks chat container height so compose stays visible above iOS keyboard
    const [keyboardOffset, setKeyboardOffset] = useState(0);
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
        ChatService.initialize().then(async () => {
            setLoadingStatus('Loading channels…');
            const chs = await loadChannels();
            loadUnreadCount();

            // Load chat profile (pre-populate vessel from onboarding)
            ChatService.getCurrentUser().then(async (user) => {
                if (user) {
                    const profile = await getProfile(user.id);
                    if (profile) {
                        setProfileDisplayName(profile.display_name || '');
                        setProfileVesselName(profile.vessel_name || settings.vessel?.name || '');
                        setProfileLookingForLove(profile.looking_for_love || false);
                        if (profile.avatar_url) setMyAvatarUrl(profile.avatar_url);
                    } else {
                        // First time: pre-fill from onboarding
                        setProfileVesselName(settings.vessel?.name || '');
                    }
                    setProfileLoaded(true);
                }
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
        setLoading(true);
        const chs = await ChatService.getChannels();
        const result = chs.length > 0 ? chs : DEFAULT_CHANNELS.map((c, i) => ({
            ...c,
            id: `default-${i}`,
            created_at: new Date().toISOString(),
        }));
        setChannels(result);
        setLoading(false);
        return result;
    };

    const loadUnreadCount = async () => {
        const count = await ChatService.getUnreadDMCount();
        setUnreadDMs(count);
    };

    // --- CHANNEL ACTIONS ---
    const openChannel = async (channel: ChatChannel) => {
        // First Mates (legacy DB name: 'Lonely Hearts') gets its own dedicated page
        if (channel.name === 'First Mates' || channel.name === 'Lonely Hearts') {
            setView('lonely_hearts');
            return;
        }
        // Find Crew gets the crew board page
        if (channel.name === 'Find Crew') {
            setView('find_crew');
            return;
        }
        // Marketplace gets the gear exchange page
        if (channel.name === 'Marketplace') {
            setView('marketplace');
            return;
        }
        setActiveChannel(channel);
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
        } catch {
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
        import('@capacitor/geolocation').then(({ Geolocation }) => {
            Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 })
                .then(pos => {
                    setPinLat(pos.coords.latitude);
                    setPinLng(pos.coords.longitude);
                })
                .catch(() => {
                    setPinLat(-27.4698);
                    setPinLng(153.0251);
                })
                .finally(() => setPinLoading(false));
        }).catch(() => {
            setPinLat(-27.4698);
            setPinLng(153.0251);
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
        const text = `${PIN_PREFIX}${pinLat.toFixed(6)},${pinLng.toFixed(6)}|${pinCaption.trim() || 'Point of interest'}`;
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
        } catch {
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
            console.error('Failed to share track:', err);
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
                console.error('GPX parse failed:', parseErr);
                setTrackImportStatus('❌ Invalid GPX data — cannot parse');
                return;
            }
            if (entries.length === 0) {
                setTrackImportStatus('❌ No valid entries in track');
                return;
            }
            // Stamp as community download
            entries.forEach(e => { (e as any).source = 'community_download'; });
            setTrackImportStatus(`⏳ Saving ${entries.length} entries…`);
            const { savedCount } = await ShipLogService.importGPXVoyage(entries);
            setTrackImportStatus(`✅ Imported "${title}" — ${savedCount} entries`);
        } catch (err) {
            console.error('Track import failed:', err);
            const msg = err instanceof Error ? err.message : 'Unknown error';
            setTrackImportStatus(`❌ Import failed — ${msg}`);
        } finally {
            setImportingTrackId(null);
            setTimeout(() => setTrackImportStatus(null), 5000);
        }
    };

    const sendPin = async () => {
        if (!activeChannel) return;
        const text = `${PIN_PREFIX}${pinLat.toFixed(6)},${pinLng.toFixed(6)}|${pinCaption.trim() || 'Dropped a pin'}`;
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
        const ok = await ChatService.proposeChannel(proposalName.trim(), proposalDesc.trim() || 'A new channel', proposalIcon);
        if (ok) {
            setProposalSent(true);
            setTimeout(() => { setShowProposalForm(false); setProposalSent(false); setProposalName(''); setProposalDesc(''); }, 2000);
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
        setTimeout(() => setProfileSaved(false), 2000);
    };

    // --- DM ACTIONS ---
    const openDMInbox = async () => {
        setView('dm_inbox');
        setLoading(true);
        const convs = await ChatService.getDMConversations();
        setDmConversations(convs);
        setLoading(false);
    };

    const openDMThread = async (userId: string, name: string) => {
        setDmPartner({ id: userId, name });
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
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, deleted_at: new Date().toISOString() } : m));
        setShowModMenu(null);
    }, []);

    const handlePinMessage = useCallback(async (msgId: string, pinned: boolean) => {
        await ChatService.pinMessage(msgId, !pinned);
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, is_pinned: !pinned } : m));
        setShowModMenu(null);
    }, []);

    const handleMuteUser = useCallback(async (userId: string, hours: number) => {
        await ChatService.muteUser(userId, hours);
        setShowModMenu(null);
    }, []);

    const handleMarkHelpful = useCallback(async (msgId: string) => {
        // Prevent multiple likes per user per message
        if (likedMessages.has(msgId)) return;
        await ChatService.markHelpful(msgId);
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, helpful_count: m.helpful_count + 1 } : m));
        setLikedMessages(prev => {
            const next = new Set(prev);
            next.add(msgId);
            try { localStorage.setItem('chat_liked_messages', JSON.stringify([...next])); } catch { }
            return next;
        });
    }, [likedMessages]);

    const dismissWelcome = () => {
        setIsFirstVisit(false);
        localStorage.setItem('crew_talk_visited', 'true');
    };

    const goBack = () => {
        setShowModMenu(null);
        if (view === 'messages') { setView('channels'); setActiveChannel(null); }
        else if (view === 'dm_thread') { setView('dm_inbox'); setDmPartner(null); }
        else if (view === 'dm_inbox') { setView('channels'); }
        else if (view === 'profile') { setView('channels'); }
        else if (view === 'lonely_hearts') { setView('channels'); }
        else if (view === 'find_crew') { setView('channels'); }
        else if (view === 'marketplace') { setView('channels'); }
    };

    const isMod = ChatService.isMod();
    const isMuted = ChatService.isMuted();
    const mutedUntil = ChatService.getMutedUntil();

    const pinnedMessages = messages.filter(m => m.is_pinned && !m.deleted_at);
    const regularMessages = messages.filter(m => !m.is_pinned);

    // --- RENDER ---
    return (
        <div
            className="flex flex-col h-full bg-[#050a18] text-white overflow-hidden"
            style={keyboardOffset > 0 ? { height: `calc(100% - ${keyboardOffset}px)`, transition: 'height 0.15s ease-out' } : undefined}
        >

            {/* ═══════════════════ HEADER ═══════════════════ */}
            <div className={t.header.bar}>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        {view !== 'channels' && (
                            <button
                                onClick={goBack}
                                className="w-8 h-8 rounded-full bg-white/[0.06] hover:bg-white/[0.12] flex items-center justify-center transition-all active:scale-90"
                            >
                                <span className="text-sky-400 text-sm">‹</span>
                            </button>
                        )}
                        {view === 'channels' ? (
                            <span className={t.typography.pageTitle}>Crew Talk</span>
                        ) : (
                            <h1 className={`${t.typography.pageTitle} flex items-center gap-2`}>
                                {view === 'messages' && (activeChannel ? `${activeChannel.icon} ${activeChannel.name}` : 'Channel')}
                                {view === 'dm_inbox' && '✉️ Messages'}
                                {view === 'dm_thread' && `${dmPartner?.name || 'DM'}`}
                                {view === 'profile' && '⚓ Sailor Profile'}
                                {view === 'lonely_hearts' && <><span className="text-[#FF7F50]">♥</span> First Mates</>}
                                {view === 'find_crew' && '👥 Find Crew'}
                                {view === 'marketplace' && '🏪 Marketplace'}
                            </h1>
                        )}
                        {view === 'messages' && activeChannel && (
                            <p className="text-[13px] text-white/50 ml-1">{activeChannel.description}</p>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        {view === 'channels' && (
                            <>
                                {/* Profile photo button */}
                                <button
                                    onClick={() => setView('profile')}
                                    className="relative w-10 h-10 rounded-xl overflow-hidden border border-white/[0.12] hover:border-white/[0.18] bg-white/[0.08] hover:bg-white/[0.12] transition-all active:scale-95"
                                >
                                    {myAvatarUrl ? (
                                        <img src={myAvatarUrl} alt="" className="w-full h-full object-cover" />
                                    ) : (
                                        <div className="w-full h-full bg-white/[0.04] flex items-center justify-center">
                                            <span className="text-xl">⚓</span>
                                        </div>
                                    )}
                                </button>
                                <button
                                    onClick={openDMInbox}
                                    className="relative w-10 h-10 rounded-xl bg-white/[0.08] hover:bg-white/[0.12] border border-white/[0.12] flex items-center justify-center transition-all active:scale-95"
                                >
                                    <span className="text-xl">✉️</span>
                                    {unreadDMs > 0 && (
                                        <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] bg-gradient-to-r from-red-500 to-rose-500 rounded-full text-[10px] font-bold flex items-center justify-center px-1 shadow-lg shadow-red-500/30">
                                            {unreadDMs > 9 ? '9+' : unreadDMs}
                                        </span>
                                    )}
                                </button>
                            </>
                        )}
                        {view === 'messages' && (
                            <span className="text-[13px] text-white/20 tabular-nums">{messages.length} msgs</span>
                        )}
                        {view === 'dm_thread' && dmPartner && (
                            <button
                                onClick={() => setShowBlockConfirm(true)}
                                className="px-3 py-2 rounded-xl bg-white/[0.04] hover:bg-red-500/10 border border-white/[0.06] text-white/50 hover:text-red-400 text-xs font-medium transition-all active:scale-95"
                            >
                                {isUserBlocked ? '🔓 Unblock' : '🚫 Block'}
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* ═══════════ WELCOME BANNER ═══════════ */}
            {isFirstVisit && view === 'channels' && (
                <div className="mx-4 mt-3 fade-slide-down">
                    <div className="relative p-4 rounded-2xl overflow-hidden">
                        {/* Glassmorphism bg */}
                        <div className="absolute inset-0 bg-gradient-to-br from-sky-500/10 to-cyan-500/10 backdrop-blur-xl border border-sky-400/20 rounded-2xl" />
                        <div className="relative flex items-start justify-between">
                            <div>
                                <p className="text-sm font-bold text-sky-300 mb-1.5">Welcome aboard, sailor! ⛵</p>
                                <p className="text-[11px] text-white/60 leading-relaxed max-w-[280px]">
                                    Every expert was once a beginner. Tap <span className="inline-flex items-center gap-0.5 text-amber-400 font-semibold">🆘</span> to mark
                                    your message as a question — the crew will rally to help.
                                </p>
                                <div className="flex items-center gap-4 mt-3">
                                    {CREW_RANKS.slice(0, 4).map(r => (
                                        <span key={r.badge} className="text-[10px] text-white/50" title={r.title}>{r.badge} {r.title}</span>
                                    ))}
                                </div>
                            </div>
                            <button onClick={dismissWelcome} className="text-white/20 hover:text-white/50 ml-2 text-sm transition-colors">✕</button>
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
            <div className="flex-1 overflow-y-auto overscroll-contain">
                {loading && (
                    <div className="flex flex-col items-center justify-center py-20 gap-3">
                        <div className="relative">
                            <div className="w-8 h-8 border-2 border-sky-500/30 rounded-full" />
                            <div className="absolute inset-0 w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                        </div>
                        <span className="text-[13px] text-white/40">{loadingStatus}</span>
                    </div>
                )}
                {/* ══════ FIRST MATES ══════ */}
                {view === 'lonely_hearts' && !loading && (
                    <DatingSwipePage
                        onOpenDM={(userId, name) => {
                            openDMThread(userId, name);
                        }}
                    />
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
                    <div className="flex-1 flex flex-col px-5 py-4 gap-4 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 11rem)' }}>
                        {/* Avatar section */}
                        <div className="flex flex-col items-center gap-3">
                            <div className="w-24 h-24 rounded-3xl overflow-hidden border-2 border-violet-400/20 shadow-lg shadow-violet-500/10">
                                {myAvatarUrl ? (
                                    <img src={myAvatarUrl} alt="" className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full bg-gradient-to-br from-violet-500/10 to-sky-500/10 flex items-center justify-center">
                                        <span className="text-4xl opacity-40">🧑‍✈️</span>
                                    </div>
                                )}
                            </div>
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={!!uploadProgress}
                                    className="text-sm text-violet-400 hover:text-violet-300 font-medium transition-colors"
                                >
                                    {myAvatarUrl ? '🔄 Change Photo' : '📷 Upload Photo'}
                                </button>
                                {myAvatarUrl && (
                                    <button
                                        onClick={handleRemovePhoto}
                                        className="text-sm text-white/25 hover:text-red-400 transition-colors"
                                    >
                                        Remove
                                    </button>
                                )}
                            </div>
                            <p className="text-xs text-white/20">JPEG/PNG • Max 2MB • AI-moderated 🍺</p>
                        </div>

                        {/* Upload progress */}
                        {uploadProgress && (
                            <div className="p-3.5 rounded-2xl bg-sky-500/[0.06] border border-sky-500/10">
                                <div className="flex items-center gap-3">
                                    <div className="w-5 h-5 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                                    <span className="text-sm text-sky-400">{uploadProgress}</span>
                                </div>
                            </div>
                        )}

                        {/* Upload error */}
                        {uploadError && (
                            <div className="p-3.5 rounded-2xl bg-red-500/[0.06] border border-red-500/10">
                                <p className="text-sm text-red-400">❌ {uploadError}</p>
                            </div>
                        )}

                        {/* Display Name */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/50 block mb-2">Display Name</label>
                            <input
                                value={profileDisplayName}
                                onChange={e => setProfileDisplayName(e.target.value)}
                                placeholder="Captain Jack"
                                className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3.5 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-violet-500/30 transition-colors"
                                maxLength={30}
                            />
                            <p className="text-xs text-white/20 mt-1.5 px-1">This is how you appear in chat</p>
                        </div>

                        {/* Vessel Name */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/50 block mb-2">⛵ Vessel Name</label>
                            <input
                                value={profileVesselName}
                                onChange={e => setProfileVesselName(e.target.value)}
                                placeholder={settings.vessel?.name || 'Black Pearl'}
                                className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3.5 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-violet-500/30 transition-colors"
                                maxLength={40}
                            />
                        </div>


                        {/* Looking for Love toggle */}
                        <div className="flex items-center justify-between p-4 rounded-2xl bg-white/[0.02] border border-white/[0.04]">
                            <div className="flex items-center gap-3">
                                <span className="text-2xl">❤️</span>
                                <div>
                                    <p className="text-base font-semibold text-white/80">Looking for Love</p>
                                    <p className="text-xs text-white/50">Show the First Mates channel</p>
                                </div>
                            </div>
                            <button
                                onClick={() => {
                                    const newVal = !profileLookingForLove;
                                    setProfileLookingForLove(newVal);
                                    updateProfile({ looking_for_love: newVal });
                                }}
                                className={`relative w-14 h-8 rounded-full transition-colors duration-200 ${profileLookingForLove ? 'bg-gradient-to-r from-[#FF7F50] to-[#E9967A]' : 'bg-white/[0.08]'}`}
                            >
                                <div className={`absolute top-1 left-1 w-6 h-6 rounded-full bg-white shadow-md transition-transform duration-200 ${profileLookingForLove ? 'translate-x-6' : 'translate-x-0'}`} />
                            </button>
                        </div>

                        {/* Save button */}
                        <button
                            onClick={handleSaveProfile}
                            disabled={profileSaving}
                            className="w-full py-4 rounded-2xl bg-gradient-to-r from-violet-500/20 to-sky-500/20 hover:from-violet-500/30 hover:to-sky-500/30 text-base text-white/80 font-bold transition-all disabled:opacity-30 active:scale-[0.98]"
                        >
                            {profileSaved ? '✓ Saved!' : profileSaving ? 'Saving...' : '💾 Save Profile'}
                        </button>
                    </div>
                )}

                {/* ══════ CHANNEL LIST ══════ */}
                {view === 'channels' && !loading && (() => {
                    // Client-side icon overrides — fix duplicate wave icon and compass icon
                    const ICON_OVERRIDES: Record<string, string> = {
                        'SOLAS': '🛟',
                        'Safety': '🛟',
                        'Find Crew': '👥',
                        'Lonely Hearts': '💕',
                    };
                    const NAME_OVERRIDES: Record<string, string> = {
                        'Lonely Hearts': 'First Mates',
                    };
                    const getChannelIcon = (ch: { name: string; icon: string }) =>
                        ICON_OVERRIDES[ch.name] ?? ch.icon;
                    const getChannelName = (ch: { name: string }) =>
                        NAME_OVERRIDES[ch.name] ?? ch.name;

                    return (
                        <div className="px-4 py-3 pb-24 space-y-1.5">
                            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/20 px-1 mb-2">Channels</p>
                            {channels
                                .filter(ch => (ch.name !== 'First Mates' && ch.name !== 'Lonely Hearts') || profileLookingForLove)
                                .sort((a, b) => {
                                    const priority: Record<string, number> = { 'First Mates': 0, 'Lonely Hearts': 0, 'Find Crew': 1, 'General': 2 };
                                    return (priority[a.name] ?? 99) - (priority[b.name] ?? 99);
                                })
                                .map((ch, i) => (
                                    <button
                                        key={ch.id}
                                        onClick={() => openChannel(ch)}
                                        className="w-full group flex items-center gap-3.5 p-3.5 rounded-2xl bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.03] hover:border-white/[0.08] transition-all duration-200 active:scale-[0.98]"
                                        style={{ animationDelay: `${i * 40}ms` }}
                                    >
                                        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-white/[0.06] to-white/[0.02] border border-white/[0.05] flex items-center justify-center text-xl group-hover:scale-110 transition-transform duration-200">
                                            {getChannelIcon(ch)}
                                        </div>
                                        <div className="text-left flex-1 min-w-0">
                                            <p className="text-[17px] font-semibold text-white/85 group-hover:text-white transition-colors">{getChannelName(ch)}</p>
                                            <p className="text-[14px] text-white/50 truncate mt-0.5">{ch.description}</p>
                                        </div>
                                        <div className="w-6 h-6 rounded-full bg-white/[0.03] group-hover:bg-white/[0.06] flex items-center justify-center transition-all group-hover:translate-x-0.5">
                                            <span className="text-white/15 group-hover:text-white/40 text-xs transition-colors">›</span>
                                        </div>
                                    </button>
                                ))}

                            {/* Mod: Propose channel */}
                            {isMod && (
                                <div className="mt-4">
                                    {!showProposalForm ? (
                                        <button
                                            onClick={() => setShowProposalForm(true)}
                                            className="w-full p-3 rounded-2xl border border-dashed border-white/[0.06] hover:border-sky-500/20 hover:bg-sky-500/[0.03] text-center transition-all duration-200 active:scale-[0.98]"
                                        >
                                            <span className="text-[11px] text-white/25">➕ Propose a new channel</span>
                                        </button>
                                    ) : (
                                        <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/[0.06] space-y-3 fade-slide-down">
                                            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-sky-400/50">📋 Channel Proposal</p>
                                            <p className="text-[10px] text-white/25">Submitted to admins for approval</p>
                                            <div className="flex gap-2">
                                                <input value={proposalIcon} onChange={e => setProposalIcon(e.target.value)} placeholder="🏝️" className="w-12 bg-white/[0.04] border border-white/[0.06] rounded-lg px-2 py-1.5 text-center text-lg" maxLength={2} />
                                                <input value={proposalName} onChange={e => setProposalName(e.target.value)} placeholder="Channel name" className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-1.5 text-[12px] text-white placeholder:text-white/20 focus:outline-none focus:border-sky-500/30" />
                                            </div>
                                            <input value={proposalDesc} onChange={e => setProposalDesc(e.target.value)} placeholder="Short description" className="w-full bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-1.5 text-[12px] text-white placeholder:text-white/20 focus:outline-none focus:border-sky-500/30" />
                                            <div className="flex gap-2">
                                                <button onClick={() => setShowProposalForm(false)} className="flex-1 py-2 rounded-lg bg-white/[0.03] text-[11px] text-white/50 hover:bg-white/[0.06] transition-colors">Cancel</button>
                                                <button onClick={handleProposeChannel} disabled={!proposalName.trim()} className="flex-1 py-2 rounded-lg bg-sky-500/15 text-[11px] text-sky-400 hover:bg-sky-500/25 disabled:opacity-30 transition-colors">
                                                    {proposalSent ? '✓ Submitted!' : 'Submit for Review'}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                        </div>
                    );
                })()}

                {/* ══════ MESSAGE VIEW ══════ */}
                {view === 'messages' && !loading && (
                    <div className="flex flex-col min-h-full">
                        {/* Pinned bar */}
                        {pinnedMessages.length > 0 && (
                            <div className="mx-4 mt-2 p-3 rounded-xl bg-amber-500/[0.04] border border-amber-500/[0.08] fade-slide-down">
                                <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-amber-400/40 mb-1.5">📌 Pinned</p>
                                {pinnedMessages.map(pm => (
                                    <div key={pm.id} className="flex items-center gap-2 py-0.5">
                                        <span className="text-[16px] font-medium text-amber-300/70">{pm.display_name}:</span>
                                        <span className="text-[16px] text-white/50 truncate">{pm.message}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Messages list */}
                        <div className="flex-1 px-4 py-3 space-y-1">
                            {regularMessages.length === 0 && (
                                <div className="flex-1 flex flex-col items-center justify-center py-28">
                                    <div className="text-8xl mb-6 opacity-80">⛵</div>
                                    <p className="text-lg font-medium text-white/50">No messages yet</p>
                                    <p className="text-sm text-white/15 mt-2">Be the first to say ahoy!</p>
                                </div>
                            )}

                            {regularMessages.map((msg, i) => {
                                const isDeleted = !!msg.deleted_at;
                                const isSelf = msg.user_id === 'self';
                                const rank = getCrewRank(msg.helpful_count);

                                return (
                                    <div
                                        key={msg.id}
                                        className={`msg-enter group relative py-2 ${msg.is_question && !isDeleted ? 'question-glow bg-amber-500/[0.04] border border-amber-500/[0.08] rounded-2xl px-3 mx-[-4px] my-2' : ''
                                            }`}
                                        style={{ animationDelay: `${Math.min(i * 30, 300)}ms` }}
                                    >
                                        {/* Question header */}
                                        {msg.is_question && !isDeleted && (
                                            <div className="flex items-center gap-1.5 mb-2">
                                                <span className="text-[14px] font-bold text-amber-400/80 uppercase tracking-[0.15em]">📢 Question</span>
                                                {msg.helpful_count > 0 && (
                                                    <span className="text-[14px] text-emerald-400/50 ml-auto">{msg.helpful_count} found this helpful</span>
                                                )}
                                            </div>
                                        )}

                                        <div className="flex items-start gap-2.5">
                                            {/* Avatar — photo or gradient fallback */}
                                            <button
                                                onClick={() => !isSelf && openDMThread(msg.user_id, msg.display_name)}
                                                className={`w-12 h-12 rounded-xl overflow-hidden flex-shrink-0 shadow-lg hover:scale-105 transition-transform duration-150 ${!isSelf ? 'cursor-pointer' : 'cursor-default'}`}
                                                title={isSelf ? undefined : `DM ${msg.display_name}`}
                                            >
                                                {getAvatar(msg.user_id) ? (
                                                    <img src={getAvatar(msg.user_id)!} alt="" className="w-full h-full object-cover" />
                                                ) : (
                                                    <div className={`w-full h-full bg-gradient-to-br ${getAvatarGradient(msg.user_id)} flex items-center justify-center text-xs font-bold`}>
                                                        {msg.display_name.charAt(0).toUpperCase()}
                                                    </div>
                                                )}
                                            </button>

                                            <div className="flex-1 min-w-0">
                                                {/* Name row */}
                                                <div className="flex items-center gap-1.5 mb-0.5">
                                                    <span className={`text-[16px] font-bold ${isSelf ? 'text-sky-400' : 'text-white/80'}`}>{msg.display_name}</span>
                                                    {/* Rank badge */}
                                                    <button
                                                        className="relative"
                                                        onMouseEnter={() => setShowRankTooltip(msg.id)}
                                                        onMouseLeave={() => setShowRankTooltip(null)}
                                                        onClick={() => setShowRankTooltip(showRankTooltip === msg.id ? null : msg.id)}
                                                    >
                                                        <span className="text-[10px]">{rank.badge}</span>
                                                        {showRankTooltip === msg.id && (
                                                            <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-700 text-[9px] text-white/70 whitespace-nowrap z-10 shadow-xl">
                                                                {rank.title} • {msg.helpful_count} helpful
                                                            </span>
                                                        )}
                                                    </button>
                                                    {/* Mod badge */}
                                                    {isMod && msg.user_id !== 'self' && (
                                                        <span className="text-[10px] opacity-30">🛡️</span>
                                                    )}
                                                    <span className="text-[14px] text-white/20 ml-auto tabular-nums">{timeAgo(msg.created_at)}</span>
                                                </div>

                                                {/* Message body — rich cards for pins/tracks */}
                                                {isDeleted ? (
                                                    <p className="text-[15px] text-white/15 italic py-0.5">[removed by moderator]</p>
                                                ) : (() => {
                                                    const pin = parsePinMessage(msg.message);
                                                    const track = parseTrackMessage(msg.message);
                                                    if (pin) {
                                                        return (
                                                            <div className="mt-1.5 rounded-2xl overflow-hidden border border-white/[0.08] bg-white/[0.02] max-w-[280px]">
                                                                <img
                                                                    src={getStaticMapUrl(pin.lat, pin.lng)}
                                                                    alt="Pin location"
                                                                    className="w-full h-[140px] object-cover"
                                                                    loading="lazy"
                                                                />
                                                                <div className="px-3 py-2">
                                                                    <p className="text-[17px] text-white/70 font-medium leading-snug">{pin.caption}</p>
                                                                    <p className="text-[14px] text-white/25 mt-0.5 tabular-nums">
                                                                        📍 {Math.abs(pin.lat).toFixed(4)}°{pin.lat < 0 ? 'S' : 'N'}, {Math.abs(pin.lng).toFixed(4)}°{pin.lng < 0 ? 'W' : 'E'}
                                                                    </p>
                                                                </div>
                                                            </div>
                                                        );
                                                    }
                                                    if (track) {
                                                        const isImporting = importingTrackId === track.trackId;
                                                        return (
                                                            <button
                                                                onClick={() => setShowTrackDisclaimer(track)}
                                                                disabled={isImporting}
                                                                className="mt-1.5 rounded-2xl overflow-hidden border border-sky-500/[0.15] bg-gradient-to-r from-sky-500/[0.06] to-blue-500/[0.04] max-w-[280px] px-3 py-2.5 text-left w-full hover:from-sky-500/[0.12] hover:to-blue-500/[0.08] transition-all active:scale-[0.98] disabled:opacity-50"
                                                            >
                                                                <div className="flex items-center gap-2">
                                                                    <span className="text-lg">{isImporting ? '' : '🗺️'}</span>
                                                                    {isImporting && <div className="w-5 h-5 border-2 border-sky-400/30 rounded-full border-t-sky-400 animate-spin shrink-0" />}
                                                                    <div className="min-w-0 flex-1">
                                                                        <p className="text-[17px] text-sky-300/80 font-semibold truncate">{track.title}</p>
                                                                        <p className="text-[13px] text-white/25 mt-0.5">{isImporting ? 'Importing…' : 'Tap to import voyage track'}</p>
                                                                    </div>
                                                                    <span className="text-sky-400/30 text-sm">⬇</span>
                                                                </div>
                                                            </button>
                                                        );
                                                    }
                                                    return <p className="text-[18px] text-white/70 leading-relaxed break-words">{msg.message}</p>;
                                                })()}

                                                {/* Action row */}
                                                {!isDeleted && !isSelf && (
                                                    <div className="flex items-center gap-3 mt-1.5 h-6 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                                                        <button
                                                            onClick={() => handleMarkHelpful(msg.id)}
                                                            disabled={likedMessages.has(msg.id)}
                                                            className={`text-[15px] transition-colors flex items-center gap-1 active:scale-95 ${likedMessages.has(msg.id) ? 'text-emerald-400/70 cursor-default' : 'text-emerald-400/40 hover:text-emerald-400'}`}
                                                        >
                                                            {likedMessages.has(msg.id) ? '✅' : '👍'} Helpful{msg.helpful_count > 0 && ` (${msg.helpful_count})`}
                                                        </button>
                                                        <button
                                                            onClick={() => { setReportingMsg(msg); setReportSent(false); }}
                                                            className="text-[15px] text-white/10 hover:text-orange-400/60 transition-colors"
                                                        >
                                                            🚩 Report
                                                        </button>
                                                        {isMod && (
                                                            <button
                                                                onClick={() => setShowModMenu(showModMenu === msg.id ? null : msg.id)}
                                                                className="text-[11px] text-white/15 hover:text-red-400/60 transition-colors"
                                                            >
                                                                🛡️ Mod
                                                            </button>
                                                        )}
                                                    </div>
                                                )}

                                                {/* Mod menu */}
                                                {showModMenu === msg.id && isMod && (
                                                    <div className="mt-2 p-2.5 rounded-xl bg-slate-800/90 backdrop-blur-xl border border-white/[0.08] space-y-1 fade-slide-down shadow-2xl">
                                                        <button onClick={() => handleDeleteMessage(msg.id)} className="w-full text-left text-[11px] text-red-400/80 hover:bg-red-500/10 px-2.5 py-1.5 rounded-lg transition-colors">
                                                            🗑 Delete message
                                                        </button>
                                                        <button onClick={() => handlePinMessage(msg.id, msg.is_pinned)} className="w-full text-left text-[11px] text-amber-400/80 hover:bg-amber-500/10 px-2.5 py-1.5 rounded-lg transition-colors">
                                                            {msg.is_pinned ? '📌 Unpin' : '📌 Pin message'}
                                                        </button>
                                                        <div className="h-px bg-white/[0.04] my-1" />
                                                        <p className="text-[9px] text-white/20 px-2.5 uppercase tracking-wider">Mute {msg.display_name}</p>
                                                        <div className="flex gap-1 px-2">
                                                            {[{ hrs: 1, label: '1h' }, { hrs: 24, label: '24h' }, { hrs: 168, label: '7d' }].map(({ hrs, label }) => (
                                                                <button
                                                                    key={hrs}
                                                                    onClick={() => handleMuteUser(msg.user_id, hrs)}
                                                                    className="text-[10px] text-orange-400/70 hover:bg-orange-500/10 px-2.5 py-1 rounded-lg border border-orange-500/10 transition-colors"
                                                                >
                                                                    {label}
                                                                </button>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                            <div ref={messageEndRef} />
                        </div>
                    </div>
                )}

                {/* ══════ DM INBOX ══════ */}
                {view === 'dm_inbox' && !loading && (
                    <div className="px-4 py-3 space-y-1.5">
                        {dmConversations.length === 0 && (
                            <div className="text-center py-20">
                                <div className="text-5xl mb-4 opacity-60">✉️</div>
                                <p className="text-sm font-medium text-white/50">No conversations yet</p>
                                <p className="text-[11px] text-white/15 mt-1.5 max-w-[200px] mx-auto">
                                    Tap someone's avatar in a channel to start a direct message
                                </p>
                            </div>
                        )}
                        {dmConversations.map((conv, i) => (
                            <button
                                key={conv.user_id}
                                onClick={() => openDMThread(conv.user_id, conv.display_name)}
                                className="w-full flex items-center gap-3 p-3.5 rounded-2xl bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.03] hover:border-white/[0.08] transition-all duration-200 active:scale-[0.98] msg-enter"
                                style={{ animationDelay: `${i * 50}ms` }}
                            >
                                <div className={`w-11 h-11 rounded-xl bg-gradient-to-br ${getAvatarGradient(conv.user_id)} flex items-center justify-center text-sm font-bold flex-shrink-0 shadow-lg`}>
                                    {conv.display_name.charAt(0).toUpperCase()}
                                </div>
                                <div className="text-left flex-1 min-w-0">
                                    <div className="flex items-center justify-between mb-0.5">
                                        <p className="text-[13px] font-semibold text-white/85">{conv.display_name}</p>
                                        <span className="text-[10px] text-white/15 tabular-nums">{timeAgo(conv.last_at)}</span>
                                    </div>
                                    <p className="text-[11px] text-white/50 truncate">{conv.last_message}</p>
                                </div>
                                {conv.unread_count > 0 && (
                                    <span className="min-w-[20px] h-5 rounded-full bg-gradient-to-r from-sky-500 to-blue-500 text-[10px] font-bold flex items-center justify-center px-1.5 flex-shrink-0 shadow-lg shadow-sky-500/20">
                                        {conv.unread_count}
                                    </span>
                                )}
                            </button>
                        ))}
                    </div>
                )}

                {/* ══════ DM THREAD ══════ */}
                {view === 'dm_thread' && !loading && (
                    <div className="flex flex-col min-h-full">
                        <div className="flex-1 px-4 py-3 space-y-2">
                            {dmThread.length === 0 && (
                                <div className="text-center py-20">
                                    <p className="text-3xl mb-3 opacity-60">👋</p>
                                    <p className="text-sm text-white/50">Say ahoy to {dmPartner?.name}!</p>
                                </div>
                            )}
                            {dmThread.map((dm, i) => {
                                const isSelf = dm.sender_id === 'self';
                                return (
                                    <div
                                        key={dm.id}
                                        className={`flex ${isSelf ? 'justify-end' : 'justify-start'} msg-enter`}
                                        style={{ animationDelay: `${Math.min(i * 25, 200)}ms` }}
                                    >
                                        <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${isSelf
                                            ? 'bg-gradient-to-br from-sky-500/15 to-blue-500/15 border border-sky-500/15 rounded-br-lg'
                                            : 'bg-white/[0.04] border border-white/[0.04] rounded-bl-lg'
                                            }`}>
                                            <p className="text-[13px] text-white/70 leading-relaxed">{dm.message}</p>
                                            <p className="text-[9px] text-white/15 mt-1 tabular-nums">{timeAgo(dm.created_at)}</p>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>

            {/* ═══════════ REPORT MODAL ═══════════ */}
            {reportingMsg && (
                <div className="absolute inset-0 z-50 flex items-center justify-center" onClick={() => setReportingMsg(null)}>
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
                    <div className="relative w-[85%] max-w-sm p-5 rounded-2xl bg-slate-900/95 border border-white/[0.08] shadow-2xl fade-slide-down" onClick={e => e.stopPropagation()}>
                        {reportSent ? (
                            <div className="text-center py-6">
                                <div className="text-4xl mb-3">✅</div>
                                <p className="text-sm font-medium text-white/70">Report submitted</p>
                                <p className="text-[11px] text-white/50 mt-1">Our moderators will review it shortly</p>
                            </div>
                        ) : (
                            <>
                                <p className="text-sm font-bold text-white/80 mb-1">🚩 Report Message</p>
                                <p className="text-[11px] text-white/50 mb-4 truncate">From {reportingMsg.display_name}: "{reportingMsg.message.substring(0, 50)}"</p>
                                <div className="space-y-1.5 mb-4">
                                    {(['spam', 'harassment', 'hate_speech', 'inappropriate', 'other'] as const).map(r => (
                                        <button
                                            key={r}
                                            onClick={() => setReportReason(r)}
                                            className={`w-full text-left px-3 py-2 rounded-xl text-[12px] transition-all ${reportReason === r
                                                ? 'bg-orange-500/10 border border-orange-500/20 text-orange-400'
                                                : 'bg-white/[0.02] border border-white/[0.04] text-white/40 hover:bg-white/[0.04]'
                                                }`}
                                        >
                                            {r === 'spam' && '📧 Spam'}
                                            {r === 'harassment' && '😡 Harassment'}
                                            {r === 'hate_speech' && '🚫 Hate Speech'}
                                            {r === 'inappropriate' && '⚠️ Inappropriate'}
                                            {r === 'other' && '📋 Other'}
                                        </button>
                                    ))}
                                </div>
                                <div className="flex gap-2">
                                    <button onClick={() => setReportingMsg(null)} className="flex-1 py-2.5 rounded-xl bg-white/[0.03] text-[12px] text-white/50 hover:bg-white/[0.06] transition-colors">Cancel</button>
                                    <button onClick={handleReport} className="flex-1 py-2.5 rounded-xl bg-orange-500/15 text-[12px] text-orange-400 font-medium hover:bg-orange-500/25 transition-colors">Submit Report</button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* ═══════════ DROP A PIN (static map) ═══════════ */}
            {showPinSheet && view === 'messages' && (
                <div className="flex-shrink-0 border-t border-white/[0.06] bg-[#0c1425] px-4 py-3">
                    <div className="flex items-center justify-between mb-2">
                        <h3 className="text-[15px] font-bold text-white/80">📍 Drop a Pin</h3>
                        <button
                            onClick={() => setShowPinSheet(false)}
                            className="text-white/50 hover:text-white/60 text-lg transition-colors px-2"
                        >✕</button>
                    </div>

                    {pinLoading ? (
                        <div className="flex items-center justify-center py-6">
                            <div className="w-5 h-5 border-2 border-sky-500/30 rounded-full border-t-sky-500 animate-spin" />
                            <span className="ml-3 text-[14px] text-white/50">Getting GPS...</span>
                        </div>
                    ) : (
                        <>
                            {/* Recent pins */}
                            {savedPins.length > 0 && (
                                <div className="mb-2">
                                    <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/25 mb-1.5">📌 Recent Pins</p>
                                    <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1" style={{ scrollbarWidth: 'none' }}>
                                        {savedPins.map(sp => (
                                            <button
                                                key={sp.id}
                                                onClick={() => {
                                                    setPinLat(sp.latitude);
                                                    setPinLng(sp.longitude);
                                                    setPinCaption(sp.caption);
                                                }}
                                                className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.08] transition-all active:scale-95"
                                            >
                                                <span className="text-sm">📍</span>
                                                <div className="text-left">
                                                    <p className="text-[12px] text-white/60 font-medium truncate max-w-[140px]">{sp.caption}</p>
                                                    <p className="text-[10px] text-white/20 tabular-nums">{PinService.formatCoords(sp.latitude, sp.longitude)}</p>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Static map preview */}
                            <div className="w-full h-[120px] rounded-xl overflow-hidden border border-white/[0.08] mb-2">
                                <img
                                    src={getStaticMapUrl(pinLat, pinLng)}
                                    alt="Pin location"
                                    className="w-full h-full object-cover"
                                    loading="eager"
                                />
                            </div>
                            <p className="text-[11px] text-white/25 mb-2 text-center tabular-nums">
                                📍 {Math.abs(pinLat).toFixed(4)}°{pinLat < 0 ? 'S' : 'N'}, {Math.abs(pinLng).toFixed(4)}°{pinLng < 0 ? 'W' : 'E'}
                            </p>

                            {/* Caption + send */}
                            <div className="flex items-center gap-2">
                                <input
                                    type="text"
                                    value={pinCaption}
                                    onChange={e => setPinCaption(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && sendPin()}
                                    placeholder="What's here? (e.g. Great anchorage)"
                                    className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded-xl px-3 py-2.5 text-[15px] text-white placeholder:text-white/20 focus:outline-none focus:border-sky-500/30 transition-colors"
                                    maxLength={120}
                                />
                                <button
                                    onClick={sendPin}
                                    className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-sky-500/20 to-blue-500/20 hover:from-sky-500/30 hover:to-blue-500/30 text-[14px] text-white/80 font-bold transition-all active:scale-95 whitespace-nowrap"
                                >
                                    📍 Drop
                                </button>
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* ═══════════ SHARE POI (interactive Mapbox GL) ═══════════ */}
            {showPoiSheet && view === 'messages' && (
                <div className="flex-shrink-0 border-t border-white/[0.06] bg-[#0c1425] px-4 py-3">
                    <div className="flex items-center justify-between mb-2">
                        <h3 className="text-[15px] font-bold text-white/80">🗺️ Share Point of Interest</h3>
                        <button
                            onClick={() => setShowPoiSheet(false)}
                            className="text-white/50 hover:text-white/60 text-lg transition-colors px-2"
                        >✕</button>
                    </div>

                    {pinLoading ? (
                        <div className="flex items-center justify-center py-6">
                            <div className="w-5 h-5 border-2 border-sky-500/30 rounded-full border-t-sky-500 animate-spin" />
                            <span className="ml-3 text-[14px] text-white/50">Getting GPS...</span>
                        </div>
                    ) : (
                        <>
                            {/* Interactive Mapbox GL map */}
                            <div
                                ref={poiMapRef}
                                className="w-full h-[200px] rounded-xl overflow-hidden border border-white/[0.08] mb-2"
                            />
                            <p className="text-[11px] text-white/25 mb-2 text-center tabular-nums">
                                📍 {Math.abs(pinLat).toFixed(4)}°{pinLat < 0 ? 'S' : 'N'}, {Math.abs(pinLng).toFixed(4)}°{pinLng < 0 ? 'W' : 'E'}
                                <span className="ml-2 text-white/15">• Tap or drag to set location</span>
                            </p>

                            {/* Caption + send */}
                            <div className="flex items-center gap-2">
                                <input
                                    type="text"
                                    value={pinCaption}
                                    onChange={e => setPinCaption(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && sendPoi()}
                                    placeholder="Describe this spot..."
                                    className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded-xl px-3 py-2.5 text-[15px] text-white placeholder:text-white/20 focus:outline-none focus:border-sky-500/30 transition-colors"
                                    maxLength={120}
                                />
                                <button
                                    onClick={sendPoi}
                                    className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500/20 to-teal-500/20 hover:from-emerald-500/30 hover:to-teal-500/30 text-[14px] text-white/80 font-bold transition-all active:scale-95 whitespace-nowrap"
                                >
                                    🗺️ Share
                                </button>
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* ═══════════ SHARE TRACK PICKER ═══════════ */}
            {showTrackPicker && view === 'messages' && (
                <div className="flex-shrink-0 border-t border-white/[0.06] bg-[#0c1425] px-4 py-3 max-h-[320px] overflow-hidden">
                    <div className="flex items-center justify-between mb-2">
                        <h3 className="text-[15px] font-bold text-white/80">⛵ Share a Voyage</h3>
                        <button
                            onClick={() => setShowTrackPicker(false)}
                            className="text-white/50 hover:text-white/60 text-lg transition-colors px-2"
                        >✕</button>
                    </div>

                    {trackLoadingVoyages ? (
                        <div className="flex items-center justify-center py-8">
                            <div className="w-5 h-5 border-2 border-sky-500/30 rounded-full border-t-sky-500 animate-spin" />
                            <span className="ml-3 text-[14px] text-white/50">Loading voyages...</span>
                        </div>
                    ) : voyageList.length === 0 ? (
                        <div className="text-center py-8">
                            <p className="text-xl mb-2">🚫</p>
                            <p className="text-[14px] text-white/40 font-medium">No voyages to share</p>
                            <p className="text-[12px] text-white/20 mt-1">Record a voyage first using the Ship's Log</p>
                        </div>
                    ) : (
                        <div className="space-y-2 overflow-y-auto max-h-[240px] pb-1" style={{ scrollbarWidth: 'thin' }}>
                            {voyageList.map(v => {
                                const start = new Date(v.startTime);
                                const end = new Date(v.endTime);
                                const dateStr = start.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
                                const durationHrs = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60) * 10) / 10;
                                return (
                                    <div
                                        key={v.voyageId}
                                        className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.06] transition-all"
                                    >
                                        <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500/15 to-blue-500/15 flex items-center justify-center">
                                            <span className="text-lg">⛵</span>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-[14px] text-white/70 font-medium truncate">{dateStr}</p>
                                            <p className="text-[11px] text-white/50 tabular-nums">
                                                {v.distance}nm · {v.entryCount} pts · {durationHrs}h
                                            </p>
                                        </div>
                                        <button
                                            onClick={() => sendTrack(v)}
                                            disabled={trackSharing}
                                            className="flex-shrink-0 px-3 py-1.5 rounded-lg bg-gradient-to-r from-teal-500/15 to-emerald-500/15 hover:from-teal-500/25 hover:to-emerald-500/25 text-[12px] text-teal-400/80 font-bold transition-all active:scale-95 disabled:opacity-40"
                                        >
                                            {trackSharing ? (
                                                <div className="w-4 h-4 border-2 border-teal-500/30 rounded-full border-t-teal-500 animate-spin" />
                                            ) : '⛵ Share'}
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* ═══════════════════ COMPOSE BAR ═══════════════════ */}
            {view === 'messages' && (
                <div className="flex-shrink-0 relative">
                    <div className="absolute inset-0 bg-gradient-to-t from-[#050a18] via-[#050a18]/95 to-transparent" />
                    <div className={`relative px-4 pt-2 ${keyboardOffset > 0 ? 'pb-2' : 'pb-[calc(4.5rem+env(safe-area-inset-bottom))]'}`}>
                        {/* Client filter warning */}
                        {filterWarning && (
                            <div className="mb-2 p-3 rounded-xl bg-amber-500/[0.06] border border-amber-500/[0.12] fade-slide-down">
                                <p className="text-[11px] text-amber-400/80 mb-2">⚠️ {filterWarning.warning}</p>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => { setFilterWarning(null); setMessageText(''); }}
                                        className="flex-1 py-1.5 rounded-lg bg-white/[0.03] text-[10px] text-white/50 hover:bg-white/[0.06] transition-colors"
                                    >
                                        Edit message
                                    </button>
                                    {!filterWarning.blocked && (
                                        <button
                                            onClick={() => sendChannelMessage(true)}
                                            className="flex-1 py-1.5 rounded-lg bg-amber-500/10 text-[10px] text-amber-400 hover:bg-amber-500/20 transition-colors"
                                        >
                                            Send anyway
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}

                        {isMuted ? (
                            <div className="flex items-center justify-center gap-2 py-2 rounded-xl bg-red-500/[0.04] border border-red-500/[0.06]">
                                <span className="text-[11px] text-red-400/50">🔇 Muted until {mutedUntil?.toLocaleTimeString()}</span>
                            </div>
                        ) : (
                            <div className="flex items-center gap-2">
                                {/* ➕ Attach button */}
                                <div className="relative">
                                    <button
                                        onClick={() => setShowAttachMenu(!showAttachMenu)}
                                        className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg transition-all duration-200 flex-shrink-0 active:scale-90 ${showAttachMenu
                                            ? 'bg-sky-500/15 border border-sky-500/25 rotate-45'
                                            : 'bg-white/[0.03] border border-white/[0.04] hover:bg-white/[0.06]'
                                            }`}
                                        title="Share pin or track"
                                    >
                                        <span className={`transition-transform duration-200 ${showAttachMenu ? 'rotate-45' : ''}`}>➕</span>
                                    </button>

                                    {/* Attach menu flyout */}
                                    {showAttachMenu && (
                                        <>
                                            <div className="fixed inset-0 z-40" onClick={() => setShowAttachMenu(false)} />
                                            <div className="absolute bottom-12 left-0 z-50 w-52 rounded-2xl bg-slate-900/98 border border-white/[0.1] shadow-2xl overflow-hidden fade-slide-down">
                                                <button
                                                    onClick={openPinDrop}
                                                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.06] transition-colors text-left"
                                                >
                                                    <span className="text-lg">📍</span>
                                                    <div>
                                                        <p className="text-[14px] text-white/80 font-medium">Drop a Pin</p>
                                                        <p className="text-[11px] text-white/50">Share your location</p>
                                                    </div>
                                                </button>
                                                <div className="h-px bg-white/[0.06]" />
                                                <button
                                                    onClick={openPoiPicker}
                                                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.06] transition-colors text-left"
                                                >
                                                    <span className="text-lg">🗺️</span>
                                                    <div>
                                                        <p className="text-[14px] text-white/80 font-medium">Share POI</p>
                                                        <p className="text-[11px] text-white/50">Browse & pick any spot</p>
                                                    </div>
                                                </button>
                                                <div className="h-px bg-white/[0.06]" />
                                                <button
                                                    onClick={openTrackPicker}
                                                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.06] transition-colors text-left"
                                                >
                                                    <span className="text-lg">⛵</span>
                                                    <div>
                                                        <p className="text-[14px] text-white/80 font-medium">Share Track</p>
                                                        <p className="text-[11px] text-white/50">Share a voyage</p>
                                                    </div>
                                                </button>
                                            </div>
                                        </>
                                    )}
                                </div>
                                <button
                                    onClick={() => setIsQuestion(!isQuestion)}
                                    className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm transition-all duration-200 flex-shrink-0 active:scale-90 ${isQuestion
                                        ? 'bg-amber-500/15 border border-amber-500/25 shadow-lg shadow-amber-500/10'
                                        : 'bg-white/[0.03] border border-white/[0.04] hover:bg-white/[0.06]'
                                        }`}
                                    title="Mark as question — questions get priority"
                                >
                                    📢
                                </button>
                                <div className="flex-1 relative">
                                    <input
                                        ref={inputRef}
                                        type="text"
                                        value={messageText}
                                        onChange={(e) => { setMessageText(e.target.value); setFilterWarning(null); }}
                                        onKeyDown={(e) => e.key === 'Enter' && sendChannelMessage()}
                                        placeholder={isQuestion ? 'Ask the crew anything...' : 'Message...'}
                                        className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl px-4 py-3 text-[17px] text-white placeholder:text-white/20 focus:outline-none focus:border-sky-500/30 focus:bg-white/[0.06] transition-all duration-200"
                                    />
                                </div>
                                <button
                                    onClick={() => sendChannelMessage()}
                                    disabled={!messageText.trim()}
                                    className="w-10 h-10 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500 disabled:from-white/[0.03] disabled:to-white/[0.03] disabled:border disabled:border-white/[0.04] flex items-center justify-center transition-all duration-200 active:scale-90 disabled:active:scale-100 shadow-lg shadow-sky-500/20 disabled:shadow-none"
                                >
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={messageText.trim() ? 'text-white' : 'text-white/15'}>
                                        <path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" />
                                    </svg>
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* DM compose */}
            {view === 'dm_thread' && (
                <div className="flex-shrink-0 relative">
                    <div className="absolute inset-0 bg-gradient-to-t from-[#050a18] via-[#050a18]/95 to-transparent" />
                    <div className={`relative px-4 py-3 ${keyboardOffset > 0 ? 'pb-2' : 'pb-[max(0.75rem,env(safe-area-inset-bottom))]'}`}>
                        {/* Block confirmation dialog */}
                        {showBlockConfirm && (
                            <div className="mb-3 p-4 rounded-2xl bg-red-500/5 border border-red-400/15">
                                <p className="text-sm text-white/60 mb-3">
                                    {isUserBlocked
                                        ? `Unblock ${dmPartner?.name}? They'll be able to DM you again.`
                                        : `Block ${dmPartner?.name}? They won't be able to send you DMs.`
                                    }
                                </p>
                                <div className="flex gap-2">
                                    <button
                                        onClick={isUserBlocked ? handleUnblockUser : handleBlockUser}
                                        className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all active:scale-95 ${isUserBlocked
                                            ? 'bg-green-500/15 text-green-300 border border-green-400/20'
                                            : 'bg-red-500/15 text-red-300 border border-red-400/20'
                                            }`}
                                    >
                                        {isUserBlocked ? '🔓 Unblock' : '🚫 Block'}
                                    </button>
                                    <button
                                        onClick={() => setShowBlockConfirm(false)}
                                        className="flex-1 py-2.5 rounded-xl bg-white/[0.04] text-white/40 text-sm font-medium border border-white/[0.06] transition-all active:scale-95"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Blocked state */}
                        {isUserBlocked && !showBlockConfirm ? (
                            <div className="flex items-center justify-between py-2">
                                <p className="text-xs text-red-300/50">🚫 This user is blocked</p>
                                <button
                                    onClick={() => setShowBlockConfirm(true)}
                                    className="text-xs text-white/25 hover:text-green-300/60 transition-colors"
                                >
                                    Unblock
                                </button>
                            </div>
                        ) : !showBlockConfirm && (
                            <div className="flex items-center gap-2">
                                <input
                                    type="text"
                                    value={dmText}
                                    onChange={(e) => setDmText(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && sendDMMessage()}
                                    placeholder={`Message ${dmPartner?.name || ''}...`}
                                    className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded-xl px-4 py-2.5 text-[13px] text-white placeholder:text-white/20 focus:outline-none focus:border-violet-500/30 focus:bg-white/[0.06] transition-all duration-200"
                                />
                                <button
                                    onClick={sendDMMessage}
                                    disabled={!dmText.trim()}
                                    className="w-10 h-10 rounded-xl bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-400 hover:to-purple-500 disabled:from-white/[0.03] disabled:to-white/[0.03] disabled:border disabled:border-white/[0.04] flex items-center justify-center transition-all duration-200 active:scale-90 disabled:active:scale-100 shadow-lg shadow-violet-500/20 disabled:shadow-none"
                                >
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={dmText.trim() ? 'text-white' : 'text-white/15'}>
                                        <path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" />
                                    </svg>
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ═══════════ TRACK IMPORT DISCLAIMER MODAL ═══════════ */}
            {showTrackDisclaimer && (
                <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm p-6" onClick={() => setShowTrackDisclaimer(null)}>
                    <div className="w-full max-w-sm bg-slate-900/95 backdrop-blur-xl border border-white/[0.08] rounded-2xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
                        <div className="px-5 pt-5 pb-3">
                            <div className="flex items-center gap-2 mb-3">
                                <span className="text-amber-400 text-lg">⚠️</span>
                                <h2 className="text-base font-black text-white">Navigation Disclaimer</h2>
                            </div>
                            <div className="bg-amber-900/20 border border-amber-500/20 rounded-xl px-3 py-2.5 mb-3">
                                <p className="text-[13px] text-amber-400/80 leading-relaxed">
                                    This track was shared by another sailor and is <span className="font-bold text-amber-300">not verified</span>. Depths vary with tide, weather, and vessel draft. <span className="font-bold text-amber-300">Not suitable for navigation.</span>
                                </p>
                            </div>
                            <p className="text-[13px] text-white/40 leading-relaxed">
                                It will be imported to your ship's log as a community track with an <span className="text-amber-400 font-bold">Imported</span> badge.
                            </p>
                        </div>
                        <div className="px-5 pb-5 flex gap-2 pt-2">
                            <button
                                onClick={() => setShowTrackDisclaimer(null)}
                                className="flex-1 py-2.5 rounded-xl bg-white/[0.05] border border-white/[0.08] text-white/50 text-sm font-bold transition-all active:scale-95"
                            >Cancel</button>
                            <button
                                onClick={() => handleImportTrack(showTrackDisclaimer!.trackId, showTrackDisclaimer!.title)}
                                className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-sky-600 to-blue-600 text-white text-sm font-bold transition-all active:scale-95 shadow-lg shadow-sky-500/20"
                            >⬇ Import Track</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══════════ TRACK IMPORT STATUS TOAST ═══════════ */}
            {trackImportStatus && (
                <div className="fixed bottom-28 left-1/2 -translate-x-1/2 z-[9998] px-5 py-3 rounded-xl shadow-2xl border max-w-[320px] text-center"
                    style={{
                        background: trackImportStatus!.startsWith('✅') ? 'rgba(6,78,59,0.95)' : 'rgba(127,29,29,0.95)',
                        borderColor: trackImportStatus!.startsWith('✅') ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)',
                        backdropFilter: 'blur(12px)',
                    }}>
                    <p className={`text-sm font-bold ${trackImportStatus!.startsWith('✅') ? 'text-emerald-300' : 'text-red-300'}`}>
                        {trackImportStatus}
                    </p>
                </div>
            )}
        </div>
    );
};

export default ChatPage;
