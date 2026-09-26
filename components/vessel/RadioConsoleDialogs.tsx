import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { usePaneScope } from '../../context/PanePortalContext';
import { OverlayPortal } from '../ui/OverlayPortal';
import type { RadioSelectorAnchor } from './useRadioSelectorAnchor';

interface RadioSelectorSlotProps {
    selectors: React.ReactNode;
    selectorAnchor: RadioSelectorAnchor | null;
}

interface RadioDialogProps extends RadioSelectorSlotProps {
    title: string;
    displayTitle?: string;
    onClose: () => void;
    children: React.ReactNode;
    footer: React.ReactNode;
    compactReadback?: boolean;
}

/** All available screen space on phones; only the owning pane on iPad. */
function RadioDialog({
    title,
    displayTitle,
    onClose,
    children,
    footer,
    selectors,
    compactReadback = false,
}: RadioDialogProps) {
    const pane = usePaneScope();
    const [showCallTypes, setShowCallTypes] = useState(false);
    const closeRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(true, { onEscape: onClose, initialFocusRef: closeRef });
    return (
        <OverlayPortal
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="flex flex-col bg-slate-950 text-white overflow-hidden"
            style={{
                paddingTop: pane ? '8px' : 'max(8px, env(safe-area-inset-top))',
                paddingBottom: pane ? '8px' : 'max(8px, env(safe-area-inset-bottom))',
            }}
        >
            <header className="mx-auto w-full max-w-3xl shrink-0 flex items-center justify-between gap-2 px-3 pb-2 border-b border-white/10">
                <h2 className="min-w-0 text-lg font-bold">{displayTitle ?? title}</h2>
                {compactReadback && (
                    <button
                        type="button"
                        onClick={() => setShowCallTypes((shown) => !shown)}
                        aria-expanded={showCallTypes}
                        className="ml-auto min-h-[44px] rounded-xl border border-white/15 px-3 text-sm font-semibold text-sky-200"
                    >
                        {showCallTypes ? 'Hide choices' : 'Change call'}
                    </button>
                )}
                <button
                    ref={closeRef}
                    type="button"
                    onClick={onClose}
                    aria-label={`Close ${title.toLowerCase()}`}
                    className="shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl bg-white/5 border border-white/10 text-white"
                >
                    <svg
                        aria-hidden="true"
                        className="w-5 h-5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                </button>
            </header>
            {/* Preparation keeps all call choices visible. During readback they
                remain one tap away without displacing the actual radio words. */}
            {(!compactReadback || showCallTypes) && (
                <div className="mx-auto w-full max-w-3xl shrink-0 px-3 py-2">{selectors}</div>
            )}
            {children}
            <footer className="mx-auto w-full max-w-3xl shrink-0 border-t border-white/10 px-3 pt-2">{footer}</footer>
        </OverlayPortal>
    );
}

export function RadioInstructionsDialog({
    onClose,
    onContinue,
    children,
    selectors,
    selectorAnchor,
}: RadioSelectorSlotProps & {
    onClose: () => void;
    onContinue: () => void;
    children: React.ReactNode;
}) {
    return (
        <RadioDialog
            title="VHF instructions"
            displayTitle="Prepare call"
            onClose={onClose}
            selectors={selectors}
            selectorAnchor={selectorAnchor}
            footer={
                <button
                    type="button"
                    onClick={onContinue}
                    aria-label="Continue to voice transcript"
                    className="ui-confirm-action w-full min-h-[44px] rounded-xl bg-sky-600 py-2 text-white font-bold"
                >
                    Show call script
                </button>
            }
        >
            <div
                // On short phones the instructions must fit unscrolled (e2e radio-console-flow);
                // spacing tightens there so the 12 px text and 44 pt controls keep their size.
                className="mx-auto w-full max-w-3xl flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-2 space-y-2 [@media(max-height:700px)]:py-1 [@media(max-height:700px)]:space-y-1"
                data-testid="radio-instructions-body"
            >
                {children}
            </div>
        </RadioDialog>
    );
}

/** Use the reclaimed screen space first, then choose readable 16–20 px type.
 * Every spoken word stays intact. Longer names and accessibility enlargement
 * retain an honest scroll fallback rather than ever going below the floor.
 */
function ReadableTranscript({ text }: { text: string }) {
    const viewportRef = useRef<HTMLDivElement>(null);
    const textRef = useRef<HTMLDivElement>(null);
    const [needsScroll, setNeedsScroll] = useState(false);
    const measure = useCallback(() => {
        const viewport = viewportRef.current;
        const content = textRef.current;
        if (!viewport || !content || viewport.clientHeight === 0) return;
        const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const minimum = Math.max(16, rootSize);
        const maximum = Math.max(minimum, rootSize * 1.25);
        let low = minimum;
        let high = maximum;
        content.style.fontSize = `${minimum}px`;
        if (content.scrollHeight <= viewport.clientHeight + 1) {
            // Bounded binary search finds the largest legible size that fits.
            for (let step = 0; step < 6; step += 1) {
                const candidate = (low + high) / 2;
                content.style.fontSize = `${candidate}px`;
                if (content.scrollHeight <= viewport.clientHeight + 1) low = candidate;
                else high = candidate;
            }
            content.style.fontSize = `${Math.max(minimum, Math.floor(low * 4) / 4)}px`;
        }
        setNeedsScroll(content.scrollHeight > viewport.clientHeight + 1);
    }, []);
    useLayoutEffect(() => {
        let active = true;
        measure();
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
        if (viewportRef.current) observer?.observe(viewportRef.current);
        void document.fonts?.ready.then(() => {
            if (active) measure();
        });
        return () => {
            active = false;
            observer?.disconnect();
        };
    }, [measure, text]);
    return (
        <>
            {needsScroll && (
                <p role="note" className="shrink-0 px-3 pb-1 text-xs font-semibold text-amber-200">
                    Scroll to continue <span aria-hidden="true">↓</span>
                </p>
            )}
            <div
                ref={viewportRef}
                data-testid="radio-transcript-body"
                role="region"
                aria-label="Call script"
                tabIndex={0}
                className="w-full flex-1 min-h-0 overflow-y-auto overscroll-contain px-3"
            >
                <div
                    ref={textRef}
                    data-testid="dsc-transcript"
                    className="rounded-xl border-l-2 border-sky-400/50 bg-slate-900/40 p-2 font-semibold text-white select-text break-words whitespace-pre-line"
                    style={{ fontSize: 'max(16px, 1rem)', lineHeight: 1.25 }}
                >
                    {text}
                </div>
            </div>
        </>
    );
}

export function RadioTranscriptDialog({
    text,
    status,
    onClose,
    onInstructions,
    onUpdate,
    selectors,
    selectorAnchor,
}: RadioSelectorSlotProps & {
    text: string;
    status: React.ReactNode;
    onClose: () => void;
    onInstructions: () => void;
    onUpdate: () => void;
}) {
    return (
        <RadioDialog
            title="Voice transcript"
            displayTitle="Read aloud"
            onClose={onClose}
            selectors={selectors}
            selectorAnchor={selectorAnchor}
            compactReadback
            footer={
                <div className="flex gap-2">
                    <button
                        type="button"
                        onClick={onInstructions}
                        aria-label="VHF instructions"
                        className="flex-1 min-h-[44px] rounded-xl border border-white/15 px-3 py-2 text-sm font-bold"
                    >
                        Call steps
                    </button>
                    <button
                        type="button"
                        onClick={onUpdate}
                        className="flex-1 min-h-[44px] rounded-xl border border-sky-400/40 bg-sky-500/15 px-3 py-2 text-sm font-bold text-sky-200"
                    >
                        Update position
                    </button>
                </div>
            }
        >
            <div className="mx-auto w-full max-w-3xl min-h-0 flex-1 flex flex-col py-2">
                <div className="shrink-0 px-3 pb-2 text-xs leading-tight text-slate-300">{status}</div>
                <ReadableTranscript text={text} />
            </div>
        </RadioDialog>
    );
}
