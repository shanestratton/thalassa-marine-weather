/**
 * useUndoDelete — one undo slot for a list page's deletes (126-B10a).
 *
 * Modelled on the Diary's soft delete, and shared by Stores, Equipment,
 * Maintenance and Documents. Each page had its own copy, and each lost
 * deletes the same ways: the toast owned the five-second timer and dropped it
 * on unmount (tap Back inside the window and the item was back next visit), a
 * reload from another device put the row straight back on screen, Undo
 * appended a second copy after such a reload, and a second delete inherited
 * the first one's countdown.
 *
 * HIDE, DON'T REMOVE. The page keeps the row in its own state and filters its
 * visible list by `hiddenIds`, so every reload path (realtime, the binder
 * source, a sync, a mount pull) stays hidden in one place, and Undo just
 * unhides: the row comes back once, in its place.
 *
 * COMMIT. The real delete runs when the five seconds end, when a newer
 * remove() takes the slot, when the app goes to the background
 * (visibilitychange → hidden, pagehide: WKWebView suspends timers), and when
 * the page unmounts. Never inside a React state updater (StrictMode runs those
 * twice). A failed commit shows the row again and tells the page, but only
 * while the page is open and the account is the same.
 *
 * AFTER THE COMMIT the page reloads quietly (onCommitted), and a committed row
 * stays hidden until one of the page's loads no longer has it; from then on its
 * id is free again. A Stores row made from a Grocery List purchase keeps the
 * purchase's id, so a purchase ticked again on another device must show, not
 * stay hidden for as long as the page is open (review, 2026-10-10).
 *
 * THE TOAST is keyed per delete and told when the window closes, so a toast
 * the page hid (Equipment's detail view, the Stores scanner) and shows again
 * counts down the time that is left, not a fresh five seconds.
 *
 * ACCOUNT SWITCH. The waiting delete is dropped without committing it (the
 * local database is the new account's by then) and nothing stays hidden; the
 * Diary does the same.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';
import { createLogger } from '../utils/createLogger';

const log = createLogger('useUndoDelete');

/** How long Undo is offered, and how long the toast's progress bar runs. */
export const UNDO_DELETE_MS = 5000;

export interface UndoDeleteOptions<T extends { id: string }> {
    /** The page's rows as last loaded, hidden ones included: a committed id is
     *  let go once a load no longer has it. */
    rows: readonly { id: string }[];
    /** The real delete. Called with the scope captured at remove(); runs after
     *  unmount too, never after an account switch. */
    commit: (item: T, scope: AuthIdentityScope) => Promise<void>;
    /** The delete is in the database (page open, same account): reload quietly,
     *  so the row leaves the page's rows and its id is let go. */
    onCommitted?: (item: T) => void;
    /** Commit threw while the page is open and the account current: the row shows again. */
    onCommitFailed?: (item: T, error: unknown) => void;
    /** Undo brought the row back (the page's "Item restored" toast). */
    onRestored?: (item: T) => void;
    /** Toast words, e.g. `"${item.name}" deleted`. */
    describe: (item: T) => string;
    /** Ids hidden together with the row (a checklist's items, 126-B10b). */
    alsoHides?: (item: T) => readonly string[];
}

/** UndoToast's props. `key` is per delete: a newer delete remounts the toast
 *  with a fresh countdown and progress bar. `deadline` is when this delete's
 *  window closes, so a toast remounted part-way through shows the time left. */
export interface UndoDeleteToastProps {
    key: string;
    isOpen: boolean;
    message: string;
    duration: number;
    deadline?: number;
    onUndo: () => void;
    onDismiss: () => void;
}

export interface UndoDelete<T extends { id: string }> {
    /** The page filters its visible list (and every count) by this. */
    hiddenIds: ReadonlySet<string>;
    /** Hide the row and take the one undo slot; an earlier delete commits now. */
    remove: (item: T) => void;
    /** Unhide the waiting row; returns it, or null when nothing is waiting. */
    undo: () => T | null;
    /** Commit the waiting delete now: the page is about to show something that
     *  could act on the hidden row (the Stores scanner finds rows by barcode). */
    commitNow: () => void;
    toastProps: UndoDeleteToastProps;
}

interface Slot<T> {
    item: T;
    scope: AuthIdentityScope;
    ids: readonly string[];
    /** Date.now() when the undo window closes. */
    deadline: number;
    timer: ReturnType<typeof setTimeout>;
}

interface Waiting<T> {
    item: T;
    deadline: number;
}

const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

export function useUndoDelete<T extends { id: string }>(options: UndoDeleteOptions<T>): UndoDelete<T> {
    // The latest callbacks, so a flush from an event or an unmount uses the
    // page's current commit and the listeners attach once.
    const optionsRef = useRef(options);
    optionsRef.current = options;
    // The slot lives in a ref, mirrored to state only for the toast: commits
    // are made from here, never from a state updater.
    const slotRef = useRef<Slot<T> | null>(null);
    /** Committed rows still in the page's rows (row id -> the ids hidden with it). */
    const committedRef = useRef(new Map<string, readonly string[]>());
    const mountedRef = useRef(false);
    const [waiting, setWaiting] = useState<Waiting<T> | null>(null);
    const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(NOTHING_HIDDEN);

    const hide = useCallback((ids: readonly string[]) => {
        setHiddenIds((previous) => {
            if (ids.every((id) => previous.has(id))) return previous;
            const next = new Set(previous);
            for (const id of ids) next.add(id);
            return next;
        });
    }, []);

    const unhide = useCallback((ids: readonly string[]) => {
        setHiddenIds((previous) => {
            if (!ids.some((id) => previous.has(id))) return previous;
            const next = new Set(previous);
            for (const id of ids) next.delete(id);
            return next;
        });
    }, []);

    /** Let go of each committed row the page's rows no longer have. */
    const releaseGone = useCallback(
        (rows: readonly { id: string }[]) => {
            const committed = committedRef.current;
            if (committed.size === 0) return;
            const present = new Set(rows.map((row) => row.id));
            const waitingIds = new Set(slotRef.current?.ids ?? []);
            const released: string[] = [];
            for (const [id, ids] of committed) {
                if (present.has(id)) continue; // a stale load still has it
                committed.delete(id);
                for (const hiddenId of ids) if (!waitingIds.has(hiddenId)) released.push(hiddenId);
            }
            if (released.length > 0) unhide(released);
        },
        [unhide],
    );

    /** Empty the slot (and stop its timer); the toast closes. */
    const takeSlot = useCallback((): Slot<T> | null => {
        const slot = slotRef.current;
        if (!slot) return null;
        slotRef.current = null;
        clearTimeout(slot.timer);
        if (mountedRef.current) setWaiting(null);
        return slot;
    }, []);

    /** Commit the slot's row, if `id` is given only when it is still the one waiting. */
    const flush = useCallback(
        (id?: string) => {
            if (id !== undefined && slotRef.current?.item.id !== id) return;
            const slot = takeSlot();
            if (!slot || !isAuthIdentityScopeCurrent(slot.scope)) return;
            let committed: Promise<void>;
            try {
                committed = Promise.resolve(optionsRef.current.commit(slot.item, slot.scope));
            } catch (error) {
                committed = Promise.reject(error);
            }
            void committed.then(
                () => {
                    if (!mountedRef.current || !isAuthIdentityScopeCurrent(slot.scope)) return;
                    committedRef.current.set(slot.item.id, slot.ids);
                    releaseGone(optionsRef.current.rows);
                    optionsRef.current.onCommitted?.(slot.item);
                },
                (error: unknown) => {
                    log.warn('delete failed:', error);
                    if (!mountedRef.current || !isAuthIdentityScopeCurrent(slot.scope)) return;
                    unhide(slot.ids);
                    optionsRef.current.onCommitFailed?.(slot.item, error);
                },
            );
        },
        [releaseGone, takeSlot, unhide],
    );

    const remove = useCallback(
        (item: T) => {
            if (slotRef.current?.item.id === item.id) return; // already waiting
            // One undo slot: the earlier delete commits now, before this one takes it.
            flush();
            const ids = [item.id, ...(optionsRef.current.alsoHides?.(item) ?? [])];
            // A row deleted again (its id reused) is this delete's now.
            committedRef.current.delete(item.id);
            const deadline = Date.now() + UNDO_DELETE_MS;
            slotRef.current = {
                item,
                scope: getAuthIdentityScope(),
                ids,
                deadline,
                timer: setTimeout(() => flush(item.id), UNDO_DELETE_MS),
            };
            hide(ids);
            setWaiting({ item, deadline });
        },
        [flush, hide],
    );

    const undo = useCallback((): T | null => {
        const slot = takeSlot();
        if (!slot || !isAuthIdentityScopeCurrent(slot.scope)) return null;
        unhide(slot.ids);
        optionsRef.current.onRestored?.(slot.item);
        return slot.item;
    }, [takeSlot, unhide]);

    const commitNow = useCallback(() => flush(), [flush]);

    // Each load of the page's rows lets go of the committed rows it no longer has.
    const { rows } = options;
    useEffect(() => releaseGone(rows), [rows, releaseGone]);

    useEffect(() => {
        mountedRef.current = true;
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') flush();
        };
        const onPageHide = () => flush();
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('pagehide', onPageHide);
        const unsubscribe = subscribeAuthIdentityScope(() => {
            takeSlot();
            committedRef.current.clear();
            setHiddenIds(NOTHING_HIDDEN);
        });
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('pagehide', onPageHide);
            unsubscribe();
            mountedRef.current = false;
            // Back, a tab switch, the split pane closing: the delete still happens.
            flush();
        };
    }, [flush, takeSlot]);

    const waitingId = waiting?.item.id;
    return {
        hiddenIds,
        remove,
        undo,
        commitNow,
        toastProps: {
            key: waiting ? `${waiting.item.id}@${waiting.deadline}` : 'closed',
            isOpen: waiting !== null,
            message: waiting ? options.describe(waiting.item) : '',
            duration: UNDO_DELETE_MS,
            deadline: waiting?.deadline,
            onUndo: () => {
                undo();
            },
            onDismiss: () => {
                if (waitingId !== undefined) flush(waitingId);
            },
        },
    };
}
