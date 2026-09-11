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
    onClose: () => void;
    children: React.ReactNode;
    footer: React.ReactNode;
}

/** All available screen space on phones; only the owning pane on iPad. */
function RadioDialog({ title, onClose, children, footer, selectors, selectorAnchor }: RadioDialogProps) {
    const pane = usePaneScope();
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
                paddingBottom: pane ? '12px' : 'max(12px, env(safe-area-inset-bottom))',
            }}
        >
            <header
                className="absolute inset-x-0 mx-auto w-full max-w-3xl flex items-center justify-between gap-3 px-4 pb-2 border-b border-white/10"
                style={{ top: pane ? '12px' : 'max(12px, env(safe-area-inset-top))' }}
            >
                <h2 className="ui-dialog-title">{title}</h2>
                <button
                    ref={closeRef}
                    type="button"
                    onClick={onClose}
                    aria-label={`Close ${title.toLowerCase()}`}
                    className="shrink-0 w-11 h-11 flex items-center justify-center rounded-xl bg-white/5 border border-white/10 text-white"
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
            {/* Same measured top slot as the console, outside either scroller.
                Do not let the portal's different origin move call controls. */}
            <div className="shrink-0 pb-3" style={{ paddingTop: selectorAnchor?.top ?? 76 }}>
                <div
                    style={
                        selectorAnchor ? { marginLeft: selectorAnchor.left, width: selectorAnchor.width } : undefined
                    }
                    className={selectorAnchor ? undefined : 'mx-auto w-full max-w-3xl px-4'}
                >
                    {selectors}
                </div>
            </div>
            {children}
            <footer className="mx-auto w-full max-w-3xl shrink-0 border-t border-white/10 px-4 pt-3">{footer}</footer>
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
            onClose={onClose}
            selectors={selectors}
            selectorAnchor={selectorAnchor}
            footer={
                <button
                    type="button"
                    onClick={onContinue}
                    className="ui-confirm-action w-full min-h-11 rounded-xl bg-sky-600 py-3 text-white font-bold"
                >
                    Continue to voice transcript
                </button>
            }
        >
            <div
                className="mx-auto w-full max-w-3xl flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-3 space-y-4"
                data-testid="radio-instructions-body"
            >
                {children}
            </div>
        </RadioDialog>
    );
}

/** Fit ordinary calls without losing a word or shrinking below readable text.
 * Very long identities/accessibility zoom retain an explicit scroll fallback.
 * No character truncation, line clamping, or hidden bottom-of-message text.
 */
function FittedTranscript({ text }: { text: string }) {
    const viewportRef = useRef<HTMLDivElement>(null);
    const textRef = useRef<HTMLDivElement>(null);
    const [needsScroll, setNeedsScroll] = useState(false);
    const fit = useCallback(() => {
        const viewport = viewportRef.current;
        const content = textRef.current;
        if (!viewport || !content || viewport.clientHeight === 0) return;
        let size = 20;
        content.style.fontSize = `${size}px`;
        while (content.scrollHeight > viewport.clientHeight && size > 14) {
            content.style.fontSize = `${--size}px`;
        }
        setNeedsScroll(content.scrollHeight > viewport.clientHeight + 1);
    }, []);
    useLayoutEffect(() => {
        let active = true;
        fit();
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
        if (viewportRef.current) observer?.observe(viewportRef.current);
        void document.fonts?.ready.then(() => {
            if (active) fit();
        });
        return () => {
            active = false;
            observer?.disconnect();
        };
    }, [fit, text]);
    return (
        <>
            {needsScroll && (
                <p role="note" className="shrink-0 px-4 pb-2 text-micro text-amber-200">
                    Long message — scroll within the transcript to read every word.
                </p>
            )}
            <div
                ref={viewportRef}
                data-testid="radio-transcript-body"
                className="w-full flex-1 min-h-0 overflow-y-auto overscroll-contain px-4"
            >
                <div
                    ref={textRef}
                    data-testid="dsc-transcript"
                    className="font-semibold text-white select-text break-words whitespace-pre-line"
                    style={{ fontSize: 20, lineHeight: 1.35 }}
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
            onClose={onClose}
            selectors={selectors}
            selectorAnchor={selectorAnchor}
            footer={
                <div className="flex gap-3">
                    <button
                        type="button"
                        onClick={onInstructions}
                        className="flex-1 min-h-11 rounded-xl border border-white/15 px-3 py-2 text-sm font-bold"
                    >
                        VHF instructions
                    </button>
                    <button
                        type="button"
                        onClick={onUpdate}
                        className="flex-1 min-h-11 rounded-xl border border-sky-400/40 bg-sky-500/15 px-3 py-2 text-sm font-bold text-sky-200"
                    >
                        Update position
                    </button>
                </div>
            }
        >
            <div className="mx-auto w-full max-w-3xl min-h-0 flex-1 flex flex-col py-3">
                <div className="shrink-0 px-4 pb-3 text-micro text-slate-300">{status}</div>
                <FittedTranscript text={text} />
            </div>
        </RadioDialog>
    );
}
