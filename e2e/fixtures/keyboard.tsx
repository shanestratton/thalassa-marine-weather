import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ModalSheet } from '../../components/ui/ModalSheet';
import { OverlayPortal } from '../../components/ui/OverlayPortal';
import { CreatePlaylistSheet } from '../../components/music/musicPage/CreatePlaylistSheet';
import { PinDropSheet } from '../../components/chat/ChatAttachmentSheets';
import { ChatComposer } from '../../components/chat/ChatComposer';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useKeyboardOffset } from '../../hooks/useKeyboardOffset';
import { initGlobalKeyboardScroll } from '../../utils/keyboardScroll';
import '../../index.css';

// A real browser does not show a mobile OS keyboard under automation. Model
// its visual viewport while retaining real DOM layout and the actual app CSS.
const viewport = new EventTarget();
const keyboardCover = document.createElement('div');
keyboardCover.textContent = 'Keyboard (simulated)';
Object.assign(keyboardCover.style, {
    position: 'fixed',
    bottom: '0',
    left: '0',
    right: '0',
    height: '0',
    display: 'none',
    background: '#334155',
    color: '#cbd5e1',
    textAlign: 'center',
    paddingTop: '20px',
    zIndex: '2147483647',
});
document.body.append(keyboardCover);
Object.assign(viewport, { height: window.innerHeight, offsetTop: 0, scale: 1 });
Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
window.addEventListener('test:keyboard', ((event: CustomEvent<number>) => {
    Object.assign(viewport, { height: window.innerHeight - event.detail });
    keyboardCover.style.height = `${event.detail}px`;
    keyboardCover.style.display = event.detail ? 'block' : 'none';
    viewport.dispatchEvent(new Event('resize'));
}) as EventListener);
initGlobalKeyboardScroll();

const inputClass = 'block w-full rounded-xl border border-white/30 bg-slate-800 p-3 text-white';
function Fields({ long = false }: { long?: boolean }) {
    return (
        <>
            <label className="mb-4 block text-slate-200">
                Host
                <input aria-label="Host" className={inputClass} />
            </label>
            {long && <div style={{ height: 500 }}>Other settings</div>}
            <label className="mb-4 block text-slate-200">
                Port
                <input aria-label="Port" inputMode="numeric" className={inputClass} />
            </label>
            <label className="block text-slate-200">
                Notes
                <textarea aria-label="Notes" rows={long ? 15 : 2} className={inputClass} />
            </label>
        </>
    );
}
function LegacyDialog() {
    const ref = useFocusTrap<HTMLDivElement>(true);
    return (
        <OverlayPortal
            role="dialog"
            aria-modal="true"
            ref={ref}
            className="flex items-center justify-center bg-black/80 p-4"
        >
            <div className="w-full max-w-md max-h-full overflow-y-auto rounded-2xl bg-slate-900 p-4">
                <button>Close</button>
                <Fields long />
            </div>
        </OverlayPortal>
    );
}
function BottomDialog() {
    const ref = useFocusTrap<HTMLDivElement>(true);
    return (
        <OverlayPortal
            role="dialog"
            aria-modal="true"
            ref={ref}
            className="flex items-end justify-center bg-black/80 p-4"
        >
            <div className="thalassa-keyboard-safe-sheet flex w-full max-w-md flex-col rounded-2xl bg-slate-900">
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <div className="thalassa-pin-map bg-slate-800">Map preview</div>
                </div>
                <div className="flex-none p-4">
                    <Fields />
                </div>
            </div>
        </OverlayPortal>
    );
}
function CurrentLocationHarness() {
    const keyboardHeight = useKeyboardOffset();
    const [sharingLocation, setSharingLocation] = useState(true);
    const [note, setNote] = useState('');
    const [message, setMessage] = useState('Unsent channel draft');
    const [shared, setShared] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    // Match ChatPage's clipped flex shell and separate, pinned composer.
    // No GPS, login or message delivery: all state stays in this fixture.
    return (
        <main className="h-full overflow-hidden bg-slate-950 pt-[60px] text-white">
            <div
                className="flex h-full flex-col overflow-hidden"
                style={keyboardHeight ? { height: `calc(100% - ${keyboardHeight}px)` } : undefined}
                data-testid="chat-shell"
            >
                <header className="shrink-0 px-4 py-3" data-testid="chat-header">
                    Scuttlebutt
                </header>
                <div className="flex-1 overflow-y-auto">Channel messages</div>
                {sharingLocation && (
                    <PinDropSheet
                        pinLat={0}
                        pinLng={0}
                        pinCaption={note}
                        setPinCaption={setNote}
                        pinLoading={false}
                        pinSource="current"
                        pinAccuracy={5}
                        pinTimestamp={Date.now()}
                        pinRungLabel="Boat GPS"
                        locationError={null}
                        saveToMyPlaces={false}
                        setSaveToMyPlaces={() => {}}
                        sending={false}
                        onSendPin={() => setShared(note)}
                        onRetryLocation={() => {}}
                        onChoosePlace={() => {}}
                        onClose={() => setSharingLocation(false)}
                    />
                )}
                {!sharingLocation && (
                    <ChatComposer
                        messageText={message}
                        setMessageText={setMessage}
                        isQuestion={false}
                        setIsQuestion={() => {}}
                        filterWarning={null}
                        setFilterWarning={() => {}}
                        isMuted={false}
                        mutedUntil={null}
                        showAttachMenu={false}
                        setShowAttachMenu={() => {}}
                        keyboardOffset={keyboardHeight}
                        inputRef={inputRef}
                        onSend={() => {
                            throw new Error('Note must not send a channel message');
                        }}
                        onOpenPinDrop={() => {}}
                        onOpenPoiPicker={() => {}}
                        onOpenTrackPicker={() => {}}
                    />
                )}
                <output data-testid="shared-note" className="sr-only">
                    {shared}
                </output>
            </div>
        </main>
    );
}
function Harness() {
    const [open, setOpen] = useState(false);
    const mode = new URLSearchParams(location.search).get('mode');
    if (mode === 'current-location') return <CurrentLocationHarness />;
    return (
        <main className="h-screen bg-slate-950 p-4 text-white">
            <button className="p-3" onClick={() => setOpen(true)}>
                Edit settings
            </button>
            <input aria-label="Background search" className={inputClass} />
            {mode === 'page' && (
                <div style={{ height: 'calc(100vh - 140px)', overflowY: 'auto' }} data-testid="page-scroller">
                    <header style={{ position: 'sticky', top: 0, height: 140, zIndex: 2, background: '#172554' }}>
                        Boat network
                    </header>
                    <Fields long />
                </div>
            )}
            {open && mode === 'legacy' && <LegacyDialog />}
            {open && mode === 'bottom' && <BottomDialog />}
            {open && mode === 'playlist' && (
                <CreatePlaylistSheet
                    busy={false}
                    error={null}
                    onClose={() => setOpen(false)}
                    onSubmit={() => {
                        throw new Error('Unexpected submit while advancing fields');
                    }}
                />
            )}
            {open && !['legacy', 'bottom', 'playlist', 'page'].includes(mode ?? '') && (
                <ModalSheet isOpen title="Boat connection" onClose={() => setOpen(false)}>
                    <Fields long={mode === 'long'} />
                </ModalSheet>
            )}
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Harness />);
