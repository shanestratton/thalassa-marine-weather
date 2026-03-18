/**
 * MaintenanceHub — Vessel Maintenance & Routine Tracker
 *
 * Three-region layout:
 *   1. Engine Hours Card: Prominent editable counter at the top
 *   2. Traffic Light List: Tasks sorted by urgency (red → yellow → green → grey)
 *   3. Log Service Sheet: Bottom sheet for recording a maintenance event
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('MaintenanceHub');
import { LocalMaintenanceService as MaintenanceService } from '../../services/vessel/LocalMaintenanceService';
import { calculateStatus, type TaskWithStatus, type TrafficLight } from '../../services/MaintenanceService';
import type { MaintenanceTask, MaintenanceCategory, MaintenanceTriggerType, MaintenanceHistory } from '../../types';
import { triggerHaptic } from '../../utils/system';
import { exportChecklist, exportServiceHistory } from '../../services/MaintenancePdfService';
import { SlideToAction } from '../ui/SlideToAction';
import { EmptyState } from '../ui/EmptyState';
import { PageHeader } from '../ui/PageHeader';
import { toast } from '../Toast';
import { useSwipeable } from '../../hooks/useSwipeable';
import { UndoToast } from '../ui/UndoToast';
import { ModalSheet } from '../ui/ModalSheet';
import { useMaintenanceForm } from '../../hooks/useMaintenanceForm';
import { useRealtimeSyncMulti } from '../../hooks/useRealtimeSync';
import { useSuccessFlash } from '../../hooks/useSuccessFlash';
import { CATEGORIES, TRIGGER_LABELS } from './maintenance/constants';
import { ServiceLogSheet } from './maintenance/ServiceLogSheet';
import { TaskFormModal } from './maintenance/TaskFormModal';

interface MaintenanceHubProps {
    onBack: () => void;
}

// ── Category config (imported from ./maintenance/constants) ──

/** Map period triggers to their interval in days */
const PERIOD_DAYS: Partial<Record<MaintenanceTriggerType, number>> = {
    daily: 1,
    quarterly: 90,
    monthly: 30,
    bi_annual: 182,
    annual: 365,
};

// Traffic light colors
const LIGHT_COLORS: Record<TrafficLight, { dot: string; bg: string; border: string; text: string }> = {
    red: { dot: 'bg-red-500', bg: 'bg-red-500/10', border: 'border-red-500/30', text: 'text-red-400' },
    yellow: { dot: 'bg-amber-500', bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-400' },
    green: {
        dot: 'bg-emerald-500',
        bg: 'bg-emerald-500/10',
        border: 'border-emerald-500/30',
        text: 'text-emerald-400',
    },
    grey: { dot: 'bg-gray-500', bg: 'bg-gray-500/10', border: 'border-gray-500/20', text: 'text-gray-400' },
};

// ── SwipeableTaskCard ──────────────────────────────────────────
interface SwipeableTaskCardProps {
    task: TaskWithStatus;
    categories: typeof CATEGORIES;
    lightColors: typeof LIGHT_COLORS;
    triggerLabels: typeof TRIGGER_LABELS;
    onTap: () => void;
    onDelete: () => void;
}

const SwipeableTaskCard: React.FC<SwipeableTaskCardProps> = ({
    task,
    categories,
    lightColors,
    triggerLabels: _triggerLabels,
    onTap,
    onDelete,
}) => {
    const { swipeOffset, isSwiping, resetSwipe, ref } = useSwipeable();
    const light = lightColors[task.status];
    const catConfig = categories.find((c) => c.id === task.category);

    return (
        <div className="relative overflow-hidden rounded-lg">
            {/* Delete button (revealed on swipe) */}
            <div
                className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center rounded-r-lg transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={() => {
                    resetSwipe();
                    onDelete();
                }}
            >
                <div className="text-center text-white">
                    <svg className="w-5 h-5 mx-auto mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                    </svg>
                    <span className="text-label font-bold">Delete</span>
                </div>
            </div>

            {/* Main card (slides on swipe) */}
            <div
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} bg-slate-800/40 rounded-lg p-3 border border-white/5 border-l-2 ${
                    task.status === 'red'
                        ? 'border-l-red-500'
                        : task.status === 'yellow'
                          ? 'border-l-amber-400'
                          : task.status === 'green'
                            ? 'border-l-emerald-500'
                            : 'border-l-gray-500'
                }`}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                ref={ref}
            >
                {/* Category badge — top of card */}
                <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-micro">{catConfig?.icon || '📋'}</span>
                    <span className="text-micro font-bold text-gray-400 uppercase tracking-widest">
                        {catConfig?.label || task.category}
                    </span>
                </div>
                {/* Row 1: Title + 3-dot menu */}
                <div className="flex items-start justify-between gap-2">
                    <h4 className="text-sm font-bold text-white truncate flex-1 min-w-0">{task.title}</h4>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onTap();
                        }}
                        className="p-1.5 -mr-1 -mt-0.5 rounded-lg hover:bg-white/10 transition-colors shrink-0"
                        aria-label="Task options"
                    >
                        <svg className="w-4 h-4 text-slate-400" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="5" r="1.5" />
                            <circle cx="12" cy="12" r="1.5" />
                            <circle cx="12" cy="19" r="1.5" />
                        </svg>
                    </button>
                </div>

                {/* Row 2: Status label + due info */}
                <div className="flex items-center justify-between mt-1.5">
                    <p className={`text-label font-bold uppercase tracking-widest ${light.text}`}>{task.statusLabel}</p>
                    <div className="flex items-center gap-2">
                        {task.trigger_type === 'engine_hours' && task.next_due_hours !== null && (
                            <span className="text-label text-slate-400 font-mono">
                                @ {task.next_due_hours?.toLocaleString()} hrs
                            </span>
                        )}
                        {task.next_due_date && (
                            <span className="text-label text-slate-400 font-mono">
                                {new Date(task.next_due_date).toLocaleDateString()}
                            </span>
                        )}
                    </div>
                </div>

                {/* Row 3: Last serviced */}
                {task.last_completed && (
                    <p className="text-label text-slate-400 mt-1">
                        Last serviced: {new Date(task.last_completed).toLocaleDateString()}
                    </p>
                )}
            </div>
        </div>
    );
};

export const MaintenanceHub: React.FC<MaintenanceHubProps> = ({ onBack }) => {
    // ── State ──
    const [tasks, setTasks] = useState<MaintenanceTask[]>([]);
    const [engineHours, setEngineHours] = useState<number>(0);
    const [engineHoursInput, setEngineHoursInput] = useState<string>('0');
    const [isEditingHours, setIsEditingHours] = useState(false);
    const [loading, setLoading] = useState(true);

    // Log Service sheet
    const [sheetTask, setSheetTask] = useState<TaskWithStatus | null>(null);
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
    } = useMaintenanceForm();
    const [showAddForm, setShowAddForm] = useState(false);

    // History
    const [historyItems, setHistoryItems] = useState<MaintenanceHistory[]>([]);
    const [showHistory, setShowHistory] = useState(false);

    // Edit task
    const [showEditForm, setShowEditForm] = useState(false);
    const [editTask, setEditTask] = useState<TaskWithStatus | null>(null);

    // Export
    const [showExportModal, setShowExportModal] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [exporting, setExporting] = useState(false);

    const hoursInputRef = useRef<HTMLInputElement>(null);
    const { ref: listRef, flash } = useSuccessFlash();

    // ── Load ──
    const loadTasks = useCallback(async () => {
        try {
            setLoading(true);
            const data = await MaintenanceService.getTasks();

            // Auto-seed defaults for first-time users
            if (data.length === 0 && !localStorage.getItem('thalassa_maintenance_seeded')) {
                try {
                    await MaintenanceService.seedDefaults();
                    localStorage.setItem('thalassa_maintenance_seeded', '1');
                    const seeded = await MaintenanceService.getTasks();
                    setTasks(seeded);
                    toast.success('40 suggested tasks added — customise to suit your vessel');
                    return;
                } catch (seedErr) {
                    log.warn(' seed failed:', seedErr);
                    // Proceed with empty list — user can add manually
                }
            }

            setTasks(data);
        } catch (e) {
            log.error('Failed to load tasks:', e);
            toast.error('Failed to load maintenance tasks');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadTasks();
        // Load saved engine hours from localStorage
        const saved = localStorage.getItem('thalassa_engine_hours');
        if (saved) {
            const hrs = parseInt(saved, 10);
            setEngineHours(hrs);
            setEngineHoursInput(hrs.toLocaleString());
        }
    }, [loadTasks]);

    // Realtime sync — crew edits appear instantly
    useRealtimeSyncMulti(['maintenance_tasks', 'maintenance_history'], loadTasks);

    // ── Engine Hours ──
    const saveEngineHours = useCallback(() => {
        const parsed = parseInt(engineHoursInput.replace(/,/g, ''), 10);
        if (!isNaN(parsed) && parsed >= 0) {
            setEngineHours(parsed);
            setEngineHoursInput(parsed.toLocaleString());
            localStorage.setItem('thalassa_engine_hours', String(parsed));
        } else {
            setEngineHoursInput(engineHours.toLocaleString());
        }
        setIsEditingHours(false);
    }, [engineHoursInput, engineHours]);

    // Category display order: Repair first, then rest
    const CATEGORY_ORDER: MaintenanceCategory[] = ['Repair', 'Engine', 'Safety', 'Hull', 'Rigging', 'Routine'];

    const tasksWithStatus = useMemo(() => {
        const withStatus = tasks.map((t) => calculateStatus(t, engineHours));
        // Sort: category order first, then alphabetical within each category
        return withStatus.sort((a, b) => {
            const catA = CATEGORY_ORDER.indexOf(a.category);
            const catB = CATEGORY_ORDER.indexOf(b.category);
            if (catA !== catB) return catA - catB;
            return a.title.localeCompare(b.title);
        });
    }, [tasks, engineHours]);

    // Group tasks by category for rendering
    const groupedTasks = useMemo(() => {
        const groups: { category: MaintenanceCategory; tasks: TaskWithStatus[] }[] = [];
        for (const cat of CATEGORY_ORDER) {
            const catTasks = tasksWithStatus.filter((t) => t.category === cat);
            if (catTasks.length > 0) groups.push({ category: cat, tasks: catTasks });
        }
        return groups;
    }, [tasksWithStatus]);

    // Status counts for the header
    const counts = useMemo(() => {
        const all = tasks.map((t) => calculateStatus(t, engineHours));
        return {
            red: all.filter((t) => t.status === 'red').length,
            yellow: all.filter((t) => t.status === 'yellow').length,
            green: all.filter((t) => t.status === 'green').length,
        };
    }, [tasks, engineHours]);

    // ── Log Service ──
    const handleLogService = useCallback(async () => {
        if (!sheetTask) return;
        setSheetSaving(true);
        try {
            triggerHaptic('medium');
            await MaintenanceService.logService(sheetTask.id, engineHours || null, sheetNotes.trim() || null, null);
            setSheetTask(null);
            setSheetNotes('');
            await loadTasks(); // Refresh list
            toast.success('Service logged');
            flash();
        } catch (e) {
            log.error('Failed to log service:', e);
            toast.error('Failed to log service');
        } finally {
            setSheetSaving(false);
        }
    }, [sheetTask, engineHours, sheetNotes, loadTasks]);

    // ── Add Task ──
    const handleAddTask = useCallback(async () => {
        if (!form.title.trim()) return;
        try {
            triggerHaptic('medium');

            // Repairs: auto-set to daily trigger with today's due date
            // They'll go red almost immediately — fix it or delete it!
            const isRepair = form.category === 'Repair';
            const triggerType = isRepair ? 'daily' : form.trigger;

            // Auto-compute interval and due date for period-based triggers
            const periodDays = isRepair ? 1 : PERIOD_DAYS[form.trigger];
            const intervalValue =
                triggerType === 'engine_hours'
                    ? form.interval
                        ? parseInt(form.interval, 10)
                        : null
                    : (periodDays ?? null);
            const dueDate =
                triggerType === 'engine_hours'
                    ? null
                    : isRepair
                      ? new Date().toISOString().split('T')[0]
                      : form.dueDate ||
                        new Date(Date.now() + (periodDays || 30) * 86400000).toISOString().split('T')[0];

            await MaintenanceService.createTask({
                title: form.title.trim(),
                description: form.description.trim() || null,
                category: form.category,
                trigger_type: triggerType,
                interval_value: intervalValue,
                next_due_date: dueDate,
                next_due_hours: triggerType === 'engine_hours' && form.dueHours ? parseInt(form.dueHours, 10) : null,
                last_completed: null,
                is_active: true,
            });
            setShowAddForm(false);
            toast.success('Task created');
            flash();
            resetForm();
            await loadTasks();
        } catch (e) {
            log.error('Failed to create task:', e);
            toast.error('Failed to create task');
        }
    }, [form, resetForm, loadTasks]);

    // ── Load History ──
    const loadHistory = useCallback(async (taskId: string) => {
        try {
            const h = await MaintenanceService.getHistory(taskId);
            setHistoryItems(h);
            setShowHistory(true);
        } catch (e) {
            log.error('Failed to load history:', e);
        }
    }, []);

    // ── Export PDF ──
    const handleExport = useCallback(
        async (type: 'checklist' | 'history') => {
            setExporting(true);
            try {
                triggerHaptic('medium');
                const vesselName = localStorage.getItem('thalassa_vessel_name') || 'Vessel';
                if (type === 'checklist') {
                    await exportChecklist(engineHours, vesselName);
                } else {
                    await exportServiceHistory(vesselName);
                }
                setShowExportModal(false);
            } catch (e) {
                log.error('Failed to export PDF:', e);
                toast.error('PDF export failed');
            } finally {
                setExporting(false);
            }
        },
        [engineHours],
    );

    const [deletedTask, setDeletedTask] = useState<MaintenanceTask | null>(null);

    // ── Soft-delete with undo ──
    const handleDeleteTask = useCallback(
        (taskId: string) => {
            const task = tasks.find((t) => t.id === taskId);
            if (!task) return;
            triggerHaptic('medium');
            // Remove from UI immediately
            setTasks((prev) => prev.filter((t) => t.id !== taskId));
            setSheetTask(null);
            setDeletedTask(task);
        },
        [tasks],
    );

    // Called by UndoToast after 5s — performs the actual API delete
    const handleDismissDelete = useCallback(async () => {
        if (!deletedTask) return;
        const task = deletedTask;
        setDeletedTask(null);
        try {
            await MaintenanceService.deleteTask(task.id);
        } catch (e) {
            log.warn(' delete failed:', e);
            toast.error('Failed to delete task');
            setTasks((prev) => [...prev, task]);
        }
    }, [deletedTask]);

    const handleUndoDelete = useCallback(() => {
        if (deletedTask) {
            setTasks((prev) => [...prev, deletedTask]);
            toast.success('Task restored');
        }
        setDeletedTask(null);
    }, [deletedTask]);

    // ── Edit Task ──
    const openEditForm = useCallback(
        (task: TaskWithStatus) => {
            setEditTask(task);
            populateForm({
                title: task.title,
                category: task.category,
                trigger: task.trigger_type,
                interval: String(task.interval_value || '200'),
                dueDate: task.next_due_date ? task.next_due_date.split('T')[0] : '',
                dueHours: task.next_due_hours !== null ? String(task.next_due_hours) : '',
                description: task.description || '',
            });
            setShowEditForm(true);
        },
        [populateForm],
    );

    const handleEditTask = useCallback(async () => {
        if (!editTask || !form.title.trim()) return;
        try {
            triggerHaptic('medium');
            const periodDays = PERIOD_DAYS[form.trigger];
            const intervalValue =
                form.trigger === 'engine_hours'
                    ? form.interval
                        ? parseInt(form.interval, 10)
                        : null
                    : (periodDays ?? null);
            const dueDate = form.trigger === 'engine_hours' ? null : form.dueDate || null;

            await MaintenanceService.updateTask(editTask.id, {
                title: form.title.trim(),
                description: form.description.trim() || null,
                category: form.category,
                trigger_type: form.trigger,
                interval_value: intervalValue,
                next_due_date: dueDate,
                next_due_hours: form.trigger === 'engine_hours' && form.dueHours ? parseInt(form.dueHours, 10) : null,
            });
            setShowEditForm(false);
            setEditTask(null);
            setSheetTask(null);
            await loadTasks();
            toast.success('Task updated');
            flash();
        } catch (e) {
            log.error('Failed to update task:', e);
            toast.error('Failed to update task');
        }
    }, [editTask, form, loadTasks]);

    // ── Render ──
    return (
        <div className="relative h-full bg-slate-950 overflow-hidden">
            <div className="flex flex-col h-full">
                <PageHeader
                    title="Maintenance"
                    subtitle="Tasks & Expiry"
                    onBack={onBack}
                    breadcrumbs={["Ship's Office", 'Maintenance']}
                    status={
                        <>
                            {counts.red > 0 && (
                                <span className="px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 text-label font-black">
                                    {counts.red}
                                </span>
                            )}
                            {counts.yellow > 0 && (
                                <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-label font-black">
                                    {counts.yellow}
                                </span>
                            )}
                            <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-label font-black">
                                {counts.green}
                            </span>
                        </>
                    }
                    action={
                        <div className="relative">
                            <button
                                onClick={() => setMenuOpen(!menuOpen)}
                                className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
                                aria-label="More options"
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
                                        d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z"
                                    />
                                </svg>
                            </button>
                            {menuOpen && (
                                <>
                                    <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                                    <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-slate-800 border border-white/10 rounded-xl shadow-2xl overflow-hidden">
                                        <button
                                            onClick={() => {
                                                handleExport('checklist');
                                                setMenuOpen(false);
                                            }}
                                            className="w-full text-left px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors flex items-center gap-3"
                                        >
                                            <svg
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
                                            Blank Checklist PDF
                                        </button>
                                        <button
                                            onClick={() => {
                                                handleExport('history');
                                                setMenuOpen(false);
                                            }}
                                            className="w-full text-left px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors flex items-center gap-3 border-t border-white/5"
                                        >
                                            <svg
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
                                            Service History PDF
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    }
                />

                {/* ═══ ENGINE HOURS CARD ═══ */}
                <div className="shrink-0 px-4 pb-3">
                    <button
                        onClick={() => {
                            setIsEditingHours(true);
                            setTimeout(() => hoursInputRef.current?.focus(), 100);
                        }}
                        className="w-full bg-gradient-to-br from-sky-500/15 to-sky-500/15 border border-sky-500/20 rounded-2xl p-5 text-left group hover:from-sky-500/20 hover:to-sky-500/20 transition-all active:scale-[0.98]"
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
                                        Current Engine Hours
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
                                            className="bg-transparent border-b-2 border-sky-400 text-3xl font-black text-white tracking-wider outline-none w-40"
                                            autoFocus
                                        />
                                    ) : (
                                        <p className="text-3xl font-black text-white tracking-wider">
                                            {engineHours.toLocaleString()}
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
                </div>

                {/* ═══ TRAFFIC LIGHT LIST (scrollable) ═══ */}
                <div ref={listRef} className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 space-y-3">
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                        </div>
                    ) : groupedTasks.length === 0 ? (
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
                            title="No Maintenance Tasks"
                            subtitle="Set up service intervals for your engine, rigging, and safety gear. Slide below to create your first task."
                        />
                    ) : (
                        groupedTasks.map((group) => {
                            const catConfig = CATEGORIES.find((c) => c.id === group.category);
                            return (
                                <div key={group.category}>
                                    <div className="flex items-center gap-2 mb-2 mt-1">
                                        <span className="text-sm">{catConfig?.icon}</span>
                                        <span className="text-label font-black text-gray-400 uppercase tracking-widest">
                                            {catConfig?.label}
                                        </span>
                                        <span className="text-micro text-gray-400 font-bold">
                                            ({group.tasks.length})
                                        </span>
                                    </div>
                                    <div className="space-y-2">
                                        {group.tasks.map((task) => (
                                            <SwipeableTaskCard
                                                key={task.id}
                                                task={task}
                                                categories={CATEGORIES}
                                                lightColors={LIGHT_COLORS}
                                                triggerLabels={TRIGGER_LABELS}
                                                onTap={() => {
                                                    triggerHaptic('light');
                                                    setSheetTask(task);
                                                }}
                                                onDelete={() => handleDeleteTask(task.id)}
                                            />
                                        ))}
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>

                {/* ═══ ADD TASK BUTTON (fixed at bottom) ═══ */}
                <div
                    className="shrink-0 px-4 pt-2 bg-slate-950"
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                >
                    <SlideToAction
                        label="Slide to Add Task"
                        thumbIcon={
                            <svg
                                className="w-5 h-5 text-white"
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
                            setShowAddForm(true);
                        }}
                        theme="sky"
                    />
                </div>

                {/* ═══ LOG SERVICE SHEET ═══ */}
                {sheetTask && (
                    <ServiceLogSheet
                        task={sheetTask}
                        engineHours={engineHours}
                        notes={sheetNotes}
                        onNotesChange={setSheetNotes}
                        saving={sheetSaving}
                        onLog={handleLogService}
                        onHistory={() => loadHistory(sheetTask.id)}
                        onEdit={() => openEditForm(sheetTask)}
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
                        onClose={() => setShowAddForm(false)}
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
                    <ModalSheet
                        isOpen={true}
                        onClose={() => setShowHistory(false)}
                        title="Service History"
                        zIndex="z-[1000]"
                    >
                        {historyItems.length === 0 ? (
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
                                title="No Service History"
                                subtitle="Service records will appear here after you log your first maintenance task."
                                className="py-8"
                            />
                        ) : (
                            <div className="space-y-3">
                                {historyItems.map((h) => (
                                    <div
                                        key={h.id}
                                        className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4"
                                    >
                                        <div className="flex items-center justify-between mb-1">
                                            <p className="text-sm font-bold text-white">
                                                {new Date(h.completed_at).toLocaleDateString()}
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
                                ))}
                            </div>
                        )}
                    </ModalSheet>
                )}

                {/* ═══════════════════════════════════════════ */}
                {/* EXPORT PDF MODAL */}
                {/* ═══════════════════════════════════════════ */}
                {showExportModal && (
                    <ModalSheet
                        isOpen={true}
                        onClose={() => setShowExportModal(false)}
                        title="Export PDF"
                        maxWidth="max-w-sm"
                    >
                        <p className="text-xs text-gray-400 mb-5">Choose a report format:</p>

                        {/* Option A: Blank Checklist */}
                        <button
                            onClick={() => handleExport('checklist')}
                            disabled={exporting}
                            className="w-full mb-3 p-4 bg-gradient-to-r from-sky-500/15 to-sky-500/15 border border-sky-500/20 rounded-2xl text-left hover:from-sky-500/25 hover:to-sky-500/25 transition-all active:scale-[0.98] disabled:opacity-50"
                        >
                            <div className="flex items-center gap-3">
                                <div className="p-2.5 bg-sky-500/20 rounded-xl">
                                    <svg
                                        className="w-5 h-5 text-sky-400"
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
                                </div>
                                <div>
                                    <p className="text-sm font-black text-white">Print Blank Checklist</p>
                                    <p className="text-label text-gray-400 mt-0.5">
                                        Printable clipboard for the engine room
                                    </p>
                                </div>
                            </div>
                        </button>

                        {/* Option B: Service History */}
                        <button
                            onClick={() => handleExport('history')}
                            disabled={exporting}
                            className="w-full p-4 bg-gradient-to-r from-amber-500/15 to-amber-500/15 border border-amber-500/20 rounded-2xl text-left hover:from-amber-500/25 hover:to-amber-500/25 transition-all active:scale-[0.98] disabled:opacity-50"
                        >
                            <div className="flex items-center gap-3">
                                <div className="p-2.5 bg-amber-500/20 rounded-xl">
                                    <svg
                                        className="w-5 h-5 text-amber-400"
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
                                </div>
                                <div>
                                    <p className="text-sm font-black text-white">Export Service History</p>
                                    <p className="text-label text-gray-400 mt-0.5">
                                        Formal ledger of all completed work
                                    </p>
                                </div>
                            </div>
                        </button>

                        {exporting && (
                            <div className="flex items-center justify-center gap-2 mt-4">
                                <div className="w-4 h-4 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                                <span className="text-xs text-sky-400 font-bold">Generating PDF...</span>
                            </div>
                        )}
                    </ModalSheet>
                )}
            </div>

            <UndoToast
                isOpen={!!deletedTask}
                message={`"${deletedTask?.title}" deleted`}
                onUndo={handleUndoDelete}
                onDismiss={handleDismissDelete}
            />
        </div>
    );
};
