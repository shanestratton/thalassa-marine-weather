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

import React, { useState, useRef, useEffect, useCallback, Suspense as _Suspense } from 'react';
import { createLogger } from '../utils/createLogger';
import { lazyRetry } from '../utils/lazyRetry';

const log = createLogger('ChatPage');
import { ChatService, ChatChannel, DEFAULT_CHANNELS } from '../services/ChatService';
import { reportMessage } from '../services/ContentModerationService';
const LonelyHeartsPage = lazyRetry(
    () => import('./LonelyHeartsPage').then((m) => ({ default: m.LonelyHeartsPage })),
    'LonelyHeartsPage',
);

import { ConfirmDialog } from './ui/ConfirmDialog';
import { toast } from './Toast';
import { useSettings } from '../context/SettingsContext';
import { moderateMessage } from '../services/ContentModerationService';
const MarketplacePage = lazyRetry(
    () => import('./MarketplacePage').then((m) => ({ default: m.MarketplacePage })),
    'MarketplacePage',
);
const AdminPanel = lazyRetry(() => import('./AdminPanel').then((m) => ({ default: m.AdminPanel })), 'AdminPanel_Chat');
import { ChannelList } from './chat/ChannelList';
import { ChatMessageList } from './chat/ChatMessageList';
import { ChatComposer } from './chat/ChatComposer';
import { ChatProfileView } from './chat/ChatProfileView';
import { ChatHeader } from './chat/ChatHeader';
import { ChatDMInbox, ChatDMThread, ChatDMCompose } from './chat/ChatDMView';
import {
    ReportModal,
    PinDropSheet,
    PoiPickerSheet,
    TrackPickerSheet,
    TrackDisclaimerModal,
} from './chat/ChatAttachmentSheets';
import { SkeletonChannelList, SkeletonMessageList } from './ui/Skeleton';
import { ChatErrorBoundary } from './chat/ChatErrorBoundary';
import { MaritimeIntelCard } from './chat/MaritimeIntelCard';
import { triggerHaptic } from '../utils/system';
import { TypingIndicator } from './chat/TypingIndicator';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { useChatMessages } from '../hooks/chat/useChatMessages';
import { useChatDMs } from '../hooks/chat/useChatDMs';
import { usePinDrop } from '../hooks/chat/usePinDrop';
import { useTrackSharing } from '../hooks/chat/useTrackSharing';
import { useChatProfile } from '../hooks/chat/useChatProfile';
import { useChatProposals } from '../hooks/chat/useChatProposals';

import { CREW_RANKS } from './chat/chatUtils';

// --- TYPES ---
type ChatView =
    | 'channels'
    | 'messages'
    | 'dm_inbox'
    | 'dm_thread'
    | 'profile'
    | 'find_crew'
    | 'marketplace'
    | 'admin_panel';

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
export const ChatPage: React.FC = React.memo(() => {
    const { settings } = useSettings();

    // View state
    const [view, setView] = useState<ChatView>('channels');
    const [navDirection, setNavDirection] = useState<'forward' | 'back'>('forward');
    const [channels, setChannels] = useState<ChatChannel[]>([]);

    // Loading — must be declared before hooks since they receive setLoading
    const [loading, setLoading] = useState(true);
    const [loadingStatus, _setLoadingStatus] = useState<string | null>(null); // Connecting to Crew Talk…

    // --- Extracted Hooks ---
    const chatMessages = useChatMessages({ setView: setView as (v: string) => void, setNavDirection, setLoading });
    const {
        messages,
        setMessages,
        activeChannel,
        setActiveChannel,
        messageText,
        setMessageText,
        isQuestion,
        setIsQuestion,
        filterWarning,
        setFilterWarning,
        showModMenu,
        setShowModMenu,
        showRankTooltip,
        setShowRankTooltip,
        avatarMap,
        pinnedMessages,
        likedMessages,
        messageEndRef,
        openChannel,
        sendChannelMessage,
        handleMarkHelpful,
        handleDeleteMessage,
        handlePinMessage,
        handleMuteUser,
        cleanup: cleanupMessages,
    } = chatMessages;

    const chatDMs = useChatDMs({ setView: setView as (v: string) => void, setNavDirection, setLoading });
    const {
        dmConversations,
        dmThread,
        dmPartner,
        setDmPartner,
        dmText,
        setDmText,
        isUserBlocked,
        showBlockConfirm,
        setShowBlockConfirm,
        unreadDMs,
        subscribe: subscribeDMs,
        openDMInbox,
        openDMThread,
        sendDMMessage,
        handleBlockUser,
        handleUnblockUser,
        loadUnreadCount,
    } = chatDMs;

    // Mod
    const [isFirstVisit, setIsFirstVisit] = useState(true);

    // Role checks — reactive state that updates after ChatService.initialize()
    const [isMod, setIsMod] = useState(() => ChatService.isMod());
    const [isAdmin, setIsAdmin] = useState(() => ChatService.isAdmin());
    const [isModerator, setIsModerator] = useState(() => ChatService.isModerator());
    const [isMuted, setIsMuted] = useState(() => ChatService.isMuted());
    const [mutedUntil, setMutedUntil] = useState(() => ChatService.getMutedUntil());

    /** Re-read roles from ChatService and update state */
    const refreshRoles = useCallback(() => {
        setIsMod(ChatService.isMod());
        setIsAdmin(ChatService.isAdmin());
        setIsModerator(ChatService.isModerator());
        setIsMuted(ChatService.isMuted());
        setMutedUntil(ChatService.getMutedUntil());
    }, []);

    // --- Extracted Hook: Proposals + Private Channels + Report ---
    const proposalHook = useChatProposals({ channels, setChannels, isAdmin });
    const {
        showProposalForm,
        setShowProposalForm,
        proposalName,
        setProposalName,
        proposalDesc,
        setProposalDesc,
        proposalIcon,
        setProposalIcon,
        proposalSent,
        proposalIsPrivate,
        setProposalIsPrivate,
        proposalParentId,
        setProposalParentId,
        memberChannelIds,
        joinRequestChannel,
        setJoinRequestChannel,
        joinRequestMessage,
        setJoinRequestMessage,
        joinRequestSent,
        reportingMsg,
        setReportingMsg,
        reportReason,
        setReportReason,
        reportSent,
        setReportSent,
        handleProposeChannel,
        handleRequestAccess,
        handleSubmitJoinRequest,
    } = proposalHook;

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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeChannel?.id]);
    useEffect(() => {
        // Only track keyboard when compose bar is visible
        if (view !== 'messages' && view !== 'dm_thread') {
            setKeyboardOffset(0);
            return;
        }

        let kbShowHandle: Promise<{ remove: () => void }> | undefined;
        let kbHideHandle: Promise<{ remove: () => void }> | undefined;
        let usingNativePlugin = false;

        // Try Capacitor Keyboard plugin first (accurate on native iOS)
        import('@capacitor/keyboard')
            .then(({ Keyboard }) => {
                usingNativePlugin = true;
                kbShowHandle = Keyboard.addListener('keyboardWillShow', (info) => {
                    setKeyboardOffset(info.keyboardHeight > 0 ? info.keyboardHeight : 0);
                });
                kbHideHandle = Keyboard.addListener('keyboardWillHide', () => {
                    setKeyboardOffset(0);
                });
            })
            .catch(() => {
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

                window.__chatKbCleanup = () => {
                    vv.removeEventListener('resize', handleResize);
                    vv.removeEventListener('scroll', handleResize);
                };
            });

        return () => {
            if (usingNativePlugin) {
                kbShowHandle?.then((h) => h.remove());
                kbHideHandle?.then((h) => h.remove());
            }

            window.__chatKbCleanup?.();

            delete window.__chatKbCleanup;
        };
    }, [view]);

    // --- Extracted Hook: Profile ---
    const profileHook = useChatProfile({ avatarMap, setView: setView as (v: string) => void });
    const {
        myAvatarUrl,
        uploadProgress,
        uploadError,
        fileInputRef,
        profileDisplayName,
        setProfileDisplayName,
        profileVesselName,
        setProfileVesselName,
        profileSaving,
        profileSaved,
        loadProfile,
        handleFileSelect,
        handleRemovePhoto,
        handleSaveProfile,
        getAvatar,
    } = profileHook;

    // --- Extracted Hooks: Pin Drop + Track Sharing ---
    const pinDrop = usePinDrop({ activeChannel, setMessages, setMessageText, messageEndRef });
    const {
        showAttachMenu,
        setShowAttachMenu,
        showPinSheet,
        setShowPinSheet,
        showPoiSheet,
        setShowPoiSheet,
        pinLat,
        setPinLat,
        pinLng,
        setPinLng,
        pinCaption,
        setPinCaption,
        pinLoading,
        savedPins,
        poiMapRef,
        openPinDrop,
        sendPin,
        openPoiPicker,
        sendPoi,
    } = pinDrop;

    const trackSharingHook = useTrackSharing({ activeChannel, setMessages, messageEndRef, setShowAttachMenu });
    const {
        showTrackPicker,
        setShowTrackPicker,
        voyageList,
        trackSharing: isTrackSharing,
        trackLoadingVoyages,
        importingTrackId,
        trackImportStatus,
        showTrackDisclaimer,
        setShowTrackDisclaimer,
        openTrackPicker,
        sendTrack,
        handleImportTrack,
    } = trackSharingHook;

    // Refs
    const inputRef = useRef<HTMLInputElement>(null);

    // --- INIT ---
    useEffect(() => {
        const init = async () => {
            try {
                // FAST PATH: Show channels immediately (from cache or defaults)
                const chs = await loadChannels();

                // Auto-restore channel if returning from pin-view map
                const returnChannelId = sessionStorage.getItem('chat_return_to_channel');
                if (returnChannelId) {
                    sessionStorage.removeItem('chat_return_to_channel');
                    const ch = chs.find((c) => c.id === returnChannelId);
                    if (ch) openChannel(ch);
                }

                // Auth + profile load — with timeout to prevent infinite spinner
                try {
                    const initWithTimeout = Promise.race([
                        ChatService.initialize(),
                        new Promise<void>((_, reject) =>
                            setTimeout(() => reject(new Error('Chat init timeout')), 8000),
                        ),
                    ]);
                    await initWithTimeout;
                    // Roles are now loaded — refresh reactive state
                    refreshRoles();
                    loadUnreadCount();

                    // Refresh channels from network (bypass cache — auth may unlock new channels)
                    const fresh = await ChatService.getChannelsFresh();
                    if (fresh.length > 0) setChannels(fresh);

                    await loadProfile();
                } catch (e) {
                    log.warn('Init auth/profile failed:', e);
                }
            } catch (e) {
                // Outer catch — loadChannels() or channel restore failed
                log.warn('Chat init failed — using defaults:', e);
                setChannels(
                    DEFAULT_CHANNELS.map((c, i) => ({
                        ...c,
                        id: `default-${i}`,
                        created_at: new Date().toISOString(),
                    })),
                );
                setLoading(false);
            }
        };
        init();

        const visited = localStorage.getItem('crew_talk_visited');
        if (visited) setIsFirstVisit(false);

        const unsub = subscribeDMs();

        return () => {
            unsub();
            cleanupMessages();
            ChatService.destroy();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const loadChannels = async (): Promise<ChatChannel[]> => {
        // getChannels returns cached data instantly (or fetches if no cache)
        const chs = await ChatService.getChannels();
        const result =
            chs.length > 0
                ? chs
                : DEFAULT_CHANNELS.map((c, i) => ({
                      ...c,
                      id: `default-${i}`,
                      created_at: new Date().toISOString(),
                  }));
        setChannels(result);
        setLoading(false); // Channels visible — kill spinner immediately
        return result;
    };

    // openChannel and sendChannelMessage now provided by useChatMessages hook

    // getStaticMapUrl imported from chatUtils

    const handleReport = async () => {
        if (!reportingMsg) return;
        const userId = (await ChatService.getCurrentUser())?.id;
        if (!userId) return;
        await reportMessage(reportingMsg.id, userId, reportReason);
        moderateMessage(reportingMsg.id, reportingMsg.message, reportingMsg.user_id, reportingMsg.channel_id).catch(
            () => {},
        );
        setReportSent(true);
        setTimeout(() => {
            setReportingMsg(null);
            setReportSent(false);
        }, 1500);
    };

    // Proposals, private channels, and join requests now provided by useChatProposals hook

    // Profile photo upload, getAvatar, and profile save now provided by useChatProfile hook

    // DM actions, block/unblock, and mod actions now provided by useChatMessages + useChatDMs hooks

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
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // handleMarkHelpful now provided by useChatMessages hook

    const dismissWelcome = () => {
        setIsFirstVisit(false);
        localStorage.setItem('crew_talk_visited', 'true');
    };

    const goBack = () => {
        setShowModMenu(null);
        setNavDirection('back');
        if (view === 'messages') {
            setView('channels');
            setActiveChannel(null);
        } else if (view === 'dm_thread') {
            setView('dm_inbox');
            setDmPartner(null);
        } else if (view === 'dm_inbox') {
            setView('channels');
        } else if (view === 'profile') {
            setView('channels');
        } else if (view === 'find_crew') {
            setView('channels');
        } else if (view === 'marketplace') {
            setView('channels');
        } else if (view === 'admin_panel') {
            setView('channels');
        }
    };

    // --- RENDER ---
    return (
        <div
            className="flex flex-col h-full bg-slate-950 text-white overflow-hidden"
            style={
                keyboardOffset > 0
                    ? { height: `calc(100% - ${keyboardOffset}px)`, transition: 'height 0.15s ease-out' }
                    : undefined
            }
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
                onOpenProfile={() => {
                    setNavDirection('forward');
                    setView('profile');
                }}
                onOpenDMInbox={openDMInbox}
                onToggleBlock={() => setShowBlockConfirm(true)}
                onLeaveChannel={
                    activeChannel?.is_private
                        ? () => {
                              setConfirmAction({
                                  title: 'Leave Channel',
                                  message: `Leave "${activeChannel.name}"? You'll need to request access again to rejoin.`,
                                  destructive: true,
                                  onConfirm: async () => {
                                      const ok = await ChatService.leaveChannel(activeChannel.id);
                                      if (ok) {
                                          toast.success(`Left ${activeChannel.name}`);
                                          setActiveChannel(null);
                                          setView('channels');
                                      } else {
                                          toast.error('Cannot leave — channel owners must delete the channel instead');
                                      }
                                      setConfirmAction(null);
                                  },
                              });
                          }
                        : undefined
                }
                onPropose={() => setShowProposalForm(true)}
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
                                <button
                                    onClick={dismissWelcome}
                                    aria-label="Dismiss welcome message"
                                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-white/40 hover:text-white/70 text-sm transition-all min-w-[44px] min-h-[44px]"
                                >
                                    ✕
                                </button>
                            </div>
                            <div className="space-y-2.5">
                                <div className="flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.04]">
                                    <span className="text-lg">📢</span>
                                    <p className="text-xs text-white/60">
                                        Tap the <span className="text-amber-400 font-semibold">horn</span> to mark your
                                        message as a question — the crew will help
                                    </p>
                                </div>
                                <div className="flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.04]">
                                    <span className="text-lg">📍</span>
                                    <p className="text-xs text-white/60">
                                        Use <span className="text-sky-400 font-semibold">➕</span> to drop pins, share
                                        POIs, or send voyage tracks
                                    </p>
                                </div>
                                <div className="flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.04]">
                                    <span className="text-lg">⭐</span>
                                    <p className="text-xs text-white/60">
                                        Help others to rank up:{' '}
                                        {CREW_RANKS.slice(0, 4)
                                            .map((r) => `${r.badge}`)
                                            .join(' → ')}
                                    </p>
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
                                <span
                                    className={`text-white/30 text-sm transition-transform ${pullRefresh.pullDistance > 28 ? 'rotate-180' : ''}`}
                                >
                                    ↓
                                </span>
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
                            isObserver={settings.vessel?.type === 'observer'}
                            fileInputRef={fileInputRef}
                            onSaveProfile={handleSaveProfile}
                            onRemovePhoto={handleRemovePhoto}
                        />
                    )}

                    {/* ══════ MARITIME INTEL CARD ══════ */}
                    {view === 'channels' && !loading && <MaritimeIntelCard />}

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
                            onOpenAdmin={() => {
                                setNavDirection('forward');
                                setView('admin_panel');
                            }}
                            memberChannelIds={memberChannelIds}
                            proposalParentId={proposalParentId}
                            setProposalParentId={setProposalParentId}
                        />
                    )}

                    {/* ══════ ADMIN PANEL ══════ */}
                    {view === 'admin_panel' && !loading && (
                        <AdminPanel
                            isOpen={true}
                            onClose={() => setView('channels')}
                            onChannelDeleted={(id) => {
                                setChannels((prev) => prev.filter((c) => c.id !== id));
                            }}
                            onChannelApproved={async () => {
                                const fresh = await ChatService.getChannelsFresh();
                                if (fresh.length > 0) setChannels(fresh);
                            }}
                        />
                    )}

                    {/* ══════ JOIN REQUEST MODAL ══════ */}
                    {joinRequestChannel && (
                        <div
                            className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/70"
                            onClick={() => setJoinRequestChannel(null)}
                        >
                            <div
                                className="w-full max-w-lg bg-slate-950 border-t border-purple-500/20 rounded-t-3xl shadow-2xl p-5 space-y-4"
                                onClick={(e) => e.stopPropagation()}
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
                                        <p className="text-[11px] text-purple-400/60">
                                            {joinRequestChannel.name} — Private Channel
                                        </p>
                                    </div>
                                </div>

                                <p className="text-xs text-white/50">
                                    This is a private channel. Write a message to the channel owner explaining why you'd
                                    like to join.
                                </p>

                                <textarea
                                    value={joinRequestMessage}
                                    onChange={(e) => setJoinRequestMessage(e.target.value)}
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
                                onReportMsg={(msg) => {
                                    setReportingMsg(msg);
                                    setReportSent(false);
                                }}
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
                    trackSharing={isTrackSharing}
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
                <div
                    className="fixed bottom-28 left-1/2 -translate-x-1/2 z-[9998] px-5 py-3 rounded-xl shadow-2xl border max-w-[320px] text-center"
                    style={{
                        background: trackImportStatus!.startsWith('✅') ? 'rgba(6,78,59,0.95)' : 'rgba(127,29,29,0.95)',
                        borderColor: trackImportStatus!.startsWith('✅')
                            ? 'rgba(16,185,129,0.3)'
                            : 'rgba(239,68,68,0.3)',
                    }}
                >
                    <p
                        className={`text-sm font-bold ${trackImportStatus!.startsWith('✅') ? 'text-emerald-300' : 'text-red-300'}`}
                    >
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
                onConfirm={confirmAction?.onConfirm || (() => {})}
                onCancel={() => setConfirmAction(null)}
            />
        </div>
    );
});

export default ChatPage;
