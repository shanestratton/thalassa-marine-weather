import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { ChatPage } from '../../components/ChatPage';
import { PullToRefresh } from '../../components/PullToRefresh';
import { PageTransition } from '../../components/ui/PageTransition';
import { PanePortalScope } from '../../context/PanePortalContext';
import { ThemeProvider } from '../../context/ThemeContext';
import { ChatService, type ChatChannel, type ChatMessage, type DirectMessage } from '../../services/ChatService';
import { initGlobalKeyboardScroll } from '../../utils/keyboardScroll';
import '../../index.css';

const params = new URLSearchParams(location.search);
const pane = params.get('pane') === 'true';
const mobileLandscape = innerWidth > innerHeight && innerHeight < 500;
const longHistory = params.get('history') === 'long';
const keyboardModel = params.get('keyboard') === 'web' ? 'web' : 'native';
const createdAt = '2026-09-10T06:00:00.000Z';
const channel: ChatChannel = {
    id: 'layout-general',
    name: 'General',
    description: 'Local layout test conversation',
    region: null,
    icon: '💬',
    is_global: true,
    is_private: false,
    owner_id: null,
    parent_id: null,
    created_at: createdAt,
};
const channelMessage = (id: string, message: string): ChatMessage => ({
    id,
    channel_id: channel.id,
    user_id: 'self',
    display_name: 'You',
    message,
    is_question: false,
    helpful_count: 0,
    is_pinned: false,
    deleted_at: null,
    created_at: createdAt,
});
const directMessage = (id: string, message: string): DirectMessage => ({
    id,
    sender_id: 'self',
    recipient_id: 'layout-sparrow',
    sender_name: 'You',
    message,
    read: true,
    created_at: createdAt,
});
let blockedByMe = false;
let sequence = 0;
let blockChecks = 0;

// Only the service boundary is fake: real ChatPage, message/DM hooks, lists,
// composers, keyboard ownership and CSS all run. Anonymous identity avoids
// cloud profile/push initialization. Every delivery/block stays in memory.
Object.assign(ChatService, {
    initialize: async () => {},
    destroy: () => {},
    getCurrentUser: async () => null,
    getCurrentUserId: () => 'self',
    isMod: () => false,
    isAdmin: () => false,
    isModerator: () => false,
    isMuted: () => false,
    getMutedUntil: () => null,
    getChannels: async () => [channel],
    getChannelsFresh: async () => [channel],
    getMessages: async () =>
        Array.from({ length: longHistory ? 45 : 0 }, (_, i) =>
            channelMessage(`channel-${i}`, `Harbour update ${i + 1}: the anchorage is calm and ready for the crew.`),
        ),
    subscribeToChannel: () => () => {},
    subscribeToDMs: () => () => {},
    getDMConversations: async () => [
        {
            user_id: 'layout-sparrow',
            display_name: 'Sparrow',
            last_message: 'See you at the marina',
            last_at: createdAt,
            unread_count: 0,
        },
    ],
    getDMThread: async () =>
        Array.from({ length: longHistory ? 45 : 0 }, (_, i) =>
            directMessage(`dm-${i}`, `Sparrow passage update ${i + 1}: the marina berth is ready.`),
        ),
    isBlocked: async () => blockedByMe,
    getDMBlockStatus: async () => {
        if (params.get('permissions') === 'retry' && blockChecks++ === 0) {
            throw new Error('Local permission-check failure');
        }
        return { blockedByMe, blockedEitherDirection: blockedByMe };
    },
    blockUser: async () => {
        blockedByMe = true;
        return true;
    },
    unblockUser: async () => {
        blockedByMe = false;
        return true;
    },
    sendMessage: async (_id: string, message: string) => channelMessage(`sent-channel-${++sequence}`, message),
    sendDM: async (_id: string, message: string) => directMessage(`sent-dm-${++sequence}`, message),
});

// Native KeyboardResize.None leaves BOTH layout and visual viewports unchanged.
// Register a local plugin before keyboardScroll's dynamic import, then let the
// real native listeners publish height. The OS keyboard itself is an occluder.
const nativeListeners = new Map<string, (info: { keyboardHeight: number }) => void>();
registerPlugin('Keyboard', {
    web: () => ({
        addListener: async (event: string, callback: (info: { keyboardHeight: number }) => void) => {
            nativeListeners.set(event, callback);
            if (nativeListeners.size === 4) document.documentElement.dataset.nativeKeyboardReady = 'true';
            return {
                remove: async () => {
                    nativeListeners.delete(event);
                },
            };
        },
    }),
});
const viewport = new EventTarget();
Object.assign(viewport, { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1 });
Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
const cover = document.createElement('div');
cover.dataset.testid = 'keyboard-cover';
cover.textContent = 'Native keyboard (layout simulation only)';
Object.assign(cover.style, {
    position: 'fixed',
    inset: 'auto 0 0',
    height: '0',
    display: 'none',
    background: '#334155',
    color: '#fff',
    textAlign: 'center',
    zIndex: '2147483647',
});
document.body.append(cover);
let currentKeyboardHeight = 0;
function updateKeyboard(height: number) {
    currentKeyboardHeight = height;
    cover.style.height = `${height}px`;
    cover.style.display = height ? 'block' : 'none';
    Object.assign(viewport, { height: innerHeight - (keyboardModel === 'web' ? height : 0), width: innerWidth });
    if (keyboardModel === 'native') {
        for (const event of height
            ? ['keyboardWillShow', 'keyboardDidShow']
            : ['keyboardWillHide', 'keyboardDidHide']) {
            nativeListeners.get(event)?.({ keyboardHeight: height });
        }
    }
    viewport.dispatchEvent(new Event('resize'));
}
window.addEventListener('test:keyboard', ((event: CustomEvent<number>) =>
    updateKeyboard(event.detail)) as EventListener);
window.addEventListener('resize', () => updateKeyboard(currentKeyboardHeight));
const originalIsNativePlatform = Capacitor.isNativePlatform;
Capacitor.isNativePlatform = () => keyboardModel === 'native';
initGlobalKeyboardScroll();
Capacitor.isNativePlatform = originalIsNativePlatform;

function Fixture() {
    const frameRef = useRef<HTMLDivElement>(null);
    // Keep in sync with App's chat route: global brand header -> disabled
    // PullToRefresh -> main -> clipped split frame -> extended inner page ->
    // actual PageTransition -> route wrapper -> ChatPage. VesselHub navigates
    // to this route; it does not mount a separate chat inside its tile page.
    return (
        <div className="relative z-10 flex flex-col h-full overflow-hidden bg-slate-950">
            <header
                data-testid="app-brand-header"
                className={`px-4 md:px-6 flex flex-col justify-between shrink-0 ${mobileLandscape ? 'py-1' : 'py-2'} pt-[max(1rem,env(safe-area-inset-top))]`}
            >
                <div className="flex items-start justify-between shrink-0">
                    <div className="h-[64px] flex items-center font-bold text-white">THALASSA</div>
                </div>
            </header>
            <PullToRefresh disabled onRefresh={() => {}}>
                <main id="main-content" className="grow relative flex flex-col bg-slate-950 pt-0 overflow-hidden">
                    <div
                        className={`relative flex-1 overflow-hidden ${pane ? 'flex gap-2 bg-black p-2 pb-[calc(4rem+env(safe-area-inset-bottom)+0.5rem)]' : ''}`}
                    >
                        {pane && (
                            <aside
                                className="h-full min-w-0 flex-1 rounded-2xl bg-slate-900"
                                aria-label="Glass companion pane"
                            />
                        )}
                        <PanePortalScope enabled={pane} paneId="page" frameRef={frameRef}>
                            <div
                                ref={frameRef}
                                data-testid="page-frame"
                                data-split-pane={pane ? 'page' : undefined}
                                className={
                                    pane
                                        ? 'relative h-full min-w-0 flex-1 overflow-clip rounded-2xl border border-white/25 bg-slate-950'
                                        : 'absolute inset-0'
                                }
                            >
                                <div
                                    className="absolute inset-x-0 top-0"
                                    style={{
                                        height: pane ? 'calc(100% + 4.5rem + env(safe-area-inset-bottom))' : '100%',
                                    }}
                                >
                                    <PageTransition pageKey="chat" direction="tab" canSwipeBack={false}>
                                        <div data-testid="route-wrapper" className="h-full overflow-hidden">
                                            <ChatPage onBack={() => {}} />
                                        </div>
                                    </PageTransition>
                                </div>
                            </div>
                        </PanePortalScope>
                    </div>
                </main>
            </PullToRefresh>
            <nav
                data-testid="app-bottom-nav"
                aria-label="App navigation"
                className="fixed bottom-0 inset-x-0 z-900 border-t border-sky-500/10 pb-[env(safe-area-inset-bottom)] bg-slate-900 text-white"
            >
                <div className="h-16 flex items-center justify-around">
                    <span>Glass</span>
                    <span>Vessel</span>
                    <span>Charts</span>
                </div>
            </nav>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(
    <ThemeProvider>
        <Fixture />
    </ThemeProvider>,
);
