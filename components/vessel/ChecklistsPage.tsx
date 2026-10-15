/**
 * ChecklistsPage — Pre-departure and operational checklists.
 *
 * Sub-components extracted to ./checklists/:
 *   - SwipeableItemCard: swipeable heading/detail card with reorder controls
 *   - PastRunsSheet: when each list was last run and what failed (lazy)
 */
import React, { Suspense, useState, useEffect, useCallback, useId, useMemo, useRef } from 'react';
import { createLogger } from '../../utils/createLogger';
import { lazyRetry } from '../../utils/lazyRetry';

const log = createLogger('ChecklistsPage');
import {
    LocalChecklistService,
    type ChecklistEntry,
    type ChecklistRun,
    type ChecklistRunItem,
    type RunItemStatus,
} from '../../services/vessel/LocalChecklistService';
import { LocalMaintenanceService } from '../../services/vessel/LocalMaintenanceService';
import { SharedBinderReadOnlyError } from '../../services/vessel/sharedBinders';
import { toLocalDateString } from '../../utils/localDate';
import { triggerHaptic } from '../../utils/system';
import { TapToAction } from '../ui/TapToAction';
import { PageHeader } from '../ui/PageHeader';
import { toast } from '../Toast';
import { CheckIcon, WrenchIcon, XIcon } from '../Icons';
import { ModalSheet } from '../ui/ModalSheet';
import { OverlayPortal } from '../ui/OverlayPortal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { UndoToast } from '../ui/UndoToast';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { LoadErrorState } from '../ui/LoadErrorState';
import { ShimmerBlock } from '../ui/ShimmerBlock';
import { OfflineBadge } from '../ui/OfflineBadge';
import { FormField } from '../ui/FormField';
import { generateUUID } from '../../services/vessel/LocalDatabase';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useRealtimeSyncMulti } from '../../hooks/useRealtimeSync';
import { useUndoDelete } from '../../hooks/useUndoDelete';
import { onSyncComplete } from '../../services/vessel/SyncService';
import { changedFields, REMOVED_ELSEWHERE, REMOVED_NOTHING_SAVED } from '../../utils/changedFields';
import { SwipeableItemCard } from './checklists/SwipeableItemCard';
import { clearRunDraft, readRunDraft, saveRunDraft } from '../../services/vessel/checklistRunDraft';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';

// Opened from the ⋮ only, so it is fetched only then (132-B16).
const PastRunsSheet = lazyRetry(
    () => import('./checklists/PastRunsSheet').then((m) => ({ default: m.PastRunsSheet })),
    'PastRunsSheet',
);

interface ChecklistsPageProps {
    onBack: () => void;
}

/** The run on screen: one checklist, ticked item by item (132-B16). */
interface ActiveRun {
    id: string;
    heading_id: string;
    heading: string;
    started_at: string;
}

// SwipeableItemCard now in ./checklists/SwipeableItemCard.tsx

/** Why a flagged repair did not reach Maintenance, for the log: a reason, never the item's name. */
function repairFailureReason(e: unknown): 'read-only' | 'local-db' | 'other' {
    if (e instanceof SharedBinderReadOnlyError) return 'read-only';
    if (e instanceof Error && e.message.includes('[LocalDB]')) return 'local-db';
    return 'other';
}

/**
 * The toast for repairs that did not reach Maintenance. Complete closes the
 * run, and Past runs (132-B16) shows what failed but not which repairs
 * landed, so it names them (on screen only; the log keeps a reason) and says
 * to add them in Maintenance by hand.
 */
function repairsNotAddedMessage(names: string[]): string {
    if (names.length === 1) return `Couldn't add “${names[0]}” to Maintenance — add it there by hand`;
    const shown = names.slice(0, 3).join(', ');
    const more = names.length > 3 ? ` and ${names.length - 3} more` : '';
    return `Couldn't add ${names.length} repairs to Maintenance (${shown}${more}) — add them there by hand`;
}

// ── Status colors for run mode ─────────────────────────────────

const STATUS_STYLES: Record<RunItemStatus, { bg: string; border: string; icon: string; text: string }> = {
    unchecked: {
        bg: 'bg-white/3',
        border: 'border-white/8',
        icon: 'text-gray-400',
        text: 'text-white/60',
    },
    pass: {
        bg: 'bg-emerald-500/10',
        border: 'border-emerald-500/25',
        icon: 'text-emerald-400',
        text: 'text-white',
    },
    fail: {
        bg: 'bg-red-500/10',
        border: 'border-red-500/25',
        icon: 'text-red-400',
        text: 'text-white',
    },
};

// ── Main Component ─────────────────────────────────────────────

export const ChecklistsPage: React.FC<ChecklistsPageProps> = ({ onBack }) => {
    const initialScope = getAuthIdentityScope();
    const [entries, setEntries] = useState<ChecklistEntry[]>([]);
    // Completed runs, from this device and the skipper's others (132-B16).
    const [runs, setRuns] = useState<ChecklistRun[]>([]);
    const [pastRunsOpen, setPastRunsOpen] = useState(false);
    const [dataScopeKey, setDataScopeKey] = useState(initialScope.key);
    const [loading, setLoading] = useState(true);
    // A failed fetch used to fall through to the empty state, so a network
    // error read as "nothing logged" — see components/ui/LoadErrorState.
    const [loadError, setLoadError] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
    // A checklist that still has items waits for one question before it goes.
    const [deleteAsk, setDeleteAsk] = useState<{
        scope: AuthIdentityScope;
        entry: ChecklistEntry;
        items: number;
    } | null>(null);

    // Add/Edit form state
    const [showForm, setShowForm] = useState(false);
    const [editEntry, setEditEntry] = useState<ChecklistEntry | null>(null);
    const [formType, setFormType] = useState<'heading' | 'detail'>('heading');
    const [formText, setFormText] = useState('');
    const [formHeadingId, setFormHeadingId] = useState<string>('');
    /** An Add in flight: a double tap on Add item made the item twice (132-B16, CHK-06). */
    const savingRef = useRef(false);
    const [saving, setSaving] = useState(false);
    /** The checklist made last on this visit: new items go under it (132-B16, CHK-09). */
    const lastHeadingIdRef = useRef<string | null>(null);

    // Run mode state
    const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
    const showRun = activeRun !== null;
    const [runItems, setRunItems] = useState<ChecklistRunItem[]>([]);
    // Leaving a run with anything checked asks first (132-B16, CHK-04).
    const [abandonAsk, setAbandonAsk] = useState(false);
    const [completing, setCompleting] = useState(false);
    const runTitleId = useId();
    const pageActionsButtonRef = useRef<HTMLButtonElement>(null);
    const runCloseButtonRef = useRef<HTMLButtonElement>(null);
    const mountedRef = useRef(true);
    /** A Complete in flight: a double tap saved the run, and every repair, twice. */
    const completingRef = useRef(false);
    /** Said once a run: this phone would not keep the run as it was ticked. */
    const draftWarnedRef = useRef(false);
    const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const currentOperation = useCallback(
        (scope: AuthIdentityScope) =>
            mountedRef.current && isAuthIdentityScopeCurrent(scope) && dataScopeKey === scope.key,
        [dataScopeKey],
    );
    /** The run is over (completed or discarded): nothing to bring back. */
    const closeRun = useCallback((scope: AuthIdentityScope) => {
        clearRunDraft(scope);
        setActiveRun(null);
        setRunItems([]);
        setAbandonAsk(false);
    }, []);
    const exitRun = useCallback(() => {
        const scope = getAuthIdentityScope();
        if (!currentOperation(scope) || completingRef.current) return;
        // Nothing checked yet is nothing to lose: no question.
        if (runItems.some((item) => item.status !== 'unchecked')) setAbandonAsk(true);
        else closeRun(scope);
    }, [closeRun, currentOperation, runItems]);
    const runDialogRef = useFocusTrap(showRun, {
        initialFocusRef: runCloseButtonRef,
        onEscape: exitRun,
    });

    // Every tick is kept on the phone as it lands (132-B16, CHK-04): a crash,
    // or iOS closing the app in the background, used to lose the whole run.
    // Not while Complete saves: once saved the phone's copy is cleared, and
    // writing it back brought a completed run back to be completed again.
    useEffect(() => {
        if (!activeRun || completingRef.current) return;
        const scope = getAuthIdentityScope();
        if (!currentOperation(scope)) return;
        if (saveRunDraft({ ...activeRun, items: runItems }, scope) || draftWarnedRef.current) return;
        draftWarnedRef.current = true;
        log.warn('checklists: run-draft-not-kept');
        toast.error("This phone couldn't keep the run as you go. Complete it before you close the app.", 8000);
    }, [activeRun, currentOperation, runItems]);

    // A run left in progress (the app closed or crashed) comes back as it was
    // left, under the account that ran it (132-B16, CHK-04).
    const resumeRun = useCallback((scope: AuthIdentityScope) => {
        const draft = readRunDraft(scope);
        if (!draft || !mountedRef.current || !isAuthIdentityScopeCurrent(scope)) return;
        draftWarnedRef.current = false;
        setActiveRun({
            id: draft.id,
            heading_id: draft.heading_id,
            heading: draft.heading,
            started_at: draft.started_at,
        });
        setRunItems(draft.items);
        toast.info(`Your “${draft.heading}” run is back where you left it`);
    }, []);

    // ── Load ──
    // A background reload (a change from another device, a sync) keeps the
    // list on screen and its scroll: no shimmer, and a failed read keeps what
    // is shown rather than swapping it for the error state.
    const loadEntries = useCallback((background = false) => {
        const scope = getAuthIdentityScope();
        if (!background) {
            setLoadError(false);
            setLoading(true);
        }
        try {
            const loaded = LocalChecklistService.getAll();
            const loadedRuns = LocalChecklistService.getRuns().filter((run) => run.completed_at);
            if (!isAuthIdentityScopeCurrent(scope)) return;
            setDataScopeKey(scope.key);
            setEntries(loaded);
            setRuns(loadedRuns);
            setLoadError(false);
        } catch (e) {
            log.error('Failed to load checklists:', e);
            if (!background && isAuthIdentityScopeCurrent(scope)) {
                setLoadError(true);
                toast.error('Failed to load checklists');
            }
        } finally {
            if (!background && isAuthIdentityScopeCurrent(scope)) setLoading(false);
        }
    }, []);
    const reloadInBackground = useCallback(() => loadEntries(true), [loadEntries]);

    // Soft delete with undo (126-B10b), as the other binders have had since
    // 126-B10a: a deleted checklist or item stays in state, hidden, until its
    // delete is committed (on Back too), so no reload brings it back and Undo
    // returns it once, in its place. A checklist hides its items with it, and
    // nothing leaves this device until the five seconds are up, so an Undo
    // leaves no other device anything to bring back.
    const undoDelete = useUndoDelete<ChecklistEntry>({
        rows: entries,
        // The service takes a checklist's items with it (the server cascades too).
        commit: (entry) => LocalChecklistService.delete(entry.id),
        onCommitted: () => reloadInBackground(),
        onCommitFailed: () => toast.error('Failed to delete'),
        onRestored: (entry) => toast.success(entry.type === 'heading' ? 'Checklist restored' : 'Item restored'),
        describe: (entry) => `"${entry.text}" deleted`,
        alsoHides: (entry) =>
            entry.type === 'heading'
                ? entries.filter((e) => e.type === 'detail' && e.heading_id === entry.id).map((e) => e.id)
                : [],
    });
    const { hiddenIds } = undoDelete;
    const { key: undoToastKey, ...undoToastProps } = undoDelete.toastProps;

    useEffect(() => {
        mountedRef.current = true;
        loadEntries();
        resumeRun(getAuthIdentityScope());
        const unsubscribe = subscribeAuthIdentityScope((next) => {
            if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
            setDataScopeKey(next.key);
            setEntries([]);
            setRuns([]);
            setPastRunsOpen(false);
            setLoading(true);
            setSearchQuery('');
            setHeaderMenuOpen(false);
            setDeleteAsk(null);
            setShowForm(false);
            setEditEntry(null);
            setFormType('heading');
            setFormText('');
            setFormHeadingId('');
            lastHeadingIdRef.current = null;
            // The run stays on the phone under its own account, for when it signs back in.
            setActiveRun(null);
            setRunItems([]);
            setAbandonAsk(false);
            reloadTimerRef.current = setTimeout(() => {
                if (!isAuthIdentityScopeCurrent(next)) return;
                loadEntries();
                resumeRun(next);
            }, 0);
        });
        return () => {
            mountedRef.current = false;
            if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
            reloadTimerRef.current = null;
            unsubscribe();
        };
    }, [loadEntries, resumeRun]);

    // Live across devices (126-B9a): a change saved on the sailor's other
    // device lands within seconds, on one channel for the lists and their
    // runs; a sync that pulled or pruned rows (deleted elsewhere while the
    // socket was down) reloads too.
    useRealtimeSyncMulti(['checklists', 'checklist_runs'], reloadInBackground);
    useEffect(
        () =>
            onSyncComplete((result) => {
                if (result.pulled > 0 || (result.pruned ?? 0) > 0) reloadInBackground();
            }),
        [reloadInBackground],
    );

    // ── Computed ──
    // Without what waits out its Undo: an item added on another device to a
    // checklist being deleted goes with it, so it is hidden with it too.
    const visibleEntries = useMemo(() => {
        if (dataScopeKey !== getAuthIdentityScope().key) return [];
        if (hiddenIds.size === 0) return entries;
        return entries.filter((e) => !hiddenIds.has(e.id) && !(e.heading_id && hiddenIds.has(e.heading_id)));
    }, [dataScopeKey, entries, hiddenIds]);

    const headings = useMemo(() => visibleEntries.filter((e) => e.type === 'heading'), [visibleEntries]);

    // Deleted on another device while the form is open: the entry being
    // edited, or the last checklist an item could go under, closes the form
    // rather than save into nothing (every open resets its fields). A picked
    // checklist that is gone falls back to one still there, the one the picker
    // already shows. The page's own delete closes the form first. A run in
    // progress keeps its snapshot: it is a record of what was checked.
    useEffect(() => {
        if (!showForm || loading) return;
        const live = editEntry && visibleEntries.find((e) => e.id === editEntry.id);
        const headingGone = formType === 'detail' && !headings.some((h) => h.id === formHeadingId);
        if ((editEntry && !live) || (headingGone && !headings.length)) {
            setShowForm(false);
            setEditEntry(null);
            toast.info(REMOVED_ELSEWHERE);
        } else if (headingGone) {
            setFormHeadingId((headings.find((h) => h.id === live?.heading_id) ?? headings[0]).id);
        }
    }, [showForm, editEntry, loading, visibleEntries, headings, formType, formHeadingId]);

    const grouped = useMemo(
        () =>
            headings.map((h) => ({
                heading: h,
                items: visibleEntries
                    .filter((e) => e.type === 'detail' && e.heading_id === h.id)
                    .sort((a, b) => a.order - b.order),
            })),
        [headings, visibleEntries],
    );

    // A checklist whose name matches keeps all its items (132-B16, CHK-11):
    // searching 'anchor' found the Anchoring list and showed it empty.
    const filtered = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return grouped;
        return grouped
            .map((g) =>
                g.heading.text.toLowerCase().includes(q)
                    ? g
                    : { ...g, items: g.items.filter((i) => i.text.toLowerCase().includes(q)) },
            )
            .filter((g) => g.heading.text.toLowerCase().includes(q) || g.items.length > 0);
    }, [grouped, searchQuery]);

    // A checklist runs whole, whatever a search is showing of it.
    const runnable = useMemo(
        () => new Set(grouped.filter((g) => g.items.length > 0).map((g) => g.heading.id)),
        [grouped],
    );

    const totalDetails = useMemo(() => visibleEntries.filter((e) => e.type === 'detail').length, [visibleEntries]);

    // ── Form handlers ──
    const resetForm = () => {
        setFormText('');
        setFormType('heading');
        setFormHeadingId('');
        setEditEntry(null);
    };

    // The checklist made last on this visit while it is still here, else the
    // first (132-B16, CHK-09): always the first put a new list's items in another.
    const defaultHeadingId = () => headings.find((h) => h.id === lastHeadingIdRef.current)?.id ?? headings[0]?.id ?? '';

    const openAddForm = () => {
        resetForm();
        // Default to 'detail' if headings exist, otherwise 'heading'
        setFormType(headings.length > 0 ? 'detail' : 'heading');
        if (headings.length > 0) setFormHeadingId(defaultHeadingId());
        setShowForm(true);
    };

    const openEditForm = (entry: ChecklistEntry) => {
        setEditEntry(entry);
        setFormType(entry.type);
        setFormText(entry.text);
        setFormHeadingId(entry.heading_id || '');
        setShowForm(true);
    };

    const handleSave = useCallback(async () => {
        if (!formText.trim() || savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        const scope = getAuthIdentityScope();
        const text = formText.trim();
        const headingId = formType === 'detail' ? formHeadingId : null;
        try {
            triggerHaptic('medium');
            if (editEntry) {
                // Only what was changed against the item as the form opened, so
                // a move or rename made on another device meanwhile stands.
                const updates = changedFields(editEntry, { text, heading_id: headingId });
                if (Object.keys(updates).length) {
                    const saved = await LocalChecklistService.update(editEntry.id, updates);
                    if (!currentOperation(scope)) return;
                    // A null write: the row was gone (deleted elsewhere) when it landed.
                    if (saved) toast.success('Updated');
                    else toast.error(REMOVED_NOTHING_SAVED);
                }
                setShowForm(false);
                resetForm();
            } else {
                const created = await LocalChecklistService.create({
                    type: formType,
                    text,
                    heading_id: headingId,
                });
                if (!currentOperation(scope)) return;
                toast.success(formType === 'heading' ? 'Checklist added' : 'Item added');
                if (formType === 'heading') {
                    // Its items come next, so the form turns to Item, under
                    // the checklist just made (132-B16, CHK-09).
                    lastHeadingIdRef.current = created.id;
                    setFormType('detail');
                    setFormHeadingId(created.id);
                }
                // Keep form open — just clear text so user can add more
                setFormText('');
            }
            loadEntries();
        } catch (e) {
            log.error('Failed to save:', e);
            if (currentOperation(scope)) toast.error('Failed to save');
        } finally {
            savingRef.current = false;
            if (mountedRef.current) setSaving(false);
        }
    }, [currentOperation, editEntry, formText, formType, formHeadingId, loadEntries]);

    // ── Delete, with its Undo (useUndoDelete above) ──
    const { remove: removeEntry } = undoDelete;
    const handleDelete = useCallback(
        (id: string) => {
            const scope = getAuthIdentityScope();
            const entry = visibleEntries.find((e) => e.id === id);
            if (!entry || !currentOperation(scope)) return;
            triggerHaptic('medium');
            // A checklist that still has items asks once and says how many go
            // with it (126-B10b, CHK-05): it used to refuse with a toast, so a
            // list of twenty items took twenty swipes to clear.
            const items =
                entry.type === 'heading'
                    ? visibleEntries.filter((e) => e.type === 'detail' && e.heading_id === id).length
                    : 0;
            if (items > 0) setDeleteAsk({ scope, entry, items });
            else removeEntry(entry);
        },
        [currentOperation, removeEntry, visibleEntries],
    );

    // ── Reorder items ──
    const handleMoveItem = useCallback(
        async (groupItems: ChecklistEntry[], itemIndex: number, direction: 'up' | 'down') => {
            const targetIndex = direction === 'up' ? itemIndex - 1 : itemIndex + 1;
            if (targetIndex < 0 || targetIndex >= groupItems.length) return;
            const scope = getAuthIdentityScope();
            triggerHaptic('light');
            const itemA = { ...groupItems[itemIndex] };
            const itemB = { ...groupItems[targetIndex] };
            // Swap their order values
            try {
                await LocalChecklistService.update(itemA.id, { order: itemB.order });
                if (!currentOperation(scope)) return;
                await LocalChecklistService.update(itemB.id, { order: itemA.order });
                if (!currentOperation(scope)) return;
                loadEntries();
            } catch (e) {
                log.error('Failed to reorder:', e);
                if (currentOperation(scope)) toast.error('Failed to reorder');
            }
        },
        [currentOperation, loadEntries],
    );

    // ── Run mode ──
    // One checklist at a time, from its own Run button (132-B16, CHK-03): the
    // ⋮'s Run checklist ticked every list on the page in one run, so a
    // pre-departure check came with the anchoring and heavy-weather lists.
    const startRun = useCallback(
        (headingId: string) => {
            const scope = getAuthIdentityScope();
            if (!currentOperation(scope)) return;
            const group = grouped.find((g) => g.heading.id === headingId);
            if (!group || group.items.length === 0) {
                toast.error('No items to check — add some first');
                return;
            }
            triggerHaptic('medium');
            const items: ChecklistRunItem[] = group.items.map((item) => ({
                entry_id: item.id,
                heading: group.heading.text,
                heading_id: group.heading.id,
                text: item.text,
                status: 'unchecked' as RunItemStatus,
                flagged_rm: false,
                notes: '',
            }));
            draftWarnedRef.current = false;
            setRunItems(items);
            setActiveRun({
                id: generateUUID(),
                heading_id: group.heading.id,
                heading: group.heading.text,
                started_at: new Date().toISOString(),
            });
        },
        [currentOperation, grouped],
    );

    const openPastRuns = useCallback(() => {
        pageActionsButtonRef.current?.focus();
        setHeaderMenuOpen(false);
        setPastRunsOpen(true);
    }, []);

    // Ticks and flags wait while Complete saves (132-B16): the run saved is the
    // one on screen when Complete was tapped, so a tick then was left out of
    // it, and kept on the phone as a run still to finish.
    const toggleRunItem = useCallback(
        (entryId: string) => {
            const scope = getAuthIdentityScope();
            if (!currentOperation(scope) || completingRef.current) return;
            triggerHaptic('light');
            setRunItems((prev) =>
                prev.map((item) => {
                    if (item.entry_id !== entryId) return item;
                    // Cycle: unchecked → pass → fail → unchecked
                    const next: RunItemStatus =
                        item.status === 'unchecked' ? 'pass' : item.status === 'pass' ? 'fail' : 'unchecked';
                    return { ...item, status: next, flagged_rm: next === 'fail' ? item.flagged_rm : false };
                }),
            );
        },
        [currentOperation],
    );

    const toggleRmFlag = useCallback(
        (entryId: string) => {
            const scope = getAuthIdentityScope();
            if (!currentOperation(scope) || completingRef.current) return;
            triggerHaptic('light');
            setRunItems((prev) =>
                prev.map((item) => {
                    if (item.entry_id !== entryId) return item;
                    return { ...item, flagged_rm: !item.flagged_rm };
                }),
            );
        },
        [currentOperation],
    );

    const finishRun = useCallback(async () => {
        const scope = getAuthIdentityScope();
        if (!currentOperation(scope) || !activeRun) return;
        triggerHaptic('heavy');
        const run: ChecklistRun = {
            id: activeRun.id,
            // When the run began (it used to read Complete's time). Completed
            // is never before it: the server refuses such a run, and a phone
            // clock set back mid-run would otherwise produce one.
            started_at: activeRun.started_at,
            completed_at: new Date(Math.max(Date.now(), Date.parse(activeRun.started_at) || 0)).toISOString(),
            items: runItems.map((item) => ({ ...item })),
        };
        try {
            await LocalChecklistService.saveRun(run);
        } catch (e) {
            // Nothing was saved: the run stays on screen, and on the phone, for another Complete.
            log.error('Failed to save checklist run:', e);
            if (currentOperation(scope)) toast.error("Couldn't save this run. Try Complete again.");
            return;
        }
        // Saved, so the phone's copy is done with, whoever is signed in now.
        clearRunDraft(scope);
        if (!currentOperation(scope)) return;
        // Past runs has it now.
        reloadInBackground();

        // Create R&M tasks for flagged items, counting what actually landed:
        // the toast used to count the flags, so a repair that failed to save
        // still read as added (binder audit CHK-02).
        const flagged = runItems.filter((i) => i.flagged_rm);
        let added = 0;
        const notAdded: string[] = [];
        for (const item of flagged) {
            try {
                await LocalMaintenanceService.createTask({
                    title: `[Checklist] ${item.text}`,
                    description: `Flagged during checklist run (${item.heading}). Status: FAIL.`,
                    category: 'Repair',
                    trigger_type: 'monthly',
                    interval_value: 30,
                    // Today on the skipper's own calendar, not the UTC day.
                    next_due_date: toLocalDateString(),
                    next_due_hours: null,
                    last_completed: null,
                    is_active: true,
                });
                added++;
                if (!currentOperation(scope)) return;
            } catch (e) {
                notAdded.push(item.text);
                log.warn(`checklists: repair-not-added (${repairFailureReason(e)})`);
            }
        }

        const passCount = runItems.filter((i) => i.status === 'pass').length;
        const failCount = runItems.filter((i) => i.status === 'fail').length;
        const total = runItems.length;

        setActiveRun(null);
        setRunItems([]);

        if (failCount > 0) {
            toast.error(`Checklist complete — ${failCount} item${failCount > 1 ? 's' : ''} failed`);
        } else if (passCount === total) {
            toast.success('All items passed');
        } else {
            toast.success(`Checklist complete — ${passCount}/${total} checked`);
        }

        if (added > 0) {
            toast.info(`${added} repair${added > 1 ? 's' : ''} added to Maintenance`);
        }
        // Held twice the usual 4 s: it names what to add by hand.
        if (notAdded.length > 0) toast.error(repairsNotAddedMessage(notAdded), 8000);
    }, [activeRun, currentOperation, reloadInBackground, runItems]);

    // One Complete at a time (the Complete half of CHK-06, pulled forward from
    // 126-B16): a double tap doubled the very repair count above. The button
    // greys while it saves (132-B16), so the first tap visibly took.
    const completeRun = useCallback(async () => {
        if (completingRef.current) return;
        completingRef.current = true;
        setCompleting(true);
        try {
            await finishRun();
        } finally {
            completingRef.current = false;
            if (mountedRef.current) setCompleting(false);
        }
    }, [finishRun]);

    // Run progress
    const runPassCount = runItems.filter((i) => i.status === 'pass').length;
    const runFailCount = runItems.filter((i) => i.status === 'fail').length;
    const runCheckedCount = runPassCount + runFailCount;
    const runTotal = runItems.length;
    const runProgress = runTotal > 0 ? runCheckedCount / runTotal : 0;

    // Group run items by heading
    const runGrouped = runItems.reduce<{ heading: string; items: ChecklistRunItem[] }[]>((acc, item) => {
        const group = acc.find((g) => g.heading === item.heading);
        if (group) {
            group.items.push(item);
        } else {
            acc.push({ heading: item.heading, items: [item] });
        }
        return acc;
    }, []);

    // ── Render ──
    return (
        <div className="relative h-full bg-slate-950 overflow-hidden slide-up-enter">
            <div className="flex flex-col h-full">
                <PageHeader
                    title="Checklists"
                    onBack={onBack}
                    breadcrumbs={['Boat Binder', 'Checklists']}
                    status={<OfflineBadge />}
                    // One term for one thing (UX scorecard run 6): a heading IS a
                    // checklist — pre-departure, anchoring — and its rows are items.
                    // While there are none, what the page is for rather than
                    // '0 checklists' under CHECKLISTS, the word twice (run 9), and
                    // in PageHeader's own caption style, as Maintenance and Polars
                    // set theirs: in the bold count style it read as a count (run 10).
                    // Count first: LoadErrorNotEmpty pins the page's load-error
                    // branch ahead of its empty-list branch in source order.
                    subtitle={
                        headings.length > 0 ? (
                            <p className="text-label text-gray-400 font-bold uppercase tracking-widest">
                                {`${headings.length} checklist${headings.length !== 1 ? 's' : ''} · ${totalDetails} item${totalDetails !== 1 ? 's' : ''}`}
                            </p>
                        ) : (
                            'Pre‑departure & passage lists'
                        )
                    }
                    // The menu's one action is Past runs (132-B16; Run moved onto
                    // each checklist), so the ⋮ waits for a completed run instead
                    // of opening onto an empty sheet (UX scorecard run 8), as the
                    // Diary's waits for its own.
                    action={
                        runs.length > 0 ? (
                            <div className="relative">
                                <button
                                    type="button"
                                    ref={pageActionsButtonRef}
                                    onClick={() => setHeaderMenuOpen(!headerMenuOpen)}
                                    className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
                                    aria-label="Page actions"
                                >
                                    <svg
                                        aria-hidden="true"
                                        className="w-5 h-5 text-gray-400"
                                        viewBox="0 0 24 24"
                                        fill="currentColor"
                                    >
                                        <circle cx="12" cy="5" r="1.5" />
                                        <circle cx="12" cy="12" r="1.5" />
                                        <circle cx="12" cy="19" r="1.5" />
                                    </svg>
                                </button>
                                {headerMenuOpen && (
                                    <>
                                        <div className="fixed inset-0 z-40" onClick={() => setHeaderMenuOpen(false)} />
                                        <div className="absolute right-0 top-full mt-1 z-50 w-52 bg-slate-800 border border-white/10 rounded-xl shadow-2xl overflow-hidden">
                                            <button
                                                type="button"
                                                onClick={openPastRuns}
                                                className="w-full flex items-center gap-2.5 px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors"
                                            >
                                                <svg
                                                    aria-hidden="true"
                                                    className="w-4 h-4 text-emerald-400"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                    strokeWidth={2}
                                                >
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
                                                    />
                                                </svg>
                                                Past runs
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        ) : undefined
                    }
                />

                {/* Search — only once there is something to search (UX scorecard
                    run 7: a live field sat over an empty list). */}
                {(visibleEntries.length > 0 || searchQuery) && (
                    <div className="shrink-0 px-4 pb-3">
                        <input
                            type="text"
                            aria-label="Search checklists"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search checklists and items…"
                            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-400 [.display-light_&]:placeholder-slate-600! outline-hidden focus:border-sky-500/30"
                        />
                    </div>
                )}

                {/* Checklist entries (scrollable, grouped) */}
                <div className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 space-y-4">
                    {loading ? (
                        <div className="space-y-3">
                            <ShimmerBlock variant="list" rows={3} />
                        </div>
                    ) : loadError ? (
                        <LoadErrorState what="checklists" onRetry={loadEntries} />
                    ) : filtered.length === 0 ? (
                        <EmptyState
                            icon={
                                <svg
                                    className="w-8 h-8"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={1.5}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                    />
                                </svg>
                            }
                            title={searchQuery ? 'No matches' : 'No checklists yet'}
                            // Non-breaking hyphens (U+2011) in 'pre-departure' and
                            // 'heavy-weather': the latter split at its hyphen across two
                            // lines at 393 and 375 (UX scorecard run 8). Says the lists
                            // are the skipper's own to write: 'Start with a pre-departure…
                            // checklist' read as an offer of ready-made ones that the
                            // page does not have (UX scorecard run 9).
                            subtitle={
                                searchQuery
                                    ? 'Try a different search term.'
                                    : 'Write your own, such as a pre‑departure, anchoring or heavy‑weather list. Tap New checklist below.'
                            }
                            className="py-16"
                        />
                    ) : (
                        filtered.map((group) => (
                            <div key={group.heading.id}>
                                <SwipeableItemCard
                                    entry={group.heading}
                                    onEdit={() => openEditForm(group.heading)}
                                    onDelete={() => handleDelete(group.heading.id)}
                                    isHeading
                                    itemCount={group.items.length}
                                    onRun={
                                        runnable.has(group.heading.id) ? () => startRun(group.heading.id) : undefined
                                    }
                                />
                                <div className="space-y-1.5 mt-1.5">
                                    {group.items.map((item, idx) => (
                                        <SwipeableItemCard
                                            key={item.id}
                                            entry={item}
                                            onEdit={() => openEditForm(item)}
                                            onDelete={() => handleDelete(item.id)}
                                            onMoveUp={() => handleMoveItem(group.items, idx, 'up')}
                                            onMoveDown={() => handleMoveItem(group.items, idx, 'down')}
                                            isFirst={idx === 0}
                                            isLast={idx === group.items.length - 1}
                                        />
                                    ))}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* Add CTA */}
                <div
                    className="shrink-0 px-4 pt-2 bg-slate-950"
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                >
                    <TapToAction
                        // Items live in a checklist, so with none yet the only thing
                        // this can add is a checklist (UX scorecard run 7).
                        label={headings.length === 0 ? 'New checklist' : 'Add checklist or item'}
                        icon={
                            <svg
                                className="w-4 h-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2.5}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                            </svg>
                        }
                        onConfirm={() => {
                            triggerHaptic('medium');
                            openAddForm();
                        }}
                        theme="emerald"
                    />
                </div>

                {/* ═══ ADD / EDIT MODAL ═══ */}
                {showForm && (
                    <ModalSheet
                        isOpen={true}
                        onClose={() => {
                            setShowForm(false);
                            resetForm();
                        }}
                        title={
                            editEntry
                                ? editEntry.type === 'heading'
                                    ? 'Edit checklist'
                                    : 'Edit item'
                                : headings.length === 0
                                  ? 'New checklist'
                                  : 'Add to checklists'
                        }
                    >
                        {/* Type toggle — Heading or Detail */}
                        {!editEntry && (
                            <div className="mb-4">
                                <label className="text-label text-gray-400 font-bold uppercase tracking-widest block mb-2">
                                    Type
                                </label>
                                <div className="grid grid-cols-2 gap-2">
                                    <button
                                        aria-pressed={formType === 'heading'}
                                        onClick={() => setFormType('heading')}
                                        type="button"
                                        className={`min-h-[44px] py-3 rounded-xl text-sm font-black transition-all ${
                                            formType === 'heading'
                                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                                : 'bg-white/5 text-gray-400 border border-white/5'
                                        }`}
                                    >
                                        <svg
                                            aria-hidden="true"
                                            className="w-5 h-5 mx-auto mb-1"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={1.5}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"
                                            />
                                        </svg>
                                        Checklist
                                    </button>
                                    <button
                                        aria-pressed={formType === 'detail'}
                                        onClick={() => {
                                            setFormType('detail');
                                            if (headings.length > 0 && !formHeadingId)
                                                setFormHeadingId(defaultHeadingId());
                                        }}
                                        disabled={headings.length === 0}
                                        type="button"
                                        className={`min-h-[44px] py-3 rounded-xl text-sm font-black transition-all ${
                                            formType === 'detail'
                                                ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                                                : 'bg-white/5 text-gray-400 border border-white/5'
                                        } disabled:opacity-30 disabled:cursor-not-allowed`}
                                    >
                                        <svg
                                            aria-hidden="true"
                                            className="w-5 h-5 mx-auto mb-1"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={1.5}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                            />
                                        </svg>
                                        Item
                                    </button>
                                </div>
                                {headings.length === 0 && formType === 'heading' && (
                                    <p className="text-micro text-amber-400/80 mt-2 text-center">
                                        Add a checklist first, then you can add items to it
                                    </p>
                                )}
                            </div>
                        )}

                        {/* Heading dropdown (for details only) */}
                        {formType === 'detail' && headings.length > 0 && (
                            <div className="mb-3">
                                <label className="text-label text-gray-400 font-bold uppercase tracking-widest block mb-1.5">
                                    Under checklist
                                </label>
                                <select
                                    value={formHeadingId}
                                    onChange={(e) => setFormHeadingId(e.target.value)}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white outline-hidden focus:border-sky-500/30 appearance-none"
                                >
                                    {headings.map((h) => (
                                        <option key={h.id} value={h.id} className="bg-slate-800">
                                            {h.text}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {/* Text input */}
                        <div className="mb-4">
                            <FormField
                                label={formType === 'heading' ? 'Checklist name' : 'Check item'}
                                value={formText}
                                onChange={setFormText}
                                placeholder={
                                    formType === 'heading'
                                        ? 'Pre-start, shut down, navigation…'
                                        : 'Check oil level, test bilge pump…'
                                }
                                required
                            />
                        </div>

                        {!formText.trim() && (
                            <p className="text-micro text-amber-400/80 text-center mt-2">
                                {formType === 'heading' ? 'Checklist name' : 'Item description'} is required
                            </p>
                        )}
                        <Button
                            variant="primary"
                            onClick={handleSave}
                            disabled={!formText.trim() || saving}
                            aria-busy={saving || undefined}
                            className="w-full mt-1 disabled:cursor-not-allowed"
                        >
                            {editEntry ? 'Save changes' : formType === 'heading' ? 'Add checklist' : 'Add item'}
                        </Button>

                        {/* Delete button — only in edit mode. A checklist with
                            items asks first, as its swipe does (126-B10b). */}
                        {editEntry && (
                            <Button
                                variant="danger"
                                onClick={() => {
                                    handleDelete(editEntry.id);
                                    setShowForm(false);
                                    resetForm();
                                }}
                                className="w-full mt-2"
                            >
                                Delete {editEntry.type === 'heading' ? 'checklist' : 'item'}
                            </Button>
                        )}
                    </ModalSheet>
                )}

                {/* ═══ RUN CHECKLIST OVERLAY ═══ */}
                {/* The shared overlay shell (132-B16, CHK-13): its own portal sat
                    at a hand-set z-999 and left its pane unlocked in split view. */}
                {showRun && (
                    <OverlayPortal
                        ref={runDialogRef}
                        className="bg-slate-950 flex flex-col"
                        style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby={runTitleId}
                    >
                        {/* Run header */}
                        <div className="shrink-0 px-4 pb-3">
                            <div className="flex items-center justify-between mb-3">
                                <button
                                    type="button"
                                    ref={runCloseButtonRef}
                                    aria-label="Exit checklist run"
                                    onClick={exitRun}
                                    className="flex h-11 w-11 -ml-2 items-center justify-center rounded-xl hover:bg-white/5 transition-colors"
                                >
                                    <svg
                                        className="w-5 h-5 text-gray-400"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M15.75 19.5L8.25 12l7.5-7.5"
                                        />
                                    </svg>
                                </button>
                                <h2 id={runTitleId} className="text-lg font-black text-white tracking-wide">
                                    Run checklist
                                </h2>
                                <div className="w-11" aria-hidden="true" />
                            </div>

                            {/* Progress bar */}
                            <div
                                className="relative h-2 rounded-full bg-white/6 overflow-hidden mb-1"
                                role="progressbar"
                                aria-label="Checklist completion"
                                aria-valuemin={0}
                                aria-valuemax={runTotal}
                                aria-valuenow={runCheckedCount}
                                aria-valuetext={`${runCheckedCount} of ${runTotal} checked`}
                            >
                                <div
                                    className="absolute inset-y-0 left-0 rounded-full transition-all duration-500 ease-out"
                                    style={{
                                        width: `${runProgress * 100}%`,
                                        background:
                                            runFailCount > 0
                                                ? 'linear-gradient(90deg, rgba(239,68,68,0.6) 0%, rgba(239,68,68,0.8) 100%)'
                                                : 'linear-gradient(90deg, rgba(16,185,129,0.4) 0%, rgba(16,185,129,0.8) 100%)',
                                    }}
                                />
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-micro text-gray-400 font-bold uppercase tracking-widest">
                                    {runCheckedCount}/{runTotal} checked
                                </span>
                                <div className="flex items-center gap-3">
                                    {runPassCount > 0 && (
                                        <span className="inline-flex items-center gap-1 text-micro text-emerald-400 font-bold">
                                            <CheckIcon className="h-3 w-3 shrink-0" />
                                            {runPassCount}
                                            <span className="sr-only"> passed</span>
                                        </span>
                                    )}
                                    {runFailCount > 0 && (
                                        <span className="inline-flex items-center gap-1 text-micro text-red-400 font-bold">
                                            <XIcon className="h-3 w-3 shrink-0" />
                                            {runFailCount}
                                            <span className="sr-only"> failed</span>
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Run items list */}
                        <div className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 space-y-5">
                            {runGrouped.map((group) => (
                                <div key={group.heading}>
                                    {/* Section header */}
                                    <div className="flex items-center gap-2 mb-2.5 sticky top-0 bg-slate-950 py-1 z-10">
                                        <div className="w-1 h-4 rounded-full bg-emerald-500" />
                                        <span className="text-micro font-black text-emerald-400 uppercase tracking-[0.2em]">
                                            {group.heading}
                                        </span>
                                    </div>

                                    <div className="space-y-2">
                                        {group.items.map((item) => {
                                            const styles = STATUS_STYLES[item.status];
                                            const nextStatus: RunItemStatus =
                                                item.status === 'unchecked'
                                                    ? 'pass'
                                                    : item.status === 'pass'
                                                      ? 'fail'
                                                      : 'unchecked';
                                            const statusLabel =
                                                item.status === 'unchecked'
                                                    ? 'not checked'
                                                    : item.status === 'pass'
                                                      ? 'passed'
                                                      : 'failed';
                                            const nextStatusLabel =
                                                nextStatus === 'unchecked'
                                                    ? 'not checked'
                                                    : nextStatus === 'pass'
                                                      ? 'passed'
                                                      : 'failed';
                                            return (
                                                <div
                                                    key={item.entry_id}
                                                    className={`rounded-xl border ${styles.border} ${styles.bg} overflow-hidden transition-all duration-200`}
                                                >
                                                    <div className="flex items-center gap-2 p-3.5">
                                                        <button
                                                            type="button"
                                                            onClick={() => toggleRunItem(item.entry_id)}
                                                            disabled={completing}
                                                            className="flex flex-1 min-w-0 min-h-[44px] items-center gap-3 text-left rounded-lg active:scale-[0.98] transition-transform"
                                                            aria-label={`${item.text}: ${statusLabel}. Change status to ${nextStatusLabel}`}
                                                        >
                                                            {/* Status checkbox */}
                                                            <span
                                                                className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-all ${
                                                                    item.status === 'pass'
                                                                        ? 'bg-emerald-500/20'
                                                                        : item.status === 'fail'
                                                                          ? 'bg-red-500/20'
                                                                          : 'bg-white/5'
                                                                }`}
                                                                aria-hidden="true"
                                                            >
                                                                {item.status === 'pass' && (
                                                                    <svg
                                                                        className="w-4 h-4 text-emerald-400"
                                                                        fill="none"
                                                                        viewBox="0 0 24 24"
                                                                        stroke="currentColor"
                                                                        strokeWidth={3}
                                                                    >
                                                                        <path
                                                                            strokeLinecap="round"
                                                                            strokeLinejoin="round"
                                                                            d="M5 13l4 4L19 7"
                                                                        />
                                                                    </svg>
                                                                )}
                                                                {item.status === 'fail' && (
                                                                    <svg
                                                                        className="w-4 h-4 text-red-400"
                                                                        fill="none"
                                                                        viewBox="0 0 24 24"
                                                                        stroke="currentColor"
                                                                        strokeWidth={3}
                                                                    >
                                                                        <path
                                                                            strokeLinecap="round"
                                                                            strokeLinejoin="round"
                                                                            d="M6 18L18 6M6 6l12 12"
                                                                        />
                                                                    </svg>
                                                                )}
                                                                {item.status === 'unchecked' && (
                                                                    <span className="w-4 h-4 rounded-sm border-2 border-gray-500/40" />
                                                                )}
                                                            </span>

                                                            {/* Label */}
                                                            <span
                                                                className={`text-sm font-medium flex-1 ${styles.text} ${
                                                                    item.status === 'pass'
                                                                        ? 'line-through opacity-60'
                                                                        : ''
                                                                }`}
                                                            >
                                                                {item.text}
                                                            </span>
                                                        </button>

                                                        {/* R&M flag button (visible when failed) */}
                                                        {item.status === 'fail' && (
                                                            <button
                                                                type="button"
                                                                aria-label={`Flag ${item.text} for repair and maintenance`}
                                                                aria-pressed={item.flagged_rm}
                                                                onClick={() => toggleRmFlag(item.entry_id)}
                                                                disabled={completing}
                                                                className={`hit-target-44 shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-micro font-bold uppercase tracking-wider transition-all ${
                                                                    item.flagged_rm
                                                                        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                                                                        : 'bg-white/5 text-gray-400 border border-white/10 hover:text-amber-400'
                                                                }`}
                                                            >
                                                                <WrenchIcon className="w-3 h-3" />
                                                                Log repair
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Complete button */}
                        <div
                            className="shrink-0 px-4 pt-3 bg-slate-950"
                            style={{ paddingBottom: 'calc(5rem + env(safe-area-inset-bottom))' }}
                        >
                            <button
                                type="button"
                                aria-label="Complete checklist run"
                                onClick={completeRun}
                                disabled={completing}
                                aria-busy={completing || undefined}
                                className={`w-full min-h-[44px] py-4 rounded-2xl text-sm font-black text-white transition-all active:scale-[0.97] shadow-xl disabled:opacity-60 ${
                                    runFailCount > 0
                                        ? 'bg-linear-to-r from-red-600 to-red-700 shadow-red-500/20'
                                        : runCheckedCount === runTotal
                                          ? 'bg-linear-to-r from-emerald-600 to-emerald-700 shadow-emerald-500/20'
                                          : 'bg-linear-to-r from-sky-600 to-sky-700 shadow-sky-500/20'
                                }`}
                            >
                                {runCheckedCount === runTotal
                                    ? runFailCount > 0
                                        ? `Complete — ${runFailCount} failed`
                                        : 'Complete — all passed'
                                    : `Complete (${runCheckedCount}/${runTotal})`}
                            </button>
                        </div>
                    </OverlayPortal>
                )}
            </div>

            {/* Leaving a run with anything checked: one question, as nothing
                from it is kept (132-B16, CHK-04). It mounts over the run. */}
            {abandonAsk && (
                <ConfirmDialog
                    isOpen={true}
                    title="Discard this run?"
                    message={`${runCheckedCount} of ${runTotal} checked so far. Nothing from this run is kept.`}
                    confirmLabel="Discard run"
                    cancelLabel="Keep going"
                    destructive
                    onConfirm={() => {
                        const scope = getAuthIdentityScope();
                        if (currentOperation(scope)) closeRun(scope);
                        else setAbandonAsk(false);
                    }}
                    onCancel={() => setAbandonAsk(false)}
                />
            )}

            {pastRunsOpen && (
                <Suspense fallback={null}>
                    <PastRunsSheet runs={runs} entries={entries} onClose={() => setPastRunsOpen(false)} />
                </Suspense>
            )}

            {/* Delete a checklist that still has items? One question, which
                says what goes with it; Undo still follows (126-B10b). */}
            {deleteAsk && (
                <ConfirmDialog
                    isOpen={true}
                    title={`Delete “${deleteAsk.entry.text}”?`}
                    message={`Its ${deleteAsk.items} item${deleteAsk.items === 1 ? ' goes' : 's go'} with it.`}
                    confirmLabel={`Delete checklist and item${deleteAsk.items === 1 ? '' : 's'}`}
                    cancelLabel="Keep"
                    destructive
                    onConfirm={() => {
                        setDeleteAsk(null);
                        if (currentOperation(deleteAsk.scope)) removeEntry(deleteAsk.entry);
                    }}
                    onCancel={() => setDeleteAsk(null)}
                />
            )}

            <UndoToast key={undoToastKey} {...undoToastProps} />
        </div>
    );
};
