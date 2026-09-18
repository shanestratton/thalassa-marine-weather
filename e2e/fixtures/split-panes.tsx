import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PanePortalScope } from '../../context/PanePortalContext';
import { ModalSheet } from '../../components/ui/ModalSheet';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { OverlayPortal } from '../../components/ui/OverlayPortal';
import { SlideToAction } from '../../components/ui/SlideToAction';
import { initGlobalKeyboardScroll } from '../../utils/keyboardScroll';
import '../../index.css';

const viewport = new EventTarget();
let keyboardHeight = 0;
Object.assign(viewport, { height: window.innerHeight, offsetTop: 0, scale: 1 });
Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
function resizeViewport() {
    Object.assign(viewport, { height: window.innerHeight - keyboardHeight });
    viewport.dispatchEvent(new Event('resize'));
}
window.addEventListener('test:keyboard', ((event: CustomEvent<number>) => {
    keyboardHeight = event.detail;
    resizeViewport();
}) as EventListener);
window.addEventListener('resize', resizeViewport);
initGlobalKeyboardScroll();

const control = 'block w-full rounded-xl border border-white/30 bg-slate-800 p-3 text-white';
function PaneContent({ id }: { id: string }) {
    const [open, setOpen] = useState(false);
    const [nested, setNested] = useState(false);
    const [legacy, setLegacy] = useState(false);
    const [conditional, setConditional] = useState(false);
    const [confirmed, setConfirmed] = useState(0);
    return (
        <div className="h-full overflow-y-auto p-4" data-testid={`${id}-scroll`}>
            <button className={control} onClick={() => setOpen(true)}>
                Open {id}
            </button>
            <button className={control} onClick={() => setLegacy(true)}>
                Legacy {id}
            </button>
            <button className={control} onClick={() => setConditional(true)}>
                Conditional {id}
            </button>
            <label className="block my-4">
                {id} page field
                <input className={control} aria-label={`${id} page field`} />
            </label>
            <SlideToAction label={`Slide ${id}`} thumbIcon="→" onConfirm={() => setConfirmed((value) => value + 1)} />
            <output data-testid={`${id}-confirmed`}>{confirmed}</output>
            <div style={{ height: 900 }}>Scrollable page</div>
            <input className={control} aria-label={`${id} bottom field`} />
            <div className="fixed bottom-0 right-0 pointer-events-none" data-testid={`${id}-fixed`}>
                Pane corner
            </div>
            <ModalSheet isOpen={open} onClose={() => setOpen(false)} title={`${id} settings`}>
                <label className="block">
                    Host
                    <input aria-label={`${id} host`} className={control} />
                </label>
                <button className={control} onClick={() => setNested(true)}>
                    Nested {id}
                </button>
                <div style={{ height: 620 }}>Long form content</div>
                <label>
                    Notes
                    <textarea aria-label={`${id} notes`} className={control} />
                </label>
                <ConfirmDialog
                    isOpen={nested}
                    title={`${id} confirmation`}
                    message="Nested pane dialog"
                    onConfirm={() => setNested(false)}
                    onCancel={() => setNested(false)}
                />
            </ModalSheet>
            {legacy && (
                <OverlayPortal
                    className="flex items-center justify-center p-4"
                    style={{ paddingBottom: 300 }}
                    role="presentation"
                >
                    <div
                        role="dialog"
                        aria-label={`${id} legacy`}
                        className="w-full max-w-lg overflow-y-auto rounded-2xl bg-slate-900 p-4"
                        style={{ maxHeight: '80vh' }}
                    >
                        <button className={control} onClick={() => setLegacy(false)}>
                            Close legacy
                        </button>
                        <input aria-label={`${id} legacy field`} className={control} />
                        <div style={{ height: 800 }}>Long legacy panel</div>
                    </div>
                </OverlayPortal>
            )}
            {conditional && (
                <ConfirmDialog
                    isOpen
                    title={`${id} conditional confirmation`}
                    message="Unmount this dialog on close"
                    onConfirm={() => setConditional(false)}
                    onCancel={() => setConditional(false)}
                />
            )}
        </div>
    );
}

function App() {
    const [split, setSplit] = useState(true);
    const [alarm, setAlarm] = useState(false);
    const leftRef = useRef<HTMLElement>(null);
    const rightRef = useRef<HTMLElement>(null);
    return (
        <div className="h-full bg-slate-950 text-white">
            <header className="h-20 flex gap-4 p-4">
                <button onClick={() => setSplit((value) => !value)}>Toggle split</button>
                <button onClick={() => setAlarm(true)}>Global alarm</button>
            </header>
            <div className="flex gap-2 p-2" style={{ height: 'calc(100% - 80px)' }}>
                <PanePortalScope enabled={split} paneId="left" frameRef={leftRef}>
                    <section
                        ref={leftRef}
                        data-testid="left-frame"
                        data-split-pane={split ? 'left' : undefined}
                        className="relative min-w-0 flex-1 overflow-hidden rounded-2xl border border-cyan-400"
                        style={{ display: split ? undefined : 'none' }}
                    >
                        <PaneContent id="left" />
                    </section>
                </PanePortalScope>
                <PanePortalScope enabled={split} paneId="right" frameRef={rightRef}>
                    <section
                        ref={rightRef}
                        data-testid="right-frame"
                        data-split-pane={split ? 'right' : undefined}
                        className="relative min-w-0 flex-1 overflow-hidden rounded-2xl border border-white/25"
                    >
                        <PaneContent id="right" />
                    </section>
                </PanePortalScope>
            </div>
            {alarm && (
                <OverlayPortal
                    layer="critical"
                    className="flex items-center justify-center bg-red-950"
                    role="alertdialog"
                    aria-label="Global alarm dialog"
                >
                    <button onClick={() => setAlarm(false)}>Dismiss alarm</button>
                </OverlayPortal>
            )}
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<App />);
