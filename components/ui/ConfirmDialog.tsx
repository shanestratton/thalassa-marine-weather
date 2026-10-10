/**
 * ConfirmDialog — Premium native-feel confirmation dialog.
 *
 * Replaces the browser-native `confirm()` with a styled modal that
 * matches the Thalassa design system. Features:
 * - Backdrop blur
 * - Destructive (red) and safe (sky) variants
 * - Loading state on confirm button
 * - Accessible keyboard and screen reader support
 */
import React, { useState, useCallback, useRef, useId } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { Button } from './Button';
import { OverlayPortal } from './OverlayPortal';

/** '-ing' forms for the verbs confirm buttons start with ('Delete profile' → 'Deleting…'). */
const PROGRESSIVE: Record<string, string> = {
    archive: 'Archiving',
    block: 'Blocking',
    clear: 'Clearing',
    delete: 'Deleting',
    discard: 'Discarding',
    leave: 'Leaving',
    mark: 'Marking',
    move: 'Moving',
    promote: 'Promoting',
    remove: 'Removing',
    replace: 'Replacing',
    reset: 'Resetting',
    restore: 'Restoring',
    save: 'Saving',
    send: 'Sending',
    sign: 'Signing',
    stop: 'Stopping',
    take: 'Taking',
};
const PARTICLES = new Set(['in', 'out', 'over', 'up', 'off']);

/**
 * The verb for the busy button, from its own label: 'Deleting…' for 'Delete
 * profile', 'Taking over…' for 'Take over', 'Signing in…' for 'Sign in'. A
 * label that opens with no known verb says 'Working…'.
 */
export function confirmProgressLabel(confirmLabel: string): string {
    const label = confirmLabel.trim().replace(/(\.{3}|…)$/, '');
    // A caller that already swaps its label for the busy one ('Deleting...').
    if (/^\S+ing\b/i.test(label)) return `${label}…`;
    const [verb = '', next = ''] = label.toLowerCase().split(/\s+/);
    const ing = PROGRESSIVE[verb];
    if (!ing) return 'Working…';
    return PARTICLES.has(next) ? `${ing} ${next}…` : `${ing}…`;
}

interface ConfirmDialogProps {
    /** Whether the dialog is visible */
    isOpen: boolean;
    /** Title text */
    title: string;
    /** Body text */
    message: string;
    /** Label for confirm button (default: "Confirm") */
    confirmLabel?: string;
    /** Label for cancel button (default: "Cancel") */
    cancelLabel?: string;
    /**
     * The confirm button's words while onConfirm runs ('Deleting…', 'Signing
     * in…'). A verb stays beside the spinner, so a slow delete never looks
     * like a blank, stuck button. Default: the label's own verb
     * (confirmProgressLabel), else 'Working…'.
     */
    loadingLabel?: string;
    /** If true, confirm button is styled red for destructive actions */
    destructive?: boolean;
    /** Called when user confirms — can be async */
    onConfirm: () => void | Promise<void>;
    /** Called when user cancels */
    onCancel: () => void;
    /**
     * A gentler third choice, offered first: full width and primary, above
     * the cancel / confirm row (R&M's 'Pause instead' before 'Delete task and
     * records'). Focus still starts on cancel.
     */
    alternative?: { label: string; onSelect: () => void };
}

const SKY = 'bg-linear-to-r from-sky-600 to-sky-600 shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500';
/** The confirm button's classes, shared by the alternative (where flex-1 does nothing and w-full widens it). */
const ACTION =
    'ui-confirm-action flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl px-3 py-3 text-sm font-bold text-white shadow-lg transition-all active:scale-[0.97] disabled:opacity-50';

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
    isOpen,
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    loadingLabel,
    destructive = false,
    onConfirm,
    onCancel,
    alternative,
}) => {
    const [loading, setLoading] = useState(false);
    const titleId = useId();
    const cancelRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(isOpen, {
        initialFocusRef: cancelRef,
        onEscape: onCancel,
    });

    const handleConfirm = useCallback(async () => {
        setLoading(true);
        try {
            await onConfirm();
        } finally {
            setLoading(false);
        }
    }, [onConfirm]);

    if (!isOpen) return null;

    const confirmBg = destructive
        ? 'bg-linear-to-r from-red-600 to-red-600 shadow-red-500/20 hover:from-red-500 hover:to-red-500'
        : SKY;

    return (
        <OverlayPortal
            // The taller three-button card keeps clear of the tab bar (centred above it).
            className={`flex items-center justify-center p-4${alternative ? ' pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)]' : ''}`}
            onClick={onCancel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            ref={dialogRef}
        >
            <div className="absolute inset-0 bg-black/60" />
            <div
                data-pane-dialog-panel
                className="relative w-full max-w-sm max-h-full overflow-y-auto bg-slate-900 border border-white/10 rounded-2xl p-6 animate-in fade-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Icon */}
                <div
                    className={`mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-4 ${destructive ? 'bg-red-500/20' : 'bg-sky-500/20'}`}
                >
                    {destructive ? (
                        <svg
                            className="w-6 h-6 text-red-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                        </svg>
                    ) : (
                        <svg
                            className="w-6 h-6 text-sky-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                            />
                        </svg>
                    )}
                </div>

                <h3 id={titleId} className="ui-dialog-title text-lg font-extrabold text-white text-center mb-2">
                    {title}
                </h3>
                <p className="text-sm text-gray-300 text-center mb-6">{message}</p>

                {alternative && (
                    <button
                        type="button"
                        onClick={alternative.onSelect}
                        disabled={loading}
                        className={`${ACTION} mb-3 w-full ${SKY}`}
                    >
                        {alternative.label}
                    </button>
                )}
                <div className="flex gap-3">
                    <Button ref={cancelRef} onClick={onCancel} className="flex-1 text-gray-400">
                        {cancelLabel}
                    </Button>
                    {/* No aria-label override: the accessible name IS the visible label
                        ("Delete profile", "Take over"), so voice control and screen readers
                        match what the eye sees. While onConfirm runs, the spinner sits
                        beside a verb ('Deleting…'), never alone (UX scorecard run 9), and
                        the button stays named for what it does. Sentence case in Cancel's
                        weight: the house rule for every button (theme.ts), where it was
                        the one tracked-caps action in a dialog. */}
                    <button
                        aria-label={loading ? confirmLabel : undefined}
                        aria-busy={loading || undefined}
                        onClick={handleConfirm}
                        disabled={loading}
                        className={`${ACTION} ${confirmBg}`}
                    >
                        {loading ? (
                            <>
                                <span
                                    aria-hidden="true"
                                    className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white border-t-transparent"
                                />
                                <span aria-hidden="true">{loadingLabel ?? confirmProgressLabel(confirmLabel)}</span>
                            </>
                        ) : (
                            confirmLabel
                        )}
                    </button>
                </div>
            </div>
        </OverlayPortal>
    );
};
