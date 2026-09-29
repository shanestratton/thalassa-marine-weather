/**
 * DraftConfirmModal — "Your draft is set at 2.40 m. Please confirm."
 *
 * Shane 2026-09-29: "what we need, is a modal box that says, 'Your draft is
 * set at xxx.xx M. please confirm !!'". The draft is the only boat figure for
 * depth, so anything that plans against it asks through
 * stores/draftConfirmStore.ts, and this — mounted ONCE, in App — is the box
 * that asks. It renders nothing until an ask arrives.
 *
 *  - Confirm 2.40 m      → the stored figure is confirmed (feet, untouched).
 *  - Change              → a metres field in the same box; Save and confirm
 *                          writes it (feet, as stored) and confirms it.
 *  - No draft at all     → says so and shows the field straight away.
 *  - Close / Escape / backdrop / Cancel → the action does not run.
 *
 * House rules: centred and clear of the tab bar, the card scrolls inside
 * itself, and index.css's keyboard-open rules for centred dialogs keep the
 * field above the keyboard (KeyboardResize.None). While the keyboard is up
 * for the field, the notes step aside (and, in a short landscape band, the
 * heading too) so the field and both buttons stay on screen together at
 * 320 px, in landscape and at large text; hidden, they still name and
 * describe the dialog. browser-tests/draft-confirm-layout.spec.ts measures it.
 */
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import {
    DRAFT_MAX_M,
    DRAFT_MIN_M,
    confirmDraftPatch,
    draftConfirmation,
    draftDisplayUnit,
    draftInputValue,
    formatDraft,
    formatDraftMetres,
    parseDraftMetres,
} from '../../services/draftConfirmation';
import {
    registerDraftConfirmHost,
    saveDraftConfirmation,
    settleDraftConfirm,
    useDraftConfirmRequest,
    type DraftConfirmRequest,
} from '../../stores/draftConfirmStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { Button } from '../ui/Button';
import { OverlayPortal } from '../ui/OverlayPortal';

// Keyboard-up compaction. Tailwind only sees whole literal class names, so
// each variant is spelled out in full.
/** Notes step aside while the keyboard is up for the field. */
const NOTES_ASIDE = "[html[data-keyboard-open='true']_&]:hidden";
/** The heading too, in a short (landscape) band. */
const HEADING_ASIDE = "[@media(max-height:500px)]:[html[data-keyboard-open='true']_&]:hidden";
/** Tighter padding and gaps while the keyboard is up. */
const CARD_PADDING = "p-4 [html[data-keyboard-open='true']_&]:p-3";
const STACK = "flex flex-col gap-3 [html[data-keyboard-open='true']_&]:gap-2";
/** 44 px buttons while the keyboard is up (the primary is 48 otherwise). */
const KEYBOARD_BUTTON = "[html[data-keyboard-open='true']_&]:py-2";
/** With the heading aside, the field row keeps clear of the Close button. */
const CLEAR_CLOSE = "[@media(max-height:500px)]:[html[data-keyboard-open='true']_&]:pr-12";
const NOT_SAVED = 'Your draft was not saved. Try again.';

export function DraftConfirmModal() {
    const request = useDraftConfirmRequest();
    // A layout effect: registered before any passive effect in the same
    // commit can ask, so a screen mounted alongside the modal never finds
    // "nobody to ask".
    useLayoutEffect(() => registerDraftConfirmHost(), []);
    if (!request) return null;
    // A fresh dialog (state, focus) for every ask.
    return <DraftConfirmDialog key={request.id} request={request} />;
}

function DraftConfirmDialog({ request }: { request: DraftConfirmRequest }) {
    const vessel = useSettingsStore((state) => state.settings.vessel);
    const unit = useSettingsStore((state) => draftDisplayUnit(state.settings));
    const draft = draftConfirmation(vessel);
    const unset = draft.draftFt === null;
    // A stored draft outside the field's own bounds (0.8 typed while the
    // Vessel tab was in feet is 0.24 m) is never one tap from confirmed: too
    // shallow is the unsafe way round, as routes need the draft + 0.5 m.
    const outOfRange = draft.draftM !== null && (draft.draftM < DRAFT_MIN_M || draft.draftM > DRAFT_MAX_M);

    const [changing, setChanging] = useState(false);
    // No draft at all (from the start, or gone in a sync while this is open):
    // the field is the only way forward.
    const editing = changing || unset || outOfRange;
    const [text, setText] = useState(() => draftInputValue(draft.draftFt));
    const [fieldError, setFieldError] = useState('');
    const [saveError, setSaveError] = useState('');

    const titleId = useId();
    const descriptionId = useId();
    const estimateId = useId();
    const fieldId = useId();
    const fieldErrorId = useId();
    const fieldRef = useRef<HTMLInputElement>(null);
    const changeRef = useRef<HTMLButtonElement>(null);
    const returnFocus = useRef<'field' | 'change' | null>(null);

    const close = () => settleDraftConfirm(request.id, false);
    const trapRef = useFocusTrap<HTMLDivElement>(true, { onEscape: close });

    useEffect(() => {
        if (returnFocus.current === 'field') fieldRef.current?.focus();
        if (returnFocus.current === 'change') changeRef.current?.focus();
        returnFocus.current = null;
    }, [editing]);

    const save = (patch: ReturnType<typeof confirmDraftPatch>) => {
        setSaveError('');
        if (saveDraftConfirmation(patch)) settleDraftConfirm(request.id, true);
        else setSaveError(NOT_SAVED);
    };

    const confirmCurrent = () => {
        if (!unset) save(confirmDraftPatch(vessel));
    };

    const submitField = (event: React.FormEvent) => {
        event.preventDefault();
        const parsed = parseDraftMetres(text);
        if (!parsed.ok) {
            setFieldError(parsed.error);
            fieldRef.current?.focus();
            return;
        }
        setFieldError('');
        save(confirmDraftPatch(vessel, parsed.metres));
    };

    const startChange = () => {
        returnFocus.current = 'field';
        setSaveError('');
        setChanging(true);
    };
    const backToConfirm = () => {
        returnFocus.current = 'change';
        setText(draftInputValue(draft.draftFt));
        setFieldError('');
        setSaveError('');
        setChanging(false);
    };

    const shown = draft.draftFt === null ? '' : formatDraft(draft.draftFt, unit);
    const confirmLabel = draft.draftFt === null ? '' : `Confirm ${formatDraftMetres(draft.draftFt)}`;
    // Side by side when both fit on one line, stacked otherwise (320 px, large text).
    const buttonRow = 'grid gap-2 grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))]';
    const saveErrorLine = saveError && (
        <p role="alert" className="text-sm text-red-300">
            {saveError}
        </p>
    );

    return (
        <OverlayPortal
            layer="nested"
            scope="app"
            ref={trapRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={
                draft.status === 'estimated' && !outOfRange ? `${descriptionId} ${estimateId}` : descriptionId
            }
            data-draft-confirm={request.reason}
            onClick={(event) => {
                if (event.target === event.currentTarget) close();
            }}
            className="flex items-center justify-center bg-black/70 p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
        >
            {/* Centred per the standing modal rule (Shane 2026-09-02: "all modal boxes centered on the punters screen"). */}
            <div
                data-draft-confirm-card
                className={`relative w-full max-w-sm [@media(max-height:500px)]:max-w-md max-h-full overflow-y-auto rounded-2xl border border-white/10 bg-slate-900 text-white shadow-2xl ${CARD_PADDING}`}
            >
                <button
                    type="button"
                    onClick={close}
                    aria-label="Close"
                    className="absolute top-2 right-2 flex h-11 w-11 items-center justify-center rounded-full text-gray-400 hover:bg-white/10 hover:text-white"
                >
                    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>

                {/* A gap column: whatever steps aside for the keyboard takes its spacing with it. */}
                <div className={STACK}>
                    <div className={editing ? HEADING_ASIDE : undefined}>
                        <h2 id={titleId} className="ui-dialog-title min-h-11 pr-12 pt-1.5">
                            {unset ? 'Set your draft' : 'Check your draft'}
                        </h2>
                        <div className={editing ? NOTES_ASIDE : undefined}>
                            {/* One text node, so VoiceOver reads it as the sentence it is. */}
                            <p id={descriptionId} className="mt-1 text-base font-semibold text-white">
                                {unset
                                    ? 'No draft is set for your boat.'
                                    : outOfRange
                                      ? `Your draft is set at ${shown}, which looks wrong. Enter it in metres.`
                                      : `Your draft is set at ${shown}.${editing ? '' : ' Please confirm.'}`}
                            </p>
                            {draft.status === 'estimated' && !outOfRange && (
                                <p id={estimateId} className="mt-1 text-sm text-amber-300">
                                    This is an estimate, not a measurement.
                                </p>
                            )}
                            <p className="mt-1 text-xs text-gray-400">Routes and depth checks use it.</p>
                        </div>
                    </div>

                    {editing ? (
                        <form noValidate onSubmit={submitField} className={STACK}>
                            <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${CLEAR_CLOSE}`}>
                                <label htmlFor={fieldId} className="text-sm font-bold text-gray-200">
                                    Draft in metres
                                </label>
                                <input
                                    ref={fieldRef}
                                    id={fieldId}
                                    type="text"
                                    inputMode="decimal"
                                    autoComplete="off"
                                    value={text}
                                    placeholder="1.80"
                                    aria-invalid={fieldError ? true : undefined}
                                    aria-describedby={fieldError ? fieldErrorId : undefined}
                                    onChange={(event) => {
                                        setText(event.target.value);
                                        if (fieldError) setFieldError('');
                                    }}
                                    className="min-h-11 w-28 min-w-0 flex-1 rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-base font-bold text-white outline-hidden focus:border-sky-400"
                                />
                            </div>
                            {fieldError && (
                                <p id={fieldErrorId} role="alert" className="text-sm text-red-300">
                                    {fieldError}
                                </p>
                            )}
                            {saveErrorLine}
                            <div className={buttonRow}>
                                <Button
                                    onClick={unset || outOfRange ? close : backToConfirm}
                                    className={KEYBOARD_BUTTON}
                                >
                                    {unset || outOfRange ? 'Cancel' : 'Back'}
                                </Button>
                                <Button type="submit" variant="primary" className={KEYBOARD_BUTTON}>
                                    Save and confirm
                                </Button>
                            </div>
                        </form>
                    ) : (
                        <>
                            {saveErrorLine}
                            <div className={buttonRow}>
                                <Button ref={changeRef} onClick={startChange}>
                                    Change
                                </Button>
                                <Button variant="primary" onClick={confirmCurrent}>
                                    {confirmLabel}
                                </Button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </OverlayPortal>
    );
}
