/**
 * MaintenanceHub — Vessel Maintenance & Routine Tracker
 *
 * Sub-components extracted to ./maintenance/:
 *   - SwipeableTaskCard: swipeable task card with traffic-light status
 *   - ServiceLogSheet: bottom sheet for logging maintenance
 *   - TaskFormModal: add/edit task form
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('MaintenanceHub');
import {
    LocalMaintenanceService as MaintenanceService,
    type LoggedService,
} from '../../services/vessel/LocalMaintenanceService';
import {
    calculateStatus,
    isFixedRepair,
    statusWithReading,
    type TaskWithStatus,
    type TrafficLight as _TrafficLight,
} from '../../services/MaintenanceService';
import type {
    MaintenanceTask,
    MaintenanceCategory,
    MaintenanceTriggerType as _MaintenanceTriggerType,
    MaintenanceHistory,
} from '../../types';
import { triggerHaptic } from '../../utils/system';
import { exportChecklist, exportServiceHistory } from '../../services/MaintenancePdfService';
import { TapToAction } from '../ui/TapToAction';
import { EmptyState } from '../ui/EmptyState';
import { LoadErrorState } from '../ui/LoadErrorState';
import { ShimmerBlock } from '../ui/ShimmerBlock';
import { PageHeader } from '../ui/PageHeader';
import { OfflineBadge } from '../ui/OfflineBadge';
import { toast } from '../Toast';
import { UndoToast } from '../ui/UndoToast';
import { ModalSheet } from '../ui/ModalSheet';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ChevronRightIcon } from '../icons/GlassGlyphs';
import { usePanePortalTarget } from '../../context/PanePortalContext';
import { useMaintenanceForm } from '../../hooks/useMaintenanceForm';
import { useRealtimeSyncMulti } from '../../hooks/useRealtimeSync';
import { useUndoDelete } from '../../hooks/useUndoDelete';
import { useSuccessFlash } from '../../hooks/useSuccessFlash';
import { CATEGORIES } from './maintenance/constants';
import { ServiceLogSheet, clockTime } from './maintenance/ServiceLogSheet';
import { TaskFormModal } from './maintenance/TaskFormModal';
import { SwipeableTaskCard } from './maintenance/SwipeableTaskCard';
import { scheduleFromForm } from './maintenance/taskSchedule';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { getSyncMeta, initLocalDatabase } from '../../services/vessel/LocalDatabase';
import { onSyncComplete } from '../../services/vessel/SyncService';
import { canSeedOwnBinder, getBinderSource, SharedBinderReadOnlyError } from '../../services/vessel/sharedBinders';
import {
    LocalEngineHoursService,
    MAX_ENGINE_HOURS,
    type EngineHoursReading,
} from '../../services/vessel/LocalEngineHoursService';
import { useBinderSource } from '../../hooks/useBinderSource';
import { supabase } from '../../services/supabase';
import {
    maintenanceHistoryKeepsRecords,
    maintenanceHistoryKeptKnown,
} from '../../services/vessel/maintenanceHistoryColumn';
import { SharedBinderLine, bringingInCopy } from './SharedBinderLine';
import { localDayString } from '../../utils/localDate';
// 'Sun 28 Sep 2026', shared with the task cards (UX scorecard run 9).
import { formatDisplayDate } from '../../utils/displayDate';

interface MaintenanceHubProps {
    onBack: () => void;
}

interface ScopedMaintenanceTasks {
    identity: AuthIdentityScope;
    tasks: MaintenanceTask[];
}

interface ScopedMaintenanceHistory {
    identity: AuthIdentityScope;
    items: MaintenanceHistory[];
}

// ── Category config + SwipeableTaskCard — now in ./maintenance/ ──

/**
 * This account's first full pull has completed on this device, so an empty
 * R&M means the account has no tasks, not that they have yet to arrive (a new
 * device, or a reinstall). Signed out (browse mode) nothing will arrive.
 * Call after initLocalDatabase for `identity`.
 */
function ownTasksHaveArrived(identity: AuthIdentityScope): boolean {
    if (!identity.userId) return true;
    try {
        return !!getSyncMeta().lastFullPullTimestamp;
    } catch {
        return false;
    }
}

/** This device has listed the account's own tasks: it never auto-seeds again. */
function rememberHadOwnTasks(key: string): void {
    try {
        if (!localStorage.getItem(key)) localStorage.setItem(key, '1');
    } catch {
        // Storage unavailable: the seed decision below still holds for this page.
    }
}

// Category display order: Repair first, then rest. Module scope so the memos
// below can list it honestly in their dependency arrays.
const CATEGORY_ORDER: MaintenanceCategory[] = ['Repair', 'Engine', 'Safety', 'Hull', 'Rigging', 'Routine'];
// A group's heading and count: each category, and Paused.
const GROUP_LABEL = 'text-label font-black text-gray-400 uppercase tracking-widest';
const GROUP_COUNT = 'text-micro text-gray-400 font-bold';

export const MaintenanceHub: React.FC<MaintenanceHubProps> = ({ onBack }) => {
    // ── State ──
    const [taskData, setTaskData] = useState<ScopedMaintenanceTasks>(() => ({
        identity: getAuthIdentityScope(),
        tasks: [],
    }));
    const taskDataIsCurrent = isAuthIdentityScopeCurrent(taskData.identity);
    const tasks = useMemo(() => (taskDataIsCurrent ? taskData.tasks : []), [taskData.tasks, taskDataIsCurrent]);
    // Soft delete with undo (126-B10a): a deleted task stays in state, hidden,
    // until its delete is committed (on Back too: this view has no keep-alive),
    // so no reload brings it back and Undo returns it once, in its place. The
    // seed guard below reads the service's rows, never this filtered list.
    const undoDelete = useUndoDelete<MaintenanceTask>({
        rows: taskData.tasks,
        commit: (task) => MaintenanceService.deleteTask(task.id),
        // Declared below; called only once a delete has landed.
        onCommitted: () => void loadTasks(getAuthIdentityScope(), true),
        onCommitFailed: () => toast.error('Failed to delete task'),
        onRestored: () => toast.success('Task restored'),
        describe: (task) => `"${task.title}" deleted`,
    });
    const { hiddenIds } = undoDelete;
    const { key: undoToastKey, ...undoToastProps } = undoDelete.toastProps;
    const visibleTasks = useMemo(
        () => (hiddenIds.size > 0 ? tasks.filter((task) => !hiddenIds.has(task.id)) : tasks),
        [tasks, hiddenIds],
    );
    // Every task is loaded, paused ones too (126-B7a): the seed guard and the
    // binder's row count read them all. Only active tasks are listed by
    // category and counted as due; paused ones wait in their own group.
    const activeTasks = useMemo(() => visibleTasks.filter((task) => task.is_active), [visibleTasks]);
    // null until the skipper has entered a figure — a bold "0" read as a
    // real reading and hour-based tasks counted from it. The R&M binder's
    // shared reading (LocalEngineHoursService): the skipper's while crewing
    // his shared R&M, so a service logged here records his hours. Read
    // synchronously, so an account switch shows the new account's figure at
    // once; read again once the local database is open for the account, on
    // every reload (a change from another device), and after each sync.
    const [engineHoursReading, setEngineHoursReading] = useState<EngineHoursReading>(() =>
        LocalEngineHoursService.getReading(),
    );
    const engineHours = engineHoursReading.hours;
    /** False on a view-only share: the figure shows, the field does not open. */
    const engineHoursCanEdit = engineHoursReading.canEdit;
    /** The engine-hours table is live on this device: listen for changes to it. */
    const engineHoursShared = engineHoursReading.source === 'shared';
    const [engineHoursInput, setEngineHoursInput] = useState<string>('');
    const [isEditingHours, setIsEditingHours] = useState(false);
    const [engineHoursEditIdentity, setEngineHoursEditIdentity] = useState<AuthIdentityScope | null>(null);
    /** One save per edit: Enter and the blur that follows it both call save. */
    const hoursEditOpenRef = useRef(false);
    const [loading, setLoading] = useState(true);
    // A failed fetch used to fall through to the empty state, so a network
    // error read as "nothing logged" — see components/ui/LoadErrorState.
    const [loadError, setLoadError] = useState(false);

    // Log Service sheet
    const [sheetTask, setSheetTask] = useState<{ identity: AuthIdentityScope; task: TaskWithStatus } | null>(null);
    // A delete that would take service records with it waits for an answer.
    const [deleteAsk, setDeleteAsk] = useState<{
        identity: AuthIdentityScope;
        task: MaintenanceTask;
        records: number;
    } | null>(null);
    const [showPaused, setShowPaused] = useState(false);
    const [showFixed, setShowFixed] = useState(false);
    // Whether a deleted task's records stay (131-B7): only once the held
    // migration's column has been seen; until then they go with it, and the
    // question says so (126-B7a).
    const [historyKept, setHistoryKept] = useState(maintenanceHistoryKeptKnown);
    const [sheetNotes, setSheetNotes] = useState('');
    const [sheetSaving, setSheetSaving] = useState(false);

    // Add/Edit task form (consolidated)
    const {
        form,
        setField,
        setCategory: setFormCategory,
        setTaskType,
        setTrigger,
        reset: resetForm,
        populate: populateForm,
        openForAdd,
    } = useMaintenanceForm();
    const [showAddForm, setShowAddForm] = useState(false);
    const [addFormIdentity, setAddFormIdentity] = useState<AuthIdentityScope | null>(null);

    // History
    const [historyData, setHistoryData] = useState<ScopedMaintenanceHistory>(() => ({
        identity: getAuthIdentityScope(),
        items: [],
    }));
    const historyIsCurrent = isAuthIdentityScopeCurrent(historyData.identity);
    const [showHistory, setShowHistory] = useState(false);
    // A mistaken record removed from Service history (126-B7a), with its own
    // undo slot: hidden at once, deleted when the window ends or on leaving.
    const recordUndo = useUndoDelete<MaintenanceHistory>({
        rows: historyData.items,
        commit: (record) => MaintenanceService.deleteHistory(record.id),
        // Declared below; called only once a removal has landed.
        onCommitted: () => reloadInBackground(),
        onCommitFailed: () => toast.error('Could not remove the record'),
        onRestored: () => toast.success('Record restored'),
        describe: (record) => `Record of ${formatDisplayDate(record.completed_at)} removed`,
    });
    const { key: recordToastKey, ...recordToastProps } = recordUndo.toastProps;
    const visibleHistory = useMemo(
        () => (historyIsCurrent ? historyData.items.filter((record) => !recordUndo.hiddenIds.has(record.id)) : []),
        [historyIsCurrent, historyData.items, recordUndo.hiddenIds],
    );
    const portalTarget = usePanePortalTarget();

    // Edit task
    const [showEditForm, setShowEditForm] = useState(false);
    const [editTask, setEditTask] = useState<{ identity: AuthIdentityScope; task: TaskWithStatus } | null>(null);

    // Share or save a PDF (130-B8). The ref is the double-tap guard: state
    // lands a render late, so a second tap would start a second PDF.
    const [menuOpen, setMenuOpen] = useState(false);
    const [exporting, setExporting] = useState(false);
    const exportingRef = useRef(false);
    // No name set: the PDF prints none, rather than 'Vessel'.
    const ownVesselName = useSettingsStore((state) => state.settings.vessel?.name?.trim() || '');

    const hoursInputRef = useRef<HTMLInputElement>(null);
    const loadRequestRef = useRef(0);
    /** The account this page has made its one seed decision for. */
    const seedDecisionRef = useRef<string | null>(null);
    /** The seed decision is waiting for this account's first full pull. */
    const seedAwaitsFirstPullRef = useRef(false);
    const { ref: listRef, flash } = useSuccessFlash();

    // ── Load ──
    const loadTasks = useCallback(async (identity: AuthIdentityScope = getAuthIdentityScope(), background = false) => {
        setLoadError(false);
        if (!isAuthIdentityScopeCurrent(identity)) return;
        const requestId = ++loadRequestRef.current;
        const isCurrentRequest = () => requestId === loadRequestRef.current && isAuthIdentityScopeCurrent(identity);
        try {
            // A background reload (a change from another device, a sync)
            // keeps the list on screen and the reader's scroll position.
            if (!background) setLoading(true);
            // Join the exact account file switch before LocalMaintenanceService
            // performs its synchronous cache read.
            await initLocalDatabase(identity.userId);
            if (!isCurrentRequest()) return;
            setEngineHoursReading(LocalEngineHoursService.getReading(identity));
            // Paused tasks included: an account with every task paused has
            // tasks, and must never be seeded on top of them (126-B7a).
            const data = await MaintenanceService.getAllTasks();
            if (!isCurrentRequest()) return;

            // Auto-seed defaults for first-time users — into their OWN binder
            // only, and only once the server has confirmed their crew shares:
            // a crew device that seeded before the skipper's tasks arrived put
            // 40 duplicate defaults in the skipper's R&M (2026-10-01). Until it
            // may, nothing is seeded and the marker stays unset.
            //
            // And never because tasks went away (2026-10-02): binders are live
            // now, so an empty list can mean "the last task was deleted on the
            // phone", and seeding then pushed 40 suggestions to every device
            // within seconds, once per device. So: an account that has had its
            // own tasks on this device never auto-seeds, and this page makes the
            // seed decision once per account, on the first load that may seed
            // (its mount load, or the reload when the shares are first
            // confirmed); a live change from elsewhere never seeds.
            //
            // Nor before this account's first full pull here (review,
            // 2026-10-02): on a new device or after a reinstall the list is
            // empty only because the account's tasks have not arrived, and a
            // seed then put 40 suggestions on top of them, on every device.
            const seedKey = authScopedStorageKey('thalassa_maintenance_seeded', identity);
            const hadTasksKey = authScopedStorageKey('thalassa_maintenance_had_tasks', identity);
            if (data.length > 0 && getBinderSource('maintenance').mode === 'own') {
                rememberHadOwnTasks(hadTasksKey);
            }
            const decisionKey = `${identity.key}#${identity.generation}`;
            const undecided = seedDecisionRef.current !== decisionKey && canSeedOwnBinder('maintenance');
            const mayDecide = undecided && ownTasksHaveArrived(identity);
            seedAwaitsFirstPullRef.current = undecided && !mayDecide;
            if (mayDecide) seedDecisionRef.current = decisionKey;
            if (
                mayDecide &&
                data.length === 0 &&
                !localStorage.getItem(seedKey) &&
                !localStorage.getItem(hadTasksKey)
            ) {
                try {
                    const seededCount = await MaintenanceService.seedDefaults();
                    if (!isCurrentRequest()) return;
                    if (seededCount === 0) {
                        setTaskData({ identity, tasks: data });
                        return;
                    }
                    localStorage.setItem(seedKey, '1');
                    const seeded = await MaintenanceService.getAllTasks();
                    if (!isCurrentRequest()) return;
                    setTaskData({ identity, tasks: seeded });
                    // One line: the two-line toast covered a task row at 393 and a
                    // whole card at 375 (UX scorecard run 8). The note above the
                    // list already says the schedule is a suggestion to adjust.
                    toast.success(`${seeded.length} suggested task${seeded.length === 1 ? '' : 's'} added`);
                    return;
                } catch (seedErr) {
                    log.warn(' seed failed:', seedErr);
                    // Proceed with empty list — user can add manually
                }
            }

            if (isCurrentRequest()) setTaskData({ identity, tasks: data });
        } catch (e) {
            log.error('Failed to load tasks:', e);
            if (isCurrentRequest()) {
                setLoadError(true);
                toast.error('Failed to load maintenance tasks');
            }
        } finally {
            if (isCurrentRequest()) setLoading(false);
        }
    }, []);

    useEffect(() => {
        const identity = getAuthIdentityScope();
        void loadTasks(identity);
    }, [loadTasks]);

    // Ask the server once per visit whether it keeps a deleted task's records
    // (131-B7). It never throws; offline or signed out it says no.
    useEffect(() => {
        let live = true;
        void maintenanceHistoryKeepsRecords(supabase).then((kept) => {
            if (live) setHistoryKept(kept);
        });
        return () => {
            live = false;
        };
    }, []);

    // The Service history sheet on show, so a background reload refreshes it
    // too: a service logged on another device belongs in it straight away.
    const openHistoryRef = useRef<{ identity: AuthIdentityScope; taskId: string } | null>(null);
    openHistoryRef.current =
        showHistory && sheetTask ? { identity: sheetTask.identity, taskId: sheetTask.task.id } : null;
    const reloadInBackground = useCallback(() => {
        void loadTasks(getAuthIdentityScope(), true);
        const open = openHistoryRef.current;
        if (!open || !isAuthIdentityScopeCurrent(open.identity)) return;
        void Promise.resolve()
            .then(() => MaintenanceService.getHistory(open.taskId))
            .then((items) => {
                // Only into the same sheet, still open, for the same account.
                const still = openHistoryRef.current;
                if (still?.taskId !== open.taskId || !isAuthIdentityScopeCurrent(open.identity)) return;
                setHistoryData({ identity: open.identity, items });
            })
            .catch((e) => log.warn('Failed to refresh service history:', e));
    }, [loadTasks]);

    // A first-time account that opened R&M before its first full pull: decide
    // when that pull completes. It may pull nothing (a new account), and then
    // no ordinary reload would come. Engine hours are read again after every
    // cycle: the one that first finds the shared table on the server pulls
    // nothing when nobody has entered a reading yet.
    useEffect(
        () =>
            onSyncComplete(() => {
                setEngineHoursReading(LocalEngineHoursService.getReading());
                if (seedAwaitsFirstPullRef.current) reloadInBackground();
            }),
        [reloadInBackground],
    );

    // Live across devices: tasks AND service history, on one channel. A change
    // saved on another device (or by crew on a shared R&M) lands within
    // seconds; the binder read decides which rows this page shows.
    useRealtimeSyncMulti(['maintenance_tasks', 'maintenance_history'], reloadInBackground);
    // The engine-hours reading on a channel of its own, opened only once the
    // table is live on this device: a binding for a table the server does not
    // have yet would fail the channel join, and with it the tasks' channel.
    useRealtimeSyncMulti(['vessel_engine_hours'], reloadInBackground, engineHoursShared);

    // Whose R&M this is (shared binders, 2026-10-02): the skipper's while this
    // sailor is crew on a boat that shares it. Crew with write can edit, pause,
    // resume and log a service; every delete is the skipper's (RLS), so crew
    // get no task delete, no record Remove and no Undo of a log (126-B7a).
    // The row count includes paused tasks: an all-paused shared R&M has rows.
    const { source: binder, fetchingSkipperBinder } = useBinderSource('maintenance', {
        reload: reloadInBackground,
        rowCount: tasks.length,
    });
    const sharedBinder = binder.mode === 'shared';
    // The boat's name on the PDFs (130-B8): the skipper's on his shared R&M,
    // not the crew member's own boat from settings. None known: none printed.
    const vesselName = binder.mode === 'shared' ? binder.vesselName?.trim() || '' : ownVesselName;

    // ── Engine Hours ──
    // Saved as the R&M binder's shared reading: every device of the skipper
    // and any crew on his shared R&M see it within seconds. Before the shared
    // table is live on this device it stays on the device, as it always did.
    const saveEngineHours = useCallback(() => {
        if (!hoursEditOpenRef.current) return;
        hoursEditOpenRef.current = false;
        const identity = engineHoursEditIdentity;
        setIsEditingHours(false);
        setEngineHoursEditIdentity(null);
        if (!identity || !isAuthIdentityScopeCurrent(identity)) return;
        const parsed = parseInt(engineHoursInput.replace(/[,\s]/g, ''), 10);
        // Anything else keeps the figure on show, as before.
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_ENGINE_HOURS || parsed === engineHours) return;
        // The first reading schedules the hour tasks waiting for one (126-B1):
        // never a later one, which would move due points already set.
        const firstReading = engineHours === null;
        setEngineHoursReading((reading) => ({ ...reading, hours: parsed }));
        void LocalEngineHoursService.setReading(parsed, identity)
            .then(async () => {
                if (!firstReading || !isAuthIdentityScopeCurrent(identity)) return;
                try {
                    const scheduled = await MaintenanceService.scheduleHourTasksFromFirstReading(parsed);
                    if (scheduled > 0 && isAuthIdentityScopeCurrent(identity)) void loadTasks(identity, true);
                } catch (e) {
                    log.warn('maintenance: first-reading-schedule-failed', e);
                }
            })
            .catch((e) => {
                log.warn('Failed to save engine hours:', e);
                if (isAuthIdentityScopeCurrent(identity)) {
                    toast.error(e instanceof SharedBinderReadOnlyError ? e.message : 'Could not save engine hours');
                }
            })
            .finally(() => {
                if (isAuthIdentityScopeCurrent(identity)) {
                    setEngineHoursReading(LocalEngineHoursService.getReading(identity));
                }
            });
    }, [engineHoursInput, engineHours, engineHoursEditIdentity, loadTasks]);

    const startEditingHours = useCallback(() => {
        const identity = getAuthIdentityScope();
        if (!isAuthIdentityScopeCurrent(identity) || !engineHoursCanEdit) return;
        hoursEditOpenRef.current = true;
        setEngineHoursInput(engineHours === null ? '' : engineHours.toLocaleString());
        setEngineHoursEditIdentity(identity);
        setIsEditingHours(true);
        setTimeout(() => {
            if (isAuthIdentityScopeCurrent(identity)) hoursInputRef.current?.focus();
        }, 100);
    }, [engineHours, engineHoursCanEdit]);

    const tasksWithStatus = useMemo(() => {
        // Engine hours not entered yet: judged on the date alone, never on
        // hours counted from an invented zero (statusWithReading, the rule the
        // Vessel page's overdue badge counts with too).
        const withStatus = activeTasks.map((t) => statusWithReading(t, engineHours));
        // Sort: category order first, then alphabetical within each category
        return withStatus.sort((a, b) => {
            const catA = CATEGORY_ORDER.indexOf(a.category);
            const catB = CATEGORY_ORDER.indexOf(b.category);
            if (catA !== catB) return catA - catB;
            return a.title.localeCompare(b.title);
        });
    }, [activeTasks, engineHours]);
    // Off the list, by title: a repair marked fixed waits under Fixed
    // (132-B15), any other task under Paused (126-B7a). Never due.
    const inactiveTasks = useMemo(
        () =>
            visibleTasks
                .filter((task) => !task.is_active)
                .map((task) => calculateStatus(task, engineHours ?? 0))
                .sort((a, b) => a.title.localeCompare(b.title)),
        [visibleTasks, engineHours],
    );
    const pausedTasks = useMemo(() => inactiveTasks.filter((task) => !isFixedRepair(task)), [inactiveTasks]);
    const fixedRepairs = useMemo(() => inactiveTasks.filter(isFixedRepair), [inactiveTasks]);

    // Group tasks by category for rendering
    const groupedTasks = useMemo(() => {
        const groups: { category: MaintenanceCategory; tasks: TaskWithStatus[] }[] = [];
        for (const cat of CATEGORY_ORDER) {
            const catTasks = tasksWithStatus.filter((t) => t.category === cat);
            if (catTasks.length > 0) groups.push({ category: cat, tasks: catTasks });
        }
        return groups;
    }, [tasksWithStatus]);

    // The 40 suggested tasks are seeded with due dates counted from the day
    // they were added. Until the skipper logs a service, say so, rather than
    // letting "Due in 1 day" read like confirmed work.
    const showSuggestedNote = useMemo(() => {
        if (!taskDataIsCurrent || activeTasks.length === 0 || visibleTasks.some((t) => t.last_completed)) return false;
        try {
            return !!localStorage.getItem(authScopedStorageKey('thalassa_maintenance_seeded', taskData.identity));
        } catch {
            return false;
        }
    }, [activeTasks.length, visibleTasks, taskData.identity, taskDataIsCurrent]);

    // Status counts for the header. Grey tasks are counted too, by reason, so
    // the chips add up to the task list (UX scorecard run 6: '3 due · 36 ok'
    // under 40 tasks left the hours-only task uncounted).
    const counts = useMemo(
        () =>
            tasksWithStatus.reduce(
                (acc, t) => {
                    // An open repair is counted as one to fix, not as due
                    // (132-B15). A due still counted from zero is amber
                    // (calculateStatus), so it counts with the tasks that need
                    // attention.
                    if (t.toFix) acc.toFix++;
                    else if (t.status !== 'grey') acc[t.status]++;
                    else if (
                        engineHours === null &&
                        ((t.next_due_hours !== null && t.next_due_hours !== undefined) ||
                            t.trigger_type === 'engine_hours')
                    )
                        acc.needsHours++;
                    else acc.unscheduled++;
                    return acc;
                },
                { red: 0, toFix: 0, yellow: 0, green: 0, needsHours: 0, paused: pausedTasks.length, unscheduled: 0 },
            ),
        [tasksWithStatus, engineHours, pausedTasks.length],
    );

    // The chips read to VoiceOver as one run ('3 due 36 ok 1 needs hours'), so
    // assistive tech gets this sentence instead and the chips are hidden from
    // it (UX scorecard run 7).
    // "Up to date" is earned by a logged service (UX scorecard run 10,
    // maint-36-ok): while no task has ever been done — the suggested schedule
    // straight after seeding — the green count says "not due", not "ok".
    const anyServiceLogged = useMemo(() => tasksWithStatus.some((t) => !!t.last_completed), [tasksWithStatus]);
    const countsSummary = useMemo(() => {
        const parts: string[] = [];
        if (counts.red > 0) parts.push(`${counts.red} overdue`);
        if (counts.toFix > 0) parts.push(`${counts.toFix} to fix`);
        if (counts.yellow > 0) parts.push(`${counts.yellow} due soon`);
        if (tasksWithStatus.length > counts.toFix)
            parts.push(`${counts.green} ${anyServiceLogged ? 'up to date' : 'not yet due'}`);
        if (counts.needsHours > 0)
            parts.push(`${counts.needsHours} ${counts.needsHours === 1 ? 'needs' : 'need'} engine hours`);
        if (counts.unscheduled > 0) parts.push(`${counts.unscheduled} unscheduled`);
        if (counts.paused > 0) parts.push(`${counts.paused} paused`);
        return parts.length > 0 ? `Tasks: ${parts.join(', ')}.` : '';
    }, [counts, tasksWithStatus.length, anyServiceLogged]);

    // ── Undo a logged service (126-B7a), or a repair marked fixed (132-B15):
    // the skipper's binder only ──
    const undoLog = useCallback(
        async (logged: LoggedService, identity: AuthIdentityScope, fix = false) => {
            if (!isAuthIdentityScopeCurrent(identity)) return;
            try {
                const { restored } = await MaintenanceService.undoLogService(logged);
                if (!isAuthIdentityScopeCurrent(identity)) return;
                reloadInBackground();
                if (fix) toast.success(restored ? 'Undone. It needs fixing again.' : 'Undone. It was changed since.');
                else toast.success(restored ? 'Log undone' : 'Log undone. The later service still counts.');
            } catch (e) {
                log.warn('Failed to undo the service log:', e);
                if (isAuthIdentityScopeCurrent(identity)) {
                    toast.error(e instanceof SharedBinderReadOnlyError ? e.message : 'Could not undo the log');
                }
            }
        },
        [reloadInBackground],
    );

    // ── Log Service ──
    const handleLogService = useCallback(async () => {
        if (!sheetTask) return;
        const { identity, task } = sheetTask;
        const taskId = task.id;
        // Same figure the sheet shows: a real 0 is kept, "not entered" is null.
        const hoursSnapshot = engineHours;
        const notesSnapshot = sheetNotes.trim() || null;
        if (!isAuthIdentityScopeCurrent(identity)) return;
        setSheetSaving(true);
        try {
            triggerHaptic('medium');
            const logged = await MaintenanceService.logService(taskId, hoursSnapshot, notesSnapshot, null);
            if (!isAuthIdentityScopeCurrent(identity)) return;
            setSheetTask(null);
            setSheetNotes('');
            await loadTasks(identity); // Refresh list
            if (!isAuthIdentityScopeCurrent(identity)) return;
            // Hours due are counted from a real reading only (126-B1): with none
            // entered, say how the next service gets scheduled.
            const message =
                task.trigger_type === 'engine_hours' && hoursSnapshot === null
                    ? 'Service logged. Enter engine hours to schedule the next one.'
                    : 'Service logged';
            // Undo deletes the record, and deletes are the skipper's (RLS): a
            // crew DELETE would fail forever in the outbox, so crew get none.
            if (sharedBinder) toast.success(message);
            else toast.success(message, { label: 'Undo', onClick: () => void undoLog(logged, identity) });
            flash();
        } catch (e) {
            log.error('Failed to log service:', e);
            if (isAuthIdentityScopeCurrent(identity)) toast.error('Failed to log service');
        } finally {
            if (isAuthIdentityScopeCurrent(identity)) setSheetSaving(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sheetTask, engineHours, sheetNotes, loadTasks, sharedBinder, undoLog]);

    // ── Mark a repair fixed (132-B15): it leaves the list for Fixed ──
    // From its sheet, with what was done in the notes; or offered instead of
    // deleting an open repair that has service records, which keeps them.
    const markRepairFixed = useCallback(
        async (task: MaintenanceTask, identity: AuthIdentityScope, notes: string | null) => {
            if (!isAuthIdentityScopeCurrent(identity)) return;
            setSheetSaving(true);
            try {
                triggerHaptic('medium');
                const logged = await MaintenanceService.markFixed(task.id, notes);
                if (!isAuthIdentityScopeCurrent(identity)) return;
                setSheetTask(null);
                setSheetNotes('');
                await loadTasks(identity, true);
                if (!isAuthIdentityScopeCurrent(identity)) return;
                const message = `“${task.title}” fixed. It's under Fixed.`;
                // As a logged service: Undo deletes the record, so crew get none.
                if (sharedBinder) toast.success(message);
                else toast.success(message, { label: 'Undo', onClick: () => void undoLog(logged, identity, true) });
            } catch (e) {
                log.error('Failed to mark the repair fixed:', e);
                if (isAuthIdentityScopeCurrent(identity)) {
                    toast.error(e instanceof SharedBinderReadOnlyError ? e.message : 'Could not mark it fixed');
                }
            } finally {
                if (isAuthIdentityScopeCurrent(identity)) setSheetSaving(false);
            }
        },
        [loadTasks, sharedBinder, undoLog],
    );
    const handleMarkFixed = useCallback(async () => {
        if (!sheetTask) return;
        await markRepairFixed(sheetTask.task, sheetTask.identity, sheetNotes.trim() || null);
    }, [sheetTask, sheetNotes, markRepairFixed]);

    // ── Pause / Resume (126-B7a) ──
    const setTaskPaused = useCallback(
        async (task: MaintenanceTask, identity: AuthIdentityScope, pause: boolean) => {
            if (!isAuthIdentityScopeCurrent(identity)) return;
            try {
                triggerHaptic('medium');
                await (pause ? MaintenanceService.deactivateTask(task.id) : MaintenanceService.resumeTask(task.id));
                if (!isAuthIdentityScopeCurrent(identity)) return;
                setSheetTask(null);
                await loadTasks(identity, true);
                if (!isAuthIdentityScopeCurrent(identity)) return;
                toast.success(
                    pause
                        ? `“${task.title}” paused. It's under Paused.`
                        : isFixedRepair(task)
                          ? `“${task.title}” reopened: it needs fixing again`
                          : `“${task.title}” resumed`,
                );
            } catch (e) {
                log.warn('Failed to pause or resume a task:', e);
                if (isAuthIdentityScopeCurrent(identity)) {
                    toast.error(
                        e instanceof SharedBinderReadOnlyError
                            ? e.message
                            : `Could not ${pause ? 'pause' : 'resume'} the task`,
                    );
                }
            }
        },
        [loadTasks],
    );

    // ── Add Task ──
    const handleAddTask = useCallback(async () => {
        if (!form.title.trim()) return;
        const identity = addFormIdentity;
        if (!identity || !isAuthIdentityScopeCurrent(identity)) return;
        try {
            triggerHaptic('medium');

            // A repair is the one shape the log and Checklists raise too: it
            // needs fixing, with no schedule to roll on (132-B15). It was a
            // daily task due today, rolled on to tomorrow by every log.
            const isRepair = form.category === 'Repair';
            if (isRepair) {
                await MaintenanceService.createRepair(form.title, form.description);
            } else {
                await MaintenanceService.createTask({
                    title: form.title.trim(),
                    description: form.description.trim() || null,
                    category: form.category,
                    // Blank fields save sensibly: a blank 'Next due' hours is
                    // the reading plus the interval (132-B15, MAINT-17).
                    ...scheduleFromForm(form, engineHours),
                    last_completed: null,
                    is_active: true,
                });
            }
            if (!isAuthIdentityScopeCurrent(identity)) return;
            setShowAddForm(false);
            setAddFormIdentity(null);
            resetForm();
            await loadTasks(identity);
            if (!isAuthIdentityScopeCurrent(identity)) return;
            toast.success(isRepair ? 'Repair added' : 'Task created');
            flash();
        } catch (e) {
            log.error('Failed to create task:', e);
            if (isAuthIdentityScopeCurrent(identity)) toast.error('Failed to create task');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [form, resetForm, loadTasks, addFormIdentity, engineHours]);

    // ── Load History ──
    const loadHistory = useCallback(async (taskId: string, identity: AuthIdentityScope = getAuthIdentityScope()) => {
        if (!isAuthIdentityScopeCurrent(identity)) return;
        try {
            const h = await MaintenanceService.getHistory(taskId);
            if (!isAuthIdentityScopeCurrent(identity)) return;
            setHistoryData({ identity, items: h });
            setShowHistory(true);
        } catch (e) {
            log.error('Failed to load history:', e);
            // The History sheet just wouldn't open with no explanation.
            if (isAuthIdentityScopeCurrent(identity)) {
                toast.error('Could not load service history — try again.');
            }
        }
    }, []);

    // The service history the PDF prints. A record waiting out its Undo is
    // left out, as it is on screen. So are the records of a task waiting out
    // its delete Undo while they would go with it; once the server keeps them
    // (131-B7) they print as they will be, under its name, '(task removed)'.
    const historyForPdf = useCallback((): MaintenanceHistory[] => {
        const removed = new Map(taskData.tasks.filter((task) => hiddenIds.has(task.id)).map((t) => [t.id, t.title]));
        const records = MaintenanceService.getAllHistory().filter((record) => !recordUndo.hiddenIds.has(record.id));
        if (!historyKept) return records.filter((record) => !record.task_id || !removed.has(record.task_id));
        return records.map((record) =>
            record.task_id && removed.has(record.task_id)
                ? { ...record, task_id: null, task_title: removed.get(record.task_id) }
                : record,
        );
    }, [taskData.tasks, hiddenIds, recordUndo.hiddenIds, historyKept]);

    // ── Share or save a PDF (130-B8) ──
    // From the rows on this phone, as the list shows them: the server's copy
    // left the PDFs blank offline at sea. A task or record waiting out its
    // Undo is left out, as it is on screen.
    const handleExport = useCallback(
        async (type: 'checklist' | 'history', identity: AuthIdentityScope = getAuthIdentityScope()) => {
            if (!isAuthIdentityScopeCurrent(identity) || exportingRef.current) return;
            const engineHoursSnapshot = engineHours;
            const vesselNameSnapshot = vesselName;
            exportingRef.current = true;
            setExporting(true);
            try {
                triggerHaptic('medium');
                const outcome =
                    type === 'checklist'
                        ? await exportChecklist(
                              activeTasks.map((task) => ({ ...task })),
                              engineHoursSnapshot,
                              vesselNameSnapshot,
                          )
                        : await exportServiceHistory(
                              historyForPdf(),
                              // Every task, paused ones too, for the records' titles.
                              taskData.tasks.map((task) => ({ ...task })),
                              vesselNameSnapshot,
                          );
                if (!isAuthIdentityScopeCurrent(identity)) return;
                // The share sheet speaks for itself; only the web's download needs a word.
                if (outcome === 'empty') {
                    toast.info(
                        type === 'checklist'
                            ? 'No active tasks to put on a checklist yet.'
                            : 'No services logged yet, so there is no history to share.',
                    );
                } else if (outcome === 'downloaded') {
                    toast.success('PDF downloaded');
                }
            } catch (e) {
                log.error('Failed to export PDF:', e);
                if (isAuthIdentityScopeCurrent(identity)) toast.error('Could not make the PDF. Try again.');
            } finally {
                exportingRef.current = false;
                if (isAuthIdentityScopeCurrent(identity)) setExporting(false);
            }
        },
        [engineHours, vesselName, activeTasks, taskData.tasks, historyForPdf],
    );

    useEffect(
        () =>
            subscribeAuthIdentityScope((next) => {
                setTaskData({ identity: next, tasks: [] });
                setHistoryData({ identity: next, items: [] });
                setEngineHoursReading(LocalEngineHoursService.getReading(next));
                setEngineHoursInput('');
                setIsEditingHours(false);
                setEngineHoursEditIdentity(null);
                hoursEditOpenRef.current = false;
                setLoading(true);
                setSheetTask(null);
                setDeleteAsk(null);
                setShowPaused(false);
                setShowFixed(false);
                setSheetNotes('');
                setSheetSaving(false);
                resetForm();
                setShowAddForm(false);
                setAddFormIdentity(null);
                setShowHistory(false);
                setShowEditForm(false);
                setEditTask(null);
                setMenuOpen(false);
                setExporting(false);

                void loadTasks(next);
            }),
        [loadTasks, resetForm],
    );

    // ── Soft-delete with undo (useUndoDelete above) ──
    // One undo toast at a time: a task delete commits a waiting record
    // removal first, and the other way round.
    const { remove: removeTask, commitNow: commitTaskDelete } = undoDelete;
    const { remove: removeRecord, commitNow: commitRecordRemoval, hiddenIds: recordHiddenIds } = recordUndo;
    const deleteTaskNow = useCallback(
        (task: MaintenanceTask) => {
            commitRecordRemoval();
            removeTask(task);
        },
        [commitRecordRemoval, removeTask],
    );
    const handleDeleteTask = useCallback(
        (taskId: string, identity: AuthIdentityScope = getAuthIdentityScope()) => {
            const task = visibleTasks.find((t) => t.id === taskId);
            if (!task || !isAuthIdentityScopeCurrent(identity)) return;
            triggerHaptic('medium');
            setSheetTask(null);
            // When a task has records, ask first, and offer Pause instead
            // (126-B7a), or Mark fixed for an open repair (132-B15): until
            // the server keeps them (131-B7) they go with it (MAINT-02). A
            // record waiting out its own Undo is already gone.
            const records = MaintenanceService.getHistory(task.id).filter(
                (record) => !recordHiddenIds.has(record.id),
            ).length;
            if (records > 0) setDeleteAsk({ identity, task, records });
            else deleteTaskNow(task);
        },
        [deleteTaskNow, visibleTasks, recordHiddenIds],
    );
    const handleRemoveRecord = useCallback(
        (record: MaintenanceHistory) => {
            if (!isAuthIdentityScopeCurrent(historyData.identity)) return;
            triggerHaptic('medium');
            commitTaskDelete();
            removeRecord(record);
        },
        [commitTaskDelete, removeRecord, historyData.identity],
    );

    // ── Edit Task ──
    const openEditForm = useCallback(
        (task: TaskWithStatus, identity: AuthIdentityScope = getAuthIdentityScope()) => {
            if (!isAuthIdentityScopeCurrent(identity)) return;
            setEditTask({ identity, task });
            populateForm({
                title: task.title,
                category: task.category,
                trigger: task.trigger_type,
                interval: String(task.interval_value || '200'),
                // The local day the card shows: the UTC date of a logged
                // service's due was a day early east of Greenwich (131-B11).
                dueDate: localDayString(task.next_due_date),
                // A row with no hours field at all opened on 'undefined'.
                dueHours:
                    task.next_due_hours !== null && task.next_due_hours !== undefined
                        ? String(task.next_due_hours)
                        : '',
                description: task.description || '',
            });
            setShowEditForm(true);
        },
        [populateForm],
    );

    const handleEditTask = useCallback(async () => {
        if (!editTask || !form.title.trim()) return;
        const { identity, task } = editTask;
        const taskId = task.id;
        if (!isAuthIdentityScopeCurrent(identity)) return;
        try {
            triggerHaptic('medium');
            await MaintenanceService.updateTask(taskId, {
                title: form.title.trim(),
                description: form.description.trim() || null,
                category: form.category,
                // The same schedule rule as Add (132-B15). A repair has none
                // to edit: the sheet hides it, and what the task held stays.
                ...(form.category === 'Repair' ? {} : scheduleFromForm(form, engineHours)),
            });
            if (!isAuthIdentityScopeCurrent(identity)) return;
            setShowEditForm(false);
            setEditTask(null);
            setSheetTask(null);
            await loadTasks(identity);
            if (!isAuthIdentityScopeCurrent(identity)) return;
            toast.success('Task updated');
            flash();
        } catch (e) {
            log.error('Failed to update task:', e);
            if (isAuthIdentityScopeCurrent(identity)) toast.error('Failed to update task');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editTask, form, loadTasks, engineHours]);

    // One card for the category groups and the Paused and Fixed groups alike.
    const taskCard = (task: TaskWithStatus) => (
        <SwipeableTaskCard
            key={task.id}
            task={task}
            onTap={() => {
                const identity = taskData.identity;
                if (!isAuthIdentityScopeCurrent(identity)) return;
                triggerHaptic('light');
                setSheetTask({ identity, task });
            }}
            onDelete={sharedBinder ? undefined : () => handleDeleteTask(task.id, taskData.identity)}
        />
    );

    // ── Render ──
    return (
        <div className="relative h-full bg-slate-950 overflow-hidden slide-up-enter">
            <div className="flex flex-col h-full">
                <PageHeader
                    title="Maintenance"
                    subtitle="Tasks & expiry"
                    onBack={onBack}
                    breadcrumbs={['Boat Binder', 'Maintenance']}
                    status={
                        <>
                            <OfflineBadge />
                            <SharedBinderLine register="maintenance" source={binder} />
                            {countsSummary && <span className="sr-only">{countsSummary}</span>}
                            {/* 12 px chips on 6 px sides, so '3 due soon · 36 ok · 1 needs
                                hours' is one row at 393 pt instead of two (UX scorecard
                                run 9: the chips were half of what pushed the first task
                                to mid-screen). */}
                            {/* The chip row runs the header's full width, under the ⋮
                                (UX scorecard run 10, maint-chips-375): at 375 pt the
                                title column alone wrapped the chips onto a second row
                                and pushed the first task ~24 pt down. PageHeader sets
                                the ⋮ at the top of its row (items-start), so the chips
                                always sit below it; -mr-14 is its 44 pt plus the 12 pt
                                gap. Rendered only with a chip in it, so the status row
                                still collapses (empty:hidden) when there are no tasks. */}
                            {(tasksWithStatus.length > 0 || counts.paused > 0) && (
                                <span
                                    aria-hidden="true"
                                    data-testid="maintenance-status-chips"
                                    className="-mr-14 flex flex-wrap items-center gap-1.5"
                                >
                                    {counts.red > 0 && (
                                        <span
                                            aria-hidden="true"
                                            className="px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 text-xs font-black"
                                            title="Overdue"
                                        >
                                            {counts.red} overdue
                                        </span>
                                    )}
                                    {/* Open repairs: to fix, not due (132-B15). */}
                                    {counts.toFix > 0 && (
                                        <span
                                            aria-hidden="true"
                                            className="px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-xs font-black"
                                            title="Repairs to fix"
                                        >
                                            {counts.toFix} to fix
                                        </span>
                                    )}
                                    {counts.yellow > 0 && (
                                        <span
                                            aria-hidden="true"
                                            className="px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-xs font-black"
                                            title="Due soon"
                                        >
                                            {/* 'due soon', as the rows and the spoken summary
                                        say it; a bare '3 due' read as overdue (UX
                                        scorecard run 8). */}
                                            {counts.yellow} due soon
                                        </span>
                                    )}
                                    {tasksWithStatus.length > counts.toFix && (
                                        <span
                                            aria-hidden="true"
                                            className="px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-black"
                                            title={anyServiceLogged ? 'Up to date' : 'Not yet due'}
                                        >
                                            {counts.green} {anyServiceLogged ? 'ok' : 'not due'}
                                        </span>
                                    )}
                                    {/* '1 by hours', not '1 needs hours' (UX scorecard run 10,
                                maint-chips-375): the three chips wrapped to two rows
                                at 375 pt. The title and the spoken summary keep the
                                full reason. */}
                                    {counts.needsHours > 0 && (
                                        <span
                                            aria-hidden="true"
                                            className="px-1.5 py-0.5 rounded-full bg-gray-500/20 text-gray-300 text-xs font-black"
                                            title="Due by engine hours — enter current engine hours"
                                        >
                                            {counts.needsHours} by hours
                                        </span>
                                    )}
                                    {counts.unscheduled > 0 && (
                                        <span
                                            aria-hidden="true"
                                            className="px-1.5 py-0.5 rounded-full bg-gray-500/20 text-gray-300 text-xs font-black"
                                            title="No due date or engine hours set"
                                        >
                                            {counts.unscheduled} unscheduled
                                        </span>
                                    )}
                                    {counts.paused > 0 && (
                                        <span
                                            aria-hidden="true"
                                            className="px-1.5 py-0.5 rounded-full bg-gray-500/20 text-gray-300 text-xs font-black"
                                            title="Paused"
                                        >
                                            {counts.paused} paused
                                        </span>
                                    )}
                                </span>
                            )}
                        </>
                    }
                    action={
                        <div className="relative">
                            <button
                                onClick={() => setMenuOpen(!menuOpen)}
                                className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
                                aria-label="Page actions"
                            >
                                <svg
                                    aria-hidden="true"
                                    className="w-5 h-5 text-gray-400"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z"
                                    />
                                </svg>
                            </button>
                            {menuOpen && (
                                <>
                                    <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                                    <div className="absolute right-0 top-full mt-1 z-50 w-72 bg-slate-800 border border-white/10 rounded-xl shadow-2xl overflow-hidden">
                                        {/* Named by their visible words (the glyphs are
                                            decoration), so Voice Control's "Tap Share or
                                            save blank checklist" finds them. One row per
                                            PDF (130-B8): the share sheet offers Save to
                                            Files, Mail, AirDrop and Print. */}
                                        <button
                                            type="button"
                                            disabled={exporting}
                                            onClick={() => {
                                                handleExport('checklist', taskData.identity);
                                                setMenuOpen(false);
                                            }}
                                            className="w-full text-left px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors flex items-center gap-3 disabled:opacity-40"
                                        >
                                            <svg
                                                aria-hidden="true"
                                                className="w-4 h-4 text-sky-400"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={1.5}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z"
                                                />
                                            </svg>
                                            Share or save blank checklist
                                        </button>
                                        <button
                                            type="button"
                                            disabled={exporting}
                                            onClick={() => {
                                                handleExport('history', taskData.identity);
                                                setMenuOpen(false);
                                            }}
                                            className="w-full text-left px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors flex items-center gap-3 border-t border-white/5 disabled:opacity-40"
                                        >
                                            <svg
                                                aria-hidden="true"
                                                className="w-4 h-4 text-amber-400"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={1.5}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
                                                />
                                            </svg>
                                            Share or save service history
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    }
                />

                {/* ═══ ENGINE HOURS CARD ═══
                    Unset, it is one 56 pt row: a 110 pt card holding a dash
                    pushed the first task past half the screen at 393 and two
                    thirds at 375 (UX scorecard run 9). Tapping it opens the
                    full card with the entry field; a figure keeps the full card.
                    On a view-only share it is the skipper's figure in the same
                    one row, with a quiet note and nothing to tap. */}
                <div className="shrink-0 px-4 pb-3">
                    {!engineHoursCanEdit && !isEditingHours ? (
                        <div
                            data-testid="engine-hours-view-only"
                            className="flex min-h-14 w-full items-center gap-3 rounded-2xl border border-sky-500/20 bg-sky-500/10 px-4 py-2"
                        >
                            <span aria-hidden="true" className="rounded-lg bg-sky-500/20 p-1.5">
                                <svg
                                    className="h-5 w-5 text-sky-400"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={1.5}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
                                    />
                                </svg>
                            </span>
                            <p className="min-w-0 flex-1 text-sm">
                                <span className="font-bold text-white">Engine hours</span>
                                <span className="text-gray-400">
                                    {' · '}
                                    {engineHours === null ? 'not set' : engineHours.toLocaleString()}
                                </span>
                            </p>
                            <p className="shrink-0 text-xs text-gray-400">Skipper&apos;s · view only</p>
                        </div>
                    ) : engineHours === null && !isEditingHours ? (
                        <button
                            type="button"
                            aria-label="Engine hours not set — enter engine hours"
                            onClick={startEditingHours}
                            className="flex min-h-14 w-full items-center gap-3 rounded-2xl border border-sky-500/20 bg-sky-500/10 px-4 py-2 text-left transition-all hover:bg-sky-500/15 active:scale-[0.98]"
                        >
                            <span aria-hidden="true" className="rounded-lg bg-sky-500/20 p-1.5">
                                <svg
                                    className="h-5 w-5 text-sky-400"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={1.5}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
                                    />
                                </svg>
                            </span>
                            <span className="min-w-0 flex-1 text-sm">
                                <span className="font-bold text-white">Engine hours</span>
                                <span className="text-gray-400"> · not set</span>
                            </span>
                            <span className="flex shrink-0 items-center gap-1.5 text-sm font-bold text-sky-400">
                                Enter
                                <svg
                                    aria-hidden="true"
                                    className="h-4 w-4"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={1.5}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"
                                    />
                                </svg>
                            </span>
                        </button>
                    ) : (
                        <button
                            aria-label={
                                engineHours === null
                                    ? 'Engine hours not set — enter engine hours'
                                    : `Edit engine hours, currently ${engineHours.toLocaleString()}`
                            }
                            onClick={startEditingHours}
                            className="w-full bg-linear-to-br from-sky-500/15 to-sky-500/15 border border-sky-500/20 rounded-2xl p-5 text-left group hover:from-sky-500/20 hover:to-sky-500/20 transition-all active:scale-[0.98]"
                        >
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-4">
                                    <div className="p-3 rounded-xl bg-sky-500/20">
                                        <svg
                                            className="w-6 h-6 text-sky-400"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={1.5}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
                                            />
                                        </svg>
                                    </div>
                                    <div>
                                        <p className="text-label text-sky-400/70 font-bold uppercase tracking-widest">
                                            Current engine hours
                                        </p>
                                        {isEditingHours ? (
                                            <input
                                                ref={hoursInputRef}
                                                type="text"
                                                inputMode="numeric"
                                                value={engineHoursInput}
                                                onChange={(e) => setEngineHoursInput(e.target.value)}
                                                onBlur={saveEngineHours}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') saveEngineHours();
                                                }}
                                                onClick={(e) => e.stopPropagation()}
                                                aria-label="Current engine hours"
                                                placeholder="--"
                                                className="bg-transparent border-b-2 border-sky-400 text-3xl font-black text-white tracking-wider outline-hidden w-40"
                                                autoFocus
                                            />
                                        ) : (
                                            // Unset hours never reach here: they are the one-row
                                            // button above until the field opens.
                                            <p className="text-3xl font-black text-white tracking-wider">
                                                {engineHours?.toLocaleString() ?? '--'}
                                            </p>
                                        )}
                                    </div>
                                </div>
                                {!isEditingHours && (
                                    <svg
                                        className="w-5 h-5 text-sky-400/50"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={1.5}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"
                                        />
                                    </svg>
                                )}
                            </div>
                        </button>
                    )}
                </div>

                {/* ═══ TRAFFIC LIGHT LIST (scrollable) ═══ */}
                <div ref={listRef} className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 space-y-3">
                    {loading ? (
                        <div className="space-y-3">
                            <ShimmerBlock variant="card" />
                            <ShimmerBlock variant="list" rows={5} />
                        </div>
                    ) : loadError ? (
                        <LoadErrorState what="the maintenance log" onRetry={loadTasks} />
                    ) : fetchingSkipperBinder ? (
                        <p role="status" className="py-16 text-center text-sm font-semibold text-gray-400">
                            {bringingInCopy(binder)}
                        </p>
                    ) : groupedTasks.length === 0 && pausedTasks.length === 0 && fixedRepairs.length === 0 ? (
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
                                        d="M11.42 15.17l-5.3 5.3a1.5 1.5 0 01-2.12 0l-.36-.36a1.5 1.5 0 010-2.12l5.3-5.3m2.1-2.1l4.24-4.24a3 3 0 014.24 0l.36.36a3 3 0 010 4.24l-4.24 4.24m-6.36-6.36l6.36 6.36"
                                    />
                                </svg>
                            }
                            title="No maintenance tasks"
                            subtitle="Set up service intervals for your engine, rigging and safety gear. Tap Add task below to add one."
                        />
                    ) : (
                        <>
                            {showSuggestedNote && (
                                // Two lines, not three (UX scorecard run 9); the caveat
                                // itself is unchanged.
                                <p className="text-xs text-gray-400 px-1">
                                    Suggested schedule: due dates count from the day they were added, not your last
                                    service. Tap a task to adjust it.
                                </p>
                            )}
                            {groupedTasks.map((group) => {
                                const catConfig = CATEGORIES.find((c) => c.id === group.category);
                                return (
                                    <div key={group.category}>
                                        <h2 className="flex items-center gap-2 mb-2 mt-1">
                                            {catConfig && <catConfig.Icon className="h-4 w-4 shrink-0 text-gray-400" />}
                                            <span className={GROUP_LABEL}>{catConfig?.label}</span>
                                            <span className={GROUP_COUNT}>({group.tasks.length})</span>
                                        </h2>
                                        <div className="space-y-2">{group.tasks.map(taskCard)}</div>
                                    </div>
                                );
                            })}
                            {/* Paused tasks (126-B7a): at the bottom, collapsed,
                                out of every due count. */}
                            {pausedTasks.length > 0 && (
                                <div>
                                    <button
                                        type="button"
                                        aria-expanded={showPaused}
                                        onClick={() => setShowPaused((open) => !open)}
                                        className="flex min-h-[44px] w-full items-center gap-2 text-left"
                                    >
                                        <span className={GROUP_LABEL}>Paused</span>{' '}
                                        <span className={GROUP_COUNT}>({pausedTasks.length})</span>
                                        <ChevronRightIcon
                                            className={`ml-auto h-4 w-4 text-gray-400 transition-transform ${showPaused ? '-rotate-90' : 'rotate-90'}`}
                                        />
                                    </button>
                                    {showPaused && <div className="space-y-2">{pausedTasks.map(taskCard)}</div>}
                                </div>
                            )}
                            {/* Repairs marked fixed (132-B15): last, collapsed, out of
                                every count, each with its record in the history. */}
                            {fixedRepairs.length > 0 && (
                                <div>
                                    <button
                                        type="button"
                                        aria-expanded={showFixed}
                                        onClick={() => setShowFixed((open) => !open)}
                                        className="flex min-h-[44px] w-full items-center gap-2 text-left"
                                    >
                                        <span className={GROUP_LABEL}>Fixed</span>{' '}
                                        <span className={GROUP_COUNT}>({fixedRepairs.length})</span>
                                        <ChevronRightIcon
                                            className={`ml-auto h-4 w-4 text-gray-400 transition-transform ${showFixed ? '-rotate-90' : 'rotate-90'}`}
                                        />
                                    </button>
                                    {showFixed && <div className="space-y-2">{fixedRepairs.map(taskCard)}</div>}
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* ═══ ADD TASK BUTTON (fixed at bottom) ═══ */}
                <div
                    className="shrink-0 px-4 pt-2 bg-slate-950"
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                >
                    <TapToAction
                        label="Add task"
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
                            const identity = taskData.identity;
                            if (!isAuthIdentityScopeCurrent(identity)) return;
                            triggerHaptic('medium');
                            // 'First due' is today as the sheet opens, not the day
                            // the page did, and never an edited task's (131-B11).
                            openForAdd();
                            setAddFormIdentity(identity);
                            setShowAddForm(true);
                        }}
                        theme="emerald"
                    />
                </div>

                {/* ═══ LOG SERVICE SHEET ═══ */}
                {sheetTask && (
                    <ServiceLogSheet
                        task={sheetTask.task}
                        engineHours={engineHours}
                        notes={sheetNotes}
                        onNotesChange={setSheetNotes}
                        saving={sheetSaving}
                        onLog={handleLogService}
                        onMarkFixed={handleMarkFixed}
                        onHistory={() => loadHistory(sheetTask.task.id, sheetTask.identity)}
                        onEdit={() => openEditForm(sheetTask.task, sheetTask.identity)}
                        onPause={() => void setTaskPaused(sheetTask.task, sheetTask.identity, true)}
                        onResume={() => void setTaskPaused(sheetTask.task, sheetTask.identity, false)}
                        onClose={() => setSheetTask(null)}
                    />
                )}

                {/* ═══ ADD TASK FORM ═══ */}
                {showAddForm && (
                    <TaskFormModal
                        mode="add"
                        form={form}
                        setField={setField}
                        setCategory={setFormCategory}
                        setTaskType={setTaskType}
                        setTrigger={setTrigger}
                        engineHours={engineHours}
                        onSubmit={handleAddTask}
                        onClose={() => {
                            setShowAddForm(false);
                            setAddFormIdentity(null);
                        }}
                    />
                )}

                {/* ═══ EDIT TASK MODAL ═══ */}
                {showEditForm && editTask && (
                    <TaskFormModal
                        mode="edit"
                        form={form}
                        setField={setField}
                        setCategory={setFormCategory}
                        setTaskType={setTaskType}
                        setTrigger={setTrigger}
                        engineHours={engineHours}
                        onSubmit={handleEditTask}
                        onClose={() => {
                            setShowEditForm(false);
                            setEditTask(null);
                        }}
                    />
                )}

                {/* ═══════════════════════════════════════════ */}
                {/* HISTORY OVERLAY */}
                {/* ═══════════════════════════════════════════ */}
                {showHistory && (
                    // Opened from the service sheet (OverlayPortal 'modal',
                    // z-1100), so it takes the 'nested' band: at z-1000 it
                    // opened underneath and History looked like it did nothing.
                    <ModalSheet
                        isOpen={true}
                        onClose={() => setShowHistory(false)}
                        title="Service history"
                        zIndex="z-1200"
                    >
                        {visibleHistory.length === 0 ? (
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
                                            d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
                                        />
                                    </svg>
                                }
                                title="No service history"
                                subtitle="Service records will appear here after you log your first maintenance task."
                                className="py-8"
                            />
                        ) : (
                            <div className="space-y-3">
                                {/* The skipper may remove a mistaken record (126-B7a);
                                    crew can't, as deletes are the skipper's. */}
                                {!sharedBinder && (
                                    <p className="text-xs text-gray-400">
                                        Removing a record doesn&apos;t change when the task is next due.
                                    </p>
                                )}
                                {visibleHistory.map((h) => {
                                    const day = formatDisplayDate(h.completed_at, { weekday: false });
                                    // Two records on one day (a check logged twice): the
                                    // phone's clock tells them apart.
                                    const sameDay = visibleHistory.some(
                                        (other) =>
                                            other !== h &&
                                            formatDisplayDate(other.completed_at, { weekday: false }) === day,
                                    );
                                    const at = sameDay ? clockTime(h.completed_at) : null;
                                    return (
                                        <div
                                            key={h.id}
                                            className="flex items-start gap-2 bg-white/3 border border-white/6 rounded-xl p-4"
                                        >
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center justify-between gap-2 mb-1">
                                                    <p className="text-sm font-bold text-white">
                                                        {formatDisplayDate(h.completed_at)}
                                                        {at && ` · ${at}`}
                                                    </p>
                                                    {h.engine_hours_at_service !== null && (
                                                        <span className="text-label text-sky-400 font-bold">
                                                            @ {h.engine_hours_at_service?.toLocaleString()} hrs
                                                        </span>
                                                    )}
                                                </div>
                                                {h.notes && <p className="text-xs text-gray-400 mt-1">{h.notes}</p>}
                                                {h.cost !== null && h.cost > 0 && (
                                                    <p className="text-xs text-amber-400 font-bold mt-1">
                                                        ${h.cost.toFixed(2)}
                                                    </p>
                                                )}
                                            </div>
                                            {!sharedBinder && (
                                                <button
                                                    type="button"
                                                    aria-label={`Remove the ${day}${at ? ` ${at}` : ''} record`}
                                                    onClick={() => handleRemoveRecord(h)}
                                                    className="-my-3 -mr-2 min-h-[44px] shrink-0 px-2 text-xs font-bold text-red-400 hover:text-red-300"
                                                >
                                                    Remove
                                                </button>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </ModalSheet>
                )}
            </div>

            {/* Delete a task with service records? Pause is the gentler way
                out, and the prominent one (126-B7a). A repair is never paused
                (132-B15): an open one is offered Mark fixed instead, which
                keeps its records too. A paused task, or a fixed repair, is
                only asked about its records, which stay once the server keeps
                them (131-B7) and go with it until then. */}
            {deleteAsk && (
                <ConfirmDialog
                    isOpen={true}
                    title={`Delete “${deleteAsk.task.title}”?`}
                    message={
                        historyKept
                            ? `Its ${deleteAsk.records} service record${deleteAsk.records === 1 ? ' stays' : 's stay'} in your service history.`
                            : `Its ${deleteAsk.records} service record${deleteAsk.records === 1 ? ' goes' : 's go'} with it, on every device.`
                    }
                    confirmLabel={historyKept ? 'Delete task' : 'Delete task and records'}
                    cancelLabel="Keep"
                    destructive
                    alternative={
                        !deleteAsk.task.is_active
                            ? undefined
                            : deleteAsk.task.category === 'Repair'
                              ? {
                                    label: 'Mark fixed instead',
                                    onSelect: () => {
                                        setDeleteAsk(null);
                                        void markRepairFixed(deleteAsk.task, deleteAsk.identity, null);
                                    },
                                }
                              : {
                                    label: 'Pause instead',
                                    onSelect: () => {
                                        setDeleteAsk(null);
                                        void setTaskPaused(deleteAsk.task, deleteAsk.identity, true);
                                    },
                                }
                    }
                    onConfirm={() => {
                        setDeleteAsk(null);
                        if (isAuthIdentityScopeCurrent(deleteAsk.identity)) deleteTaskNow(deleteAsk.task);
                    }}
                    onCancel={() => setDeleteAsk(null)}
                />
            )}

            <UndoToast key={undoToastKey} {...undoToastProps} />
            {/* Above the Service history sheet, which is portalled too. */}
            {portalTarget && createPortal(<UndoToast key={recordToastKey} {...recordToastProps} />, portalTarget)}
        </div>
    );
};
