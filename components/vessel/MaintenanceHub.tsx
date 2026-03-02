/**
 * MaintenanceHub — Vessel Maintenance & Routine Tracker
 *
 * Three-region layout:
 *   1. Engine Hours Card: Prominent editable counter at the top
 *   2. Traffic Light List: Tasks sorted by urgency (red → yellow → green → grey)
 *   3. Log Service Sheet: Bottom sheet for recording a maintenance event
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
    MaintenanceService,
    calculateStatus,
    type TaskWithStatus,
    type TrafficLight,
} from '../../services/MaintenanceService';
import type { MaintenanceTask, MaintenanceCategory, MaintenanceTriggerType, MaintenanceHistory } from '../../types';
import { triggerHaptic } from '../../utils/system';
import { exportChecklist, exportServiceHistory } from '../../services/MaintenancePdfService';
import { SlideToAction } from '../ui/SlideToAction';
import { EmptyState } from '../ui/EmptyState';
import { PageHeader } from '../ui/PageHeader';
import { toast } from '../Toast';
import { useSwipeable } from '../../hooks/useSwipeable';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ModalSheet } from '../ui/ModalSheet';
import { useMaintenanceForm } from '../../hooks/useMaintenanceForm';
import { FormField } from '../ui/FormField';
import { useRealtimeSyncMulti } from '../../hooks/useRealtimeSync';

interface MaintenanceHubProps {
    onBack: () => void;
}

// ── Category config ──
const CATEGORIES: { id: MaintenanceCategory; label: string; icon: string }[] = [
    { id: 'Engine', label: 'Engine', icon: '⚙️' },
    { id: 'Safety', label: 'Safety', icon: '🔴' },
    { id: 'Hull', label: 'Hull', icon: '🚢' },
    { id: 'Rigging', label: 'Rigging', icon: '⛵' },
    { id: 'Routine', label: 'Routine', icon: '📋' },
    { id: 'Repair', label: 'Repair', icon: '🔧' },
];

const TRIGGER_LABELS: Record<MaintenanceTriggerType, string> = {
    engine_hours: '⚙️ Engine Hours',
    daily: '📅 Daily',
    weekly: '📅 Weekly',
    monthly: '📅 Monthly',
    bi_annual: '📅 Bi-Annual',
    annual: '📅 Annual',
};

/** Map period triggers to their interval in days */
const PERIOD_DAYS: Partial<Record<MaintenanceTriggerType, number>> = {
    daily: 1,
    weekly: 7,
    monthly: 30,
    bi_annual: 182,
    annual: 365,
};

// Traffic light colors
const LIGHT_COLORS: Record<TrafficLight, { dot: string; bg: string; border: string; text: string }> = {
    red: { dot: 'bg-red-500', bg: 'bg-red-500/10', border: 'border-red-500/30', text: 'text-red-400' },
    yellow: { dot: 'bg-amber-500', bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-400' },
    green: { dot: 'bg-emerald-500', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400' },
    grey: { dot: 'bg-gray-500', bg: 'bg-gray-500/10', border: 'border-gray-500/20', text: 'text-gray-500' },
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
    task, categories, lightColors, triggerLabels, onTap, onDelete,
}) => {
    const { swipeOffset, isSwiping, resetSwipe, handlers } = useSwipeable();
    const light = lightColors[task.status];
    const catConfig = categories.find(c => c.id === task.category);

    return (
        <div className="relative overflow-hidden rounded-lg">
            {/* Delete button (revealed on swipe) */}
            <div
                className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center rounded-r-lg transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={() => { resetSwipe(); onDelete(); }}
            >
                <div className="text-center text-white">
                    <svg className="w-5 h-5 mx-auto mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    <span className="text-[11px] font-bold">Delete</span>
                </div>
            </div>

            {/* Main card (slides on swipe) */}
            <div
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} bg-slate-800/40 rounded-lg p-3 border border-white/5 border-l-2 ${task.status === 'red' ? 'border-l-red-500'
                    : task.status === 'yellow' ? 'border-l-amber-400'
                        : task.status === 'green' ? 'border-l-emerald-500'
                            : 'border-l-gray-500'
                    }`}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                {...handlers}
            >
                {/* Category badge — top of card */}
                <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-[10px]">{catConfig?.icon || '📋'}</span>
                    <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">{catConfig?.label || task.category}</span>
                </div>
                {/* Row 1: Title + 3-dot menu */}
                <div className="flex items-start justify-between gap-2">
                    <h4 className="text-sm font-bold text-white truncate flex-1 min-w-0">{task.title}</h4>
                    <button
                        onClick={(e) => { e.stopPropagation(); onTap(); }}
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
                    <p className={`text-[11px] font-bold uppercase tracking-widest ${light.text}`}>
                        {task.statusLabel}
                    </p>
                    <div className="flex items-center gap-2">
                        {task.trigger_type === 'engine_hours' && task.next_due_hours !== null && (
                            <span className="text-[11px] text-slate-400 font-mono">
                                @ {task.next_due_hours?.toLocaleString()} hrs
                            </span>
                        )}
                        {task.next_due_date && (
                            <span className="text-[11px] text-slate-400 font-mono">
                                {new Date(task.next_due_date).toLocaleDateString()}
                            </span>
                        )}
                    </div>
                </div>

                {/* Row 3: Last serviced */}
                {task.last_completed && (
                    <p className="text-[11px] text-slate-500 mt-1">
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
    const { form, setField, setCategory: setFormCategory, setTaskType, setTrigger, reset: resetForm, populate: populateForm } = useMaintenanceForm();
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

    // ── Load ──
    const loadTasks = useCallback(async () => {
        try {
            setLoading(true);
            const data = await MaintenanceService.getTasks();
            setTasks(data);
        } catch (e) {
            console.error('Failed to load tasks:', e);
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
        const withStatus = tasks.map(t => calculateStatus(t, engineHours));
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
            const catTasks = tasksWithStatus.filter(t => t.category === cat);
            if (catTasks.length > 0) groups.push({ category: cat, tasks: catTasks });
        }
        return groups;
    }, [tasksWithStatus]);

    // Status counts for the header
    const counts = useMemo(() => {
        const all = tasks.map(t => calculateStatus(t, engineHours));
        return {
            red: all.filter(t => t.status === 'red').length,
            yellow: all.filter(t => t.status === 'yellow').length,
            green: all.filter(t => t.status === 'green').length,
        };
    }, [tasks, engineHours]);

    // ── Log Service ──
    const handleLogService = useCallback(async () => {
        if (!sheetTask) return;
        setSheetSaving(true);
        try {
            triggerHaptic('medium');
            await MaintenanceService.logService(
                sheetTask.id,
                engineHours || null,
                sheetNotes.trim() || null,
                null,
            );
            setSheetTask(null);
            setSheetNotes('');
            await loadTasks(); // Refresh list
            toast.success('Service logged');
        } catch (e) {
            console.error('Failed to log service:', e);
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
            const intervalValue = triggerType === 'engine_hours'
                ? (form.interval ? parseInt(form.interval, 10) : null)
                : (periodDays ?? null);
            const dueDate = triggerType === 'engine_hours'
                ? null
                : (isRepair
                    ? new Date().toISOString().split('T')[0]
                    : (form.dueDate || new Date(Date.now() + (periodDays || 30) * 86400000).toISOString().split('T')[0]));

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
            resetForm();
            await loadTasks();
        } catch (e) {
            console.error('Failed to create task:', e);
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
            console.error('Failed to load history:', e);
        }
    }, []);

    // ── Export PDF ──
    const handleExport = useCallback(async (type: 'checklist' | 'history') => {
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
            console.error('Failed to export PDF:', e);
            toast.error('PDF export failed');
        } finally {
            setExporting(false);
        }
    }, [engineHours]);

    const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

    // ── Delete Task ──
    const handleDeleteTask = useCallback(async (taskId: string) => {
        setDeleteTargetId(taskId);
    }, []);

    const confirmDeleteTask = useCallback(async () => {
        if (!deleteTargetId) return;
        try {
            triggerHaptic('medium');
            await MaintenanceService.deleteTask(deleteTargetId);
            await loadTasks();
        } catch (e) {
            console.error('Failed to delete task:', e);
            toast.error('Failed to delete task');
        } finally {
            setDeleteTargetId(null);
        }
    }, [deleteTargetId, loadTasks]);

    // ── Edit Task ──
    const openEditForm = useCallback((task: TaskWithStatus) => {
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
    }, [populateForm]);

    const handleEditTask = useCallback(async () => {
        if (!editTask || !form.title.trim()) return;
        try {
            triggerHaptic('medium');
            const periodDays = PERIOD_DAYS[form.trigger];
            const intervalValue = form.trigger === 'engine_hours'
                ? (form.interval ? parseInt(form.interval, 10) : null)
                : (periodDays ?? null);
            const dueDate = form.trigger === 'engine_hours'
                ? null
                : (form.dueDate || null);

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
        } catch (e) {
            console.error('Failed to update task:', e);
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
                    breadcrumbs={['Ship\'s Office', 'Maintenance']}
                    status={
                        <>
                            {counts.red > 0 && (
                                <span className="px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 text-[11px] font-black">{counts.red}</span>
                            )}
                            {counts.yellow > 0 && (
                                <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-[11px] font-black">{counts.yellow}</span>
                            )}
                            <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[11px] font-black">{counts.green}</span>
                        </>
                    }
                    action={
                        <div className="relative">
                            <button
                                onClick={() => setMenuOpen(!menuOpen)}
                                className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
                            >
                                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z" />
                                </svg>
                            </button>
                            {menuOpen && (
                                <>
                                    <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                                    <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-slate-800 border border-white/10 rounded-xl shadow-2xl overflow-hidden">
                                        <button
                                            onClick={() => { handleExport('checklist'); setMenuOpen(false); }}
                                            className="w-full text-left px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors flex items-center gap-3"
                                        >
                                            <svg className="w-4 h-4 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
                                            </svg>
                                            Blank Checklist PDF
                                        </button>
                                        <button
                                            onClick={() => { handleExport('history'); setMenuOpen(false); }}
                                            className="w-full text-left px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors flex items-center gap-3 border-t border-white/5"
                                        >
                                            <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
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
                                    <svg className="w-6 h-6 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                </div>
                                <div>
                                    <p className="text-[11px] text-sky-400/70 font-bold uppercase tracking-widest">Current Engine Hours</p>
                                    {isEditingHours ? (
                                        <input
                                            ref={hoursInputRef}
                                            type="text"
                                            inputMode="numeric"
                                            value={engineHoursInput}
                                            onChange={e => setEngineHoursInput(e.target.value)}
                                            onBlur={saveEngineHours}
                                            onKeyDown={e => { if (e.key === 'Enter') saveEngineHours(); }}
                                            onClick={e => e.stopPropagation()}
                                            className="bg-transparent border-b-2 border-sky-400 text-3xl font-black text-white tracking-wider outline-none w-40"
                                            autoFocus
                                        />
                                    ) : (
                                        <p className="text-3xl font-black text-white tracking-wider">{engineHours.toLocaleString()}</p>
                                    )}
                                </div>
                            </div>
                            {!isEditingHours && (
                                <svg className="w-5 h-5 text-sky-400/50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
                                </svg>
                            )}
                        </div>
                    </button>
                </div>



                {/* ═══ TRAFFIC LIGHT LIST (scrollable) ═══ */}
                <div className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 space-y-3">
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                        </div>
                    ) : groupedTasks.length === 0 ? (
                        <EmptyState
                            icon={<svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.3 5.3a1.5 1.5 0 01-2.12 0l-.36-.36a1.5 1.5 0 010-2.12l5.3-5.3m2.1-2.1l4.24-4.24a3 3 0 014.24 0l.36.36a3 3 0 010 4.24l-4.24 4.24m-6.36-6.36l6.36 6.36" /></svg>}
                            title="No Maintenance Tasks"
                            subtitle="Set up service intervals for your engine, rigging, and safety gear. Slide below to create your first task."
                        />
                    ) : (
                        groupedTasks.map(group => {
                            const catConfig = CATEGORIES.find(c => c.id === group.category);
                            return (
                                <div key={group.category}>
                                    <div className="flex items-center gap-2 mb-2 mt-1">
                                        <span className="text-sm">{catConfig?.icon}</span>
                                        <span className="text-[11px] font-black text-gray-500 uppercase tracking-widest">{catConfig?.label}</span>
                                        <span className="text-[10px] text-gray-500 font-bold">({group.tasks.length})</span>
                                    </div>
                                    <div className="space-y-2">
                                        {group.tasks.map(task => (
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
                <div className="shrink-0 px-4 pt-2 bg-slate-950" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}>
                    <SlideToAction
                        label="Slide to Add Task"
                        thumbIcon={
                            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
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

                {/* ═══════════════════════════════════════════ */}
                {/* LOG SERVICE BOTTOM SHEET */}
                {/* ═══════════════════════════════════════════ */}
                {sheetTask && (
                    <div className="fixed inset-0 z-[999] flex items-center justify-center p-4" onClick={() => setSheetTask(null)}>
                        {/* Backdrop */}
                        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

                        {/* Sheet */}
                        <div
                            className="relative w-full max-w-2xl bg-slate-900 border border-white/10 rounded-2xl p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,20px))] animate-in fade-in zoom-in-95 duration-300 max-h-[calc(100dvh-6rem)]"
                            onClick={e => e.stopPropagation()}
                        >
                            {/* Close X */}
                            <button
                                onClick={() => setSheetTask(null)}
                                className="absolute top-4 right-4 p-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10"
                            >
                                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>

                            {/* Task info */}
                            <div className="flex items-center gap-3 mb-5">
                                <div className={`w-3 h-3 rounded-full ${LIGHT_COLORS[sheetTask.status].dot}`} />
                                <div className="flex-1">
                                    <h3 className="text-lg font-black text-white">{sheetTask.title}</h3>
                                    <p className={`text-xs font-bold ${LIGHT_COLORS[sheetTask.status].text}`}>
                                        {sheetTask.statusLabel}
                                    </p>
                                </div>
                            </div>

                            {/* Engine hours snapshot — only for engine-based tasks */}
                            {sheetTask.trigger_type === 'engine_hours' && (
                                <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-4">
                                    <p className="text-[11px] text-gray-500 font-bold uppercase tracking-widest mb-1">Engine Hours at Service</p>
                                    <p className="text-xl font-black text-white">{engineHours.toLocaleString()} hrs</p>
                                </div>
                            )}

                            {/* Notes */}
                            <div className="mb-4">
                                <label className="text-[11px] text-gray-500 font-bold uppercase tracking-widest block mb-1">
                                    Notes (Optional)
                                </label>
                                <textarea
                                    value={sheetNotes}
                                    onChange={e => setSheetNotes(e.target.value)}
                                    placeholder="Found slight weeping on raw water pump gasket..."
                                    className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm text-white placeholder-gray-500 resize-none h-20 outline-none focus:border-sky-500/30"
                                />
                            </div>



                            {/* Action buttons */}
                            <div className="flex gap-3">
                                <button
                                    onClick={() => loadHistory(sheetTask.id)}
                                    className="px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-xs font-bold text-gray-400 hover:bg-white/10 transition-colors"
                                >
                                    History
                                </button>
                                <button
                                    onClick={() => {
                                        openEditForm(sheetTask);
                                    }}
                                    className="px-4 py-3 bg-sky-500/10 border border-sky-500/20 rounded-xl text-xs font-bold text-sky-400 hover:bg-sky-500/20 transition-colors"
                                >
                                    ✎ Edit
                                </button>
                                <button
                                    onClick={handleLogService}
                                    disabled={sheetSaving}
                                    className="flex-1 py-3.5 bg-gradient-to-r from-emerald-600 to-emerald-600 rounded-xl text-sm font-black text-white uppercase tracking-widest shadow-lg shadow-emerald-500/20 hover:from-emerald-500 hover:to-emerald-500 transition-all active:scale-[0.97] disabled:opacity-50"
                                >
                                    {sheetSaving ? (
                                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mx-auto" />
                                    ) : (
                                        '✓ Log Service'
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* ═══════════════════════════════════════════ */}
                {/* ADD TASK FORM (Bottom Sheet) */}
                {/* ═══════════════════════════════════════════ */}
                {showAddForm && (
                    <div
                        className="fixed inset-0 z-[999] flex items-start justify-center"
                        style={{ padding: '0 12px', paddingTop: 'calc(env(safe-area-inset-top, 0px) + 56px)', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 4rem + 8px)' }}
                        onClick={() => setShowAddForm(false)}
                    >
                        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

                        <div
                            className="relative w-full max-w-2xl bg-slate-900 border border-white/10 rounded-2xl p-4 animate-in fade-in zoom-in-95 duration-300 flex flex-col"
                            style={{ maxHeight: '100%' }}
                            onClick={e => e.stopPropagation()}
                        >
                            {/* Close X */}
                            <button
                                onClick={() => setShowAddForm(false)}
                                className="absolute top-3 right-3 p-1.5 rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10"
                            >
                                <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                            <h3 className="text-base font-black text-white mb-3">New Task</h3>

                            {/* Flex content — shrinks to fit */}
                            <div className="flex-1 min-h-0 flex flex-col gap-2 overflow-y-auto">

                                {/* ── Task Type Selector ── */}
                                <div>
                                    <label className="text-[10px] text-gray-500 font-bold uppercase tracking-wider block mb-1">Type</label>
                                    <div className="grid grid-cols-2 gap-2">
                                        <button
                                            onClick={() => { setTaskType('maintenance'); setFormCategory('Engine'); }}
                                            className={`py-2 rounded-xl text-[13px] font-black transition-all text-center ${form.taskType === 'maintenance'
                                                ? 'bg-sky-500/20 text-sky-400 border-2 border-sky-500/40'
                                                : 'bg-white/5 text-gray-500 border-2 border-white/5'
                                                }`}
                                        >
                                            🔄 Maintenance
                                        </button>
                                        <button
                                            onClick={() => { setTaskType('repair'); setFormCategory('Repair'); }}
                                            className={`py-2 rounded-xl text-[13px] font-black transition-all text-center ${form.taskType === 'repair'
                                                ? 'bg-amber-500/20 text-amber-400 border-2 border-amber-500/40'
                                                : 'bg-white/5 text-gray-500 border-2 border-white/5'
                                                }`}
                                        >
                                            🔧 Repair
                                        </button>
                                    </div>
                                </div>

                                {/* Category chips — only for Maintenance type */}
                                {form.taskType === 'maintenance' && (
                                    <div>
                                        <label className="text-[10px] text-gray-500 font-bold uppercase tracking-wider block mb-1">Category</label>
                                        <div className="grid grid-cols-3 gap-1.5">
                                            {CATEGORIES.filter(cat => cat.id !== 'Repair').map(cat => (
                                                <button
                                                    key={cat.id}
                                                    onClick={() => setFormCategory(cat.id)}
                                                    className={`py-1 rounded-full text-[11px] font-bold transition-all text-center ${form.category === cat.id
                                                        ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                                                        : 'bg-white/5 text-gray-500 border border-white/5'
                                                        }`}
                                                >
                                                    {cat.icon} {cat.label}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Title */}
                                <FormField
                                    label="Task Name"
                                    value={form.title}
                                    onChange={v => setField('title', v)}
                                    placeholder="Main Engine Oil Change"
                                    autoFocus
                                    required
                                    error={!form.title.trim() && form.title !== '' ? 'Task name is required' : undefined}
                                />

                                {/* Notes */}
                                <FormField
                                    label="Notes (Optional)"
                                    type="textarea"
                                    value={form.description}
                                    onChange={v => setField('description', v)}
                                    placeholder="Don't forget to check the bottom for rust..."
                                    rows={1}
                                />

                                {/* Trigger type — hidden for Repair */}
                                {form.category !== 'Repair' && (
                                    <div>
                                        <label className="text-[10px] text-gray-500 font-bold uppercase tracking-wider block mb-1">Schedule</label>
                                        <div className="grid grid-cols-3 gap-1.5">
                                            {(Object.keys(TRIGGER_LABELS) as MaintenanceTriggerType[]).map(t => (
                                                <button
                                                    key={t}
                                                    onClick={() => setTrigger(t)}
                                                    className={`py-1 rounded-full text-[11px] font-bold transition-all text-center ${form.trigger === t
                                                        ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                                                        : 'bg-white/5 text-gray-500 border border-white/5'
                                                        }`}
                                                >
                                                    {TRIGGER_LABELS[t]}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Interval — only for engine hours */}
                                {form.trigger === 'engine_hours' && form.category !== 'Repair' && (
                                    <div className="grid grid-cols-2 gap-2">
                                        <FormField
                                            label="Interval (Hrs)"
                                            value={form.interval}
                                            onChange={v => setField('interval', v)}
                                            placeholder="200"
                                            inputMode="numeric"
                                        />
                                        <FormField
                                            label="Next Due (Hrs)"
                                            value={form.dueHours}
                                            onChange={v => setField('dueHours', v)}
                                            placeholder={String(engineHours + 200)}
                                            inputMode="numeric"
                                        />
                                    </div>
                                )}

                                {/* Next due — for time-based triggers */}
                                {form.trigger !== 'engine_hours' && form.category !== 'Repair' && (
                                    <FormField
                                        label="Starts From"
                                        type="date"
                                        value={form.dueDate}
                                        onChange={v => setField('dueDate', v)}
                                        hint={`Repeats every ${TRIGGER_LABELS[form.trigger].replace('📅 ', '').toLowerCase()}`}
                                    />
                                )}
                            </div>

                            {/* Save — pinned at bottom */}
                            {!form.title.trim() && (
                                <p className="text-[10px] text-amber-400/80 text-center mt-2">Enter a task name to continue</p>
                            )}
                            <button
                                onClick={handleAddTask}
                                disabled={!form.title.trim()}
                                className="w-full py-3 mt-2 bg-gradient-to-r from-sky-600 to-sky-600 rounded-xl text-sm font-black text-white uppercase tracking-[0.15em] shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500 transition-all active:scale-[0.97] disabled:opacity-30 shrink-0"
                            >
                                Create Task
                            </button>
                        </div>
                    </div>
                )}

                {/* ═══════════════════════════════════════════ */}
                {/* EDIT TASK MODAL */}
                {/* ═══════════════════════════════════════════ */}
                {showEditForm && editTask && (
                    <ModalSheet isOpen={true} onClose={() => { setShowEditForm(false); setEditTask(null); }} title="Edit Task">


                        {/* Task Name */}
                        <div className="mb-3">
                            <FormField
                                label="Task Name"
                                value={form.title}
                                onChange={v => setField('title', v)}
                                placeholder="Main Engine Oil Change"
                                required
                            />
                        </div>

                        {/* Notes */}
                        <div className="mb-4">
                            <FormField
                                label="Notes (Optional)"
                                type="textarea"
                                value={form.description}
                                onChange={v => setField('description', v)}
                                placeholder="Don't forget to check for rust..."
                                rows={2}
                            />
                        </div>

                        {/* Category */}
                        <div className="mb-4">
                            <label className="text-[11px] text-gray-500 font-bold uppercase tracking-widest block mb-2">Category</label>
                            <div className="grid grid-cols-3 gap-2">
                                {CATEGORIES.map(cat => (
                                    <button key={cat.id} onClick={() => setFormCategory(cat.id)} className={`py-2 rounded-full text-xs font-bold transition-all text-center ${form.category === cat.id ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-500 border border-white/5'}`}>
                                        {cat.icon} {cat.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Trigger type */}
                        <div className="mb-4">
                            <label className="text-[11px] text-gray-500 font-bold uppercase tracking-widest block mb-2">Trigger Type</label>
                            <div className="grid grid-cols-3 gap-2">
                                {(Object.keys(TRIGGER_LABELS) as MaintenanceTriggerType[]).map(t => (
                                    <button key={t} onClick={() => setTrigger(t)} className={`py-2 rounded-full text-xs font-bold transition-all text-center ${form.trigger === t ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-500 border border-white/5'}`}>
                                        {TRIGGER_LABELS[t]}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Engine hours interval */}
                        {form.trigger === 'engine_hours' && (
                            <>
                                <div className="mb-4">
                                    <FormField label="Interval (Hours)" value={form.interval} onChange={v => setField('interval', v)} placeholder="200" inputMode="numeric" />
                                </div>
                                <div className="mb-6">
                                    <FormField label="Next Due at (Hours)" value={form.dueHours} onChange={v => setField('dueHours', v)} placeholder={String(engineHours + 200)} inputMode="numeric" />
                                </div>
                            </>
                        )}

                        {/* Due date — for non-engine triggers */}
                        {form.trigger !== 'engine_hours' && (
                            <div className="mb-6">
                                <FormField label="Next Due Date" type="date" value={form.dueDate} onChange={v => setField('dueDate', v)} />
                            </div>
                        )}

                        <button
                            onClick={handleEditTask}
                            disabled={!form.title.trim()}
                            className="w-full py-3.5 bg-gradient-to-r from-sky-600 to-sky-600 rounded-xl text-sm font-black text-white uppercase tracking-widest shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500 transition-all active:scale-[0.97] disabled:opacity-30"
                        >
                            Save Changes
                        </button>
                    </ModalSheet>
                )}

                {/* ═══════════════════════════════════════════ */}
                {/* HISTORY OVERLAY */}
                {/* ═══════════════════════════════════════════ */}
                {showHistory && (
                    <ModalSheet isOpen={true} onClose={() => setShowHistory(false)} title="Service History" zIndex="z-[1000]">

                        {historyItems.length === 0 ? (
                            <EmptyState
                                icon={<svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
                                title="No Service History"
                                subtitle="Service records will appear here after you log your first maintenance task."
                                className="py-8"
                            />
                        ) : (
                            <div className="space-y-3">
                                {historyItems.map(h => (
                                    <div key={h.id} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                                        <div className="flex items-center justify-between mb-1">
                                            <p className="text-sm font-bold text-white">
                                                {new Date(h.completed_at).toLocaleDateString()}
                                            </p>
                                            {h.engine_hours_at_service !== null && (
                                                <span className="text-[11px] text-sky-400 font-bold">
                                                    @ {h.engine_hours_at_service?.toLocaleString()} hrs
                                                </span>
                                            )}
                                        </div>
                                        {h.notes && <p className="text-xs text-gray-400 mt-1">{h.notes}</p>}
                                        {h.cost !== null && h.cost > 0 && (
                                            <p className="text-xs text-amber-400 font-bold mt-1">${h.cost.toFixed(2)}</p>
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
                {
                    showExportModal && (
                        <ModalSheet isOpen={true} onClose={() => setShowExportModal(false)} title="Export PDF" maxWidth="max-w-sm">
                            <p className="text-xs text-gray-500 mb-5">Choose a report format:</p>

                            {/* Option A: Blank Checklist */}
                            <button
                                onClick={() => handleExport('checklist')}
                                disabled={exporting}
                                className="w-full mb-3 p-4 bg-gradient-to-r from-sky-500/15 to-sky-500/15 border border-sky-500/20 rounded-2xl text-left hover:from-sky-500/25 hover:to-sky-500/25 transition-all active:scale-[0.98] disabled:opacity-50"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="p-2.5 bg-sky-500/20 rounded-xl">
                                        <svg className="w-5 h-5 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
                                        </svg>
                                    </div>
                                    <div>
                                        <p className="text-sm font-black text-white">Print Blank Checklist</p>
                                        <p className="text-[11px] text-gray-500 mt-0.5">Printable clipboard for the engine room</p>
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
                                        <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                                        </svg>
                                    </div>
                                    <div>
                                        <p className="text-sm font-black text-white">Export Service History</p>
                                        <p className="text-[11px] text-gray-500 mt-0.5">Formal ledger of all completed work</p>
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
                    )
                }
            </div>

            <ConfirmDialog
                isOpen={!!deleteTargetId}
                title="Delete Task?"
                message="This will permanently remove this maintenance task and its service history."
                confirmLabel="Delete"
                destructive
                onConfirm={confirmDeleteTask}
                onCancel={() => setDeleteTargetId(null)}
            />
        </div >
    );
};

