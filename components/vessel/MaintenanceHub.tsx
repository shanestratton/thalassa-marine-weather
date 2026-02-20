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
    sortByUrgency,
    type TaskWithStatus,
    type TrafficLight,
} from '../../services/MaintenanceService';
import type { MaintenanceTask, MaintenanceCategory, MaintenanceTriggerType, MaintenanceHistory } from '../../types';
import { triggerHaptic } from '../../utils/system';
import { exportChecklist, exportServiceHistory } from '../../services/MaintenancePdfService';
import { SlideToAction } from '../ui/SlideToAction';

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
    const [swipeOffset, setSwipeOffset] = useState(0);
    const [isSwiping, setIsSwiping] = useState(false);
    const startX = useRef(0);
    const deleteThreshold = 80;
    const light = lightColors[task.status];
    const catConfig = categories.find(c => c.id === task.category);

    const handleTouchStart = (e: React.TouchEvent) => {
        startX.current = e.touches[0].clientX;
        setIsSwiping(true);
    };
    const handleTouchMove = (e: React.TouchEvent) => {
        if (!isSwiping) return;
        const diff = startX.current - e.touches[0].clientX;
        setSwipeOffset(Math.max(0, Math.min(diff, deleteThreshold + 20)));
    };
    const handleTouchEnd = () => {
        setIsSwiping(false);
        setSwipeOffset(swipeOffset >= deleteThreshold ? deleteThreshold : 0);
    };

    return (
        <div className="relative overflow-hidden rounded-lg">
            {/* Delete button (revealed on swipe) */}
            <div
                className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center rounded-r-lg transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={() => { setSwipeOffset(0); onDelete(); }}
            >
                <div className="text-center text-white">
                    <svg className="w-5 h-5 mx-auto mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    <span className="text-[10px] font-bold">Delete</span>
                </div>
            </div>

            {/* Main card (slides on swipe) */}
            <div
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} bg-slate-800/40 rounded-lg p-3 border border-white/5 border-l-2 ${task.status === 'red' ? 'border-l-red-500'
                    : task.status === 'yellow' ? 'border-l-amber-400'
                        : task.status === 'green' ? 'border-l-emerald-500'
                            : 'border-l-gray-600'
                    }`}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
            >
                {/* Row 1: Category icon + Title + 3-dot menu */}
                <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                        <span className="text-xs shrink-0">{catConfig?.icon || '📋'}</span>
                        <h4 className="text-sm font-bold text-white truncate">{task.title}</h4>
                    </div>
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
                    <p className={`text-[10px] font-bold uppercase tracking-widest ${light.text}`}>
                        {task.statusLabel}
                    </p>
                    <div className="flex items-center gap-2">
                        {task.trigger_type === 'engine_hours' && task.next_due_hours !== null && (
                            <span className="text-[10px] text-slate-400 font-mono">
                                @ {task.next_due_hours?.toLocaleString()} hrs
                            </span>
                        )}
                        {task.next_due_date && (
                            <span className="text-[10px] text-slate-400 font-mono">
                                {new Date(task.next_due_date).toLocaleDateString()}
                            </span>
                        )}
                    </div>
                </div>

                {/* Row 3: Last serviced */}
                {task.last_completed && (
                    <p className="text-[9px] text-slate-600 mt-1">
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
    const [selectedCategory, setSelectedCategory] = useState<MaintenanceCategory | 'all'>('all');

    // Log Service sheet
    const [sheetTask, setSheetTask] = useState<TaskWithStatus | null>(null);
    const [sheetNotes, setSheetNotes] = useState('');
    const [sheetCost, setSheetCost] = useState('');
    const [sheetSaving, setSheetSaving] = useState(false);

    // Add task form
    const [showAddForm, setShowAddForm] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newCategory, setNewCategory] = useState<MaintenanceCategory>('Engine');
    const [newTrigger, setNewTrigger] = useState<MaintenanceTriggerType>('monthly');
    const [newInterval, setNewInterval] = useState('200');
    const [newDueDate, setNewDueDate] = useState('');
    const [newDueHours, setNewDueHours] = useState('');
    const [newDescription, setNewDescription] = useState('');

    // History
    const [historyItems, setHistoryItems] = useState<MaintenanceHistory[]>([]);
    const [showHistory, setShowHistory] = useState(false);

    // Edit task
    const [showEditForm, setShowEditForm] = useState(false);
    const [editTask, setEditTask] = useState<TaskWithStatus | null>(null);

    // Export
    const [showExportModal, setShowExportModal] = useState(false);
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

    // ── Computed: Tasks with status, sorted ──
    const tasksWithStatus = useMemo(() => {
        const withStatus = tasks.map(t => calculateStatus(t, engineHours));
        const filtered = selectedCategory === 'all'
            ? withStatus
            : withStatus.filter(t => t.category === selectedCategory);
        return sortByUrgency(filtered);
    }, [tasks, engineHours, selectedCategory]);

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
                sheetCost ? parseFloat(sheetCost) : null,
            );
            setSheetTask(null);
            setSheetNotes('');
            setSheetCost('');
            await loadTasks(); // Refresh list
        } catch (e) {
            console.error('Failed to log service:', e);
        } finally {
            setSheetSaving(false);
        }
    }, [sheetTask, engineHours, sheetNotes, sheetCost, loadTasks]);

    // ── Add Task ──
    const handleAddTask = useCallback(async () => {
        if (!newTitle.trim()) return;
        try {
            triggerHaptic('medium');

            // Auto-compute interval and due date for period-based triggers
            const periodDays = PERIOD_DAYS[newTrigger];
            const intervalValue = newTrigger === 'engine_hours'
                ? (newInterval ? parseInt(newInterval, 10) : null)
                : (periodDays ?? null);
            const dueDate = newTrigger === 'engine_hours'
                ? null
                : (newDueDate || new Date(Date.now() + (periodDays || 30) * 86400000).toISOString().split('T')[0]);

            await MaintenanceService.createTask({
                title: newTitle.trim(),
                description: newDescription.trim() || null,
                category: newCategory,
                trigger_type: newTrigger,
                interval_value: intervalValue,
                next_due_date: dueDate,
                next_due_hours: newTrigger === 'engine_hours' && newDueHours ? parseInt(newDueHours, 10) : null,
                last_completed: null,
                is_active: true,
            });
            setShowAddForm(false);
            setNewTitle('');
            setNewDescription('');
            setNewInterval('200');
            setNewDueDate('');
            setNewDueHours('');
            await loadTasks();
        } catch (e) {
            console.error('Failed to create task:', e);
        }
    }, [newTitle, newDescription, newCategory, newTrigger, newInterval, newDueDate, newDueHours, loadTasks]);

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
        } finally {
            setExporting(false);
        }
    }, [engineHours]);

    // ── Delete Task ──
    const handleDeleteTask = useCallback(async (taskId: string) => {
        if (!confirm('Delete this maintenance task? This cannot be undone.')) return;
        try {
            triggerHaptic('medium');
            await MaintenanceService.deleteTask(taskId);
            await loadTasks();
        } catch (e) {
            console.error('Failed to delete task:', e);
        }
    }, [loadTasks]);

    // ── Edit Task ──
    const openEditForm = useCallback((task: TaskWithStatus) => {
        setEditTask(task);
        setNewTitle(task.title);
        setNewCategory(task.category);
        setNewTrigger(task.trigger_type);
        setNewInterval(String(task.interval_value || '200'));
        setNewDueDate(task.next_due_date ? task.next_due_date.split('T')[0] : '');
        setNewDueHours(task.next_due_hours !== null ? String(task.next_due_hours) : '');
        setNewDescription(task.description || '');
        setShowEditForm(true);
    }, []);

    const handleEditTask = useCallback(async () => {
        if (!editTask || !newTitle.trim()) return;
        try {
            triggerHaptic('medium');
            const periodDays = PERIOD_DAYS[newTrigger];
            const intervalValue = newTrigger === 'engine_hours'
                ? (newInterval ? parseInt(newInterval, 10) : null)
                : (periodDays ?? null);
            const dueDate = newTrigger === 'engine_hours'
                ? null
                : (newDueDate || null);

            await MaintenanceService.updateTask(editTask.id, {
                title: newTitle.trim(),
                description: newDescription.trim() || null,
                category: newCategory,
                trigger_type: newTrigger,
                interval_value: intervalValue,
                next_due_date: dueDate,
                next_due_hours: newTrigger === 'engine_hours' && newDueHours ? parseInt(newDueHours, 10) : null,
            });
            setShowEditForm(false);
            setEditTask(null);
            setSheetTask(null);
            await loadTasks();
        } catch (e) {
            console.error('Failed to update task:', e);
        }
    }, [editTask, newTitle, newDescription, newCategory, newTrigger, newInterval, newDueDate, newDueHours, loadTasks]);

    // ── Render ──
    return (
        <div className="w-full max-w-2xl mx-auto px-4 pt-4 animate-in fade-in duration-300 h-full flex flex-col overflow-hidden" style={{ paddingBottom: 'calc(5rem + env(safe-area-inset-bottom, 0px))' }}>

            {/* ═══ HEADER ═══ */}
            <div className="flex items-center gap-3 mb-5 shrink-0">
                <button
                    onClick={onBack}
                    className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
                >
                    <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                    </svg>
                </button>
                <div className="flex-1">
                    <h1 className="text-lg font-black text-white tracking-wide">Maintenance</h1>
                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Tasks & Expiry</p>
                </div>

                {/* Status summary pills */}
                <div className="flex items-center gap-1.5">
                    {counts.red > 0 && (
                        <span className="px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 text-[10px] font-black">{counts.red}</span>
                    )}
                    {counts.yellow > 0 && (
                        <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-[10px] font-black">{counts.yellow}</span>
                    )}
                    <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] font-black">{counts.green}</span>
                </div>

                {/* Export PDF Button */}
                <button
                    onClick={() => {
                        triggerHaptic('light');
                        setShowExportModal(true);
                    }}
                    className="p-2.5 rounded-xl bg-white/5 hover:bg-white/10 transition-colors border border-white/5"
                    title="Export PDF"
                >
                    <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                    </svg>
                </button>
            </div>

            {/* ═══ ENGINE HOURS CARD ═══ */}
            <div className="mb-5 shrink-0">
                <button
                    onClick={() => {
                        setIsEditingHours(true);
                        setTimeout(() => hoursInputRef.current?.focus(), 100);
                    }}
                    className="w-full bg-gradient-to-br from-sky-500/15 to-cyan-500/15 border border-sky-500/20 rounded-2xl p-5 text-left group hover:from-sky-500/20 hover:to-cyan-500/20 transition-all active:scale-[0.98]"
                >
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <div className="p-3 rounded-xl bg-sky-500/20">
                                <svg className="w-6 h-6 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                            </div>
                            <div>
                                <p className="text-[10px] text-sky-400/70 font-bold uppercase tracking-widest">Current Engine Hours</p>
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

            {/* ═══ CATEGORY FILTER CHIPS ═══ */}
            <div className="grid grid-cols-3 gap-2 pb-3 mb-4 shrink-0">
                <button
                    onClick={() => setSelectedCategory('all')}
                    className={`px-3 py-2 rounded-full text-xs font-black uppercase tracking-widest transition-all text-center ${selectedCategory === 'all'
                        ? 'bg-white/15 text-white border border-white/20'
                        : 'bg-white/5 text-gray-500 border border-white/5'
                        }`}
                >
                    All ({tasks.length})
                </button>
                {CATEGORIES.map(cat => {
                    const count = tasks.filter(t => t.category === cat.id).length;
                    return (
                        <button
                            key={cat.id}
                            onClick={() => setSelectedCategory(cat.id)}
                            className={`px-3 py-2 rounded-full text-xs font-black uppercase tracking-widest transition-all text-center ${selectedCategory === cat.id
                                ? 'bg-white/15 text-white border border-white/20'
                                : 'bg-white/5 text-gray-500 border border-white/5'
                                }`}
                        >
                            {cat.icon} {cat.label} ({count})
                        </button>
                    );
                })}
            </div>

            {/* ═══ TRAFFIC LIGHT LIST (scrollable) ═══ */}
            <div className="flex-1 overflow-y-auto space-y-2 pb-4 min-h-0 -webkit-overflow-scrolling-touch">
                {loading ? (
                    <div className="flex items-center justify-center py-12">
                        <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                ) : tasksWithStatus.length === 0 ? (
                    <div className="text-center py-12">
                        <p className="text-gray-500 text-sm font-bold">No maintenance tasks yet</p>
                        <p className="text-gray-600 text-xs mt-1">Tap + to add your first task</p>
                    </div>
                ) : (
                    tasksWithStatus.map(task => (
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
                    ))
                )}
            </div>

            {/* ═══ ADD TASK BUTTON (fixed at bottom) ═══ */}
            <div className="shrink-0 pt-3 pb-[env(safe-area-inset-bottom,0px)]">
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
                        className="relative w-full max-w-2xl bg-slate-900 border border-white/10 rounded-3xl p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,24px))] animate-in fade-in zoom-in-95 duration-300 max-h-[85vh] overflow-y-auto"
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
                            <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-4 mb-4">
                                <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-1">Engine Hours at Service</p>
                                <p className="text-xl font-black text-white">{engineHours.toLocaleString()} hrs</p>
                            </div>
                        )}

                        {/* Notes */}
                        <div className="mb-4">
                            <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">
                                Notes (Optional)
                            </label>
                            <textarea
                                value={sheetNotes}
                                onChange={e => setSheetNotes(e.target.value)}
                                placeholder="Found slight weeping on raw water pump gasket..."
                                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl p-3 text-sm text-white placeholder-gray-600 resize-none h-20 outline-none focus:border-sky-500/30"
                            />
                        </div>

                        {/* Cost */}
                        <div className="mb-6">
                            <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">
                                Cost (Optional)
                            </label>
                            <div className="flex items-center gap-2">
                                <span className="text-gray-500 font-bold">$</span>
                                <input
                                    type="text"
                                    inputMode="decimal"
                                    value={sheetCost}
                                    onChange={e => setSheetCost(e.target.value)}
                                    placeholder="0.00"
                                    className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30"
                                />
                            </div>
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
                                className="flex-1 py-3.5 bg-gradient-to-r from-emerald-600 to-teal-600 rounded-xl text-sm font-black text-white uppercase tracking-widest shadow-lg shadow-emerald-500/20 hover:from-emerald-500 hover:to-teal-500 transition-all active:scale-[0.97] disabled:opacity-50"
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
                <div className="fixed inset-0 z-[999] flex items-center justify-center p-4" onClick={() => setShowAddForm(false)}>
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

                    <div
                        className="relative w-full max-w-2xl bg-slate-900 border border-white/10 rounded-3xl p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,24px))] animate-in fade-in zoom-in-95 duration-300 max-h-[85vh] overflow-y-auto"
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Close X */}
                        <button
                            onClick={() => setShowAddForm(false)}
                            className="absolute top-4 right-4 p-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10"
                        >
                            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                        <h3 className="text-lg font-black text-white mb-5">New Maintenance Task</h3>

                        {/* Title */}
                        <div className="mb-4">
                            <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Task Name</label>
                            <input
                                type="text"
                                value={newTitle}
                                onChange={e => setNewTitle(e.target.value)}
                                placeholder="Main Engine Oil Change"
                                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30"
                            />
                        </div>

                        {/* Notes */}
                        <div className="mb-4">
                            <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Notes (Optional)</label>
                            <textarea
                                value={newDescription}
                                onChange={e => setNewDescription(e.target.value)}
                                placeholder="Don't forget to check the bottom for rust..."
                                rows={2}
                                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30 resize-none"
                            />
                        </div>

                        {/* Category chips */}
                        <div className="mb-4">
                            <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-2">Category</label>
                            <div className="grid grid-cols-3 gap-2">
                                {CATEGORIES.map(cat => (
                                    <button
                                        key={cat.id}
                                        onClick={() => setNewCategory(cat.id)}
                                        className={`py-2 rounded-full text-xs font-bold transition-all text-center ${newCategory === cat.id
                                            ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                                            : 'bg-white/5 text-gray-500 border border-white/5'
                                            }`}
                                    >
                                        {cat.icon} {cat.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Trigger type */}
                        <div className="mb-4">
                            <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-2">Trigger Type</label>
                            <div className="grid grid-cols-3 gap-2">
                                {(Object.keys(TRIGGER_LABELS) as MaintenanceTriggerType[]).map(t => (
                                    <button
                                        key={t}
                                        onClick={() => setNewTrigger(t)}
                                        className={`py-2 rounded-full text-xs font-bold transition-all text-center ${newTrigger === t
                                            ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                                            : 'bg-white/5 text-gray-500 border border-white/5'
                                            }`}
                                    >
                                        {TRIGGER_LABELS[t]}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Interval — only for engine hours */}
                        {newTrigger === 'engine_hours' && (
                            <>
                                <div className="mb-4">
                                    <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">
                                        Interval (Hours)
                                    </label>
                                    <input
                                        type="text"
                                        inputMode="numeric"
                                        value={newInterval}
                                        onChange={e => setNewInterval(e.target.value)}
                                        placeholder="200"
                                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30"
                                    />
                                </div>

                                <div className="mb-6">
                                    <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Next Due at (Hours)</label>
                                    <input
                                        type="text"
                                        inputMode="numeric"
                                        value={newDueHours}
                                        onChange={e => setNewDueHours(e.target.value)}
                                        placeholder={String(engineHours + 200)}
                                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30"
                                    />
                                </div>
                            </>
                        )}

                        {/* Next due — for time-based triggers */}
                        {newTrigger !== 'engine_hours' && (
                            <div className="mb-6">
                                <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Starts From</label>
                                <input
                                    type="date"
                                    value={newDueDate}
                                    onChange={e => setNewDueDate(e.target.value)}
                                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-sky-500/30 [color-scheme:dark]"
                                />
                                <p className="text-[10px] text-gray-600 mt-1">
                                    Repeats every {TRIGGER_LABELS[newTrigger].replace('📅 ', '').toLowerCase()}
                                </p>
                            </div>
                        )}

                        {/* Save */}
                        <button
                            onClick={handleAddTask}
                            disabled={!newTitle.trim()}
                            className="w-full py-3.5 bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl text-sm font-black text-white uppercase tracking-widest shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-cyan-500 transition-all active:scale-[0.97] disabled:opacity-30"
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
                <div className="fixed inset-0 z-[999] flex items-center justify-center p-4" onClick={() => { setShowEditForm(false); setEditTask(null); }}>
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
                    <div
                        className="relative w-full max-w-2xl bg-slate-900 border border-white/10 rounded-3xl p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,24px))] animate-in fade-in zoom-in-95 duration-300 max-h-[85vh] overflow-y-auto"
                        onClick={e => e.stopPropagation()}
                    >
                        <button onClick={() => { setShowEditForm(false); setEditTask(null); }} className="absolute top-4 right-4 p-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10">
                            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>

                        <h3 className="text-lg font-black text-white mb-5">Edit Task</h3>

                        {/* Task Name */}
                        <div className="mb-3">
                            <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Task Name</label>
                            <input type="text" value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Main Engine Oil Change" className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30" />
                        </div>

                        {/* Notes */}
                        <div className="mb-4">
                            <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Notes (Optional)</label>
                            <textarea value={newDescription} onChange={e => setNewDescription(e.target.value)} placeholder="Don't forget to check for rust..." rows={2} className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30 resize-none" />
                        </div>

                        {/* Category */}
                        <div className="mb-4">
                            <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-2">Category</label>
                            <div className="grid grid-cols-3 gap-2">
                                {CATEGORIES.map(cat => (
                                    <button key={cat.id} onClick={() => setNewCategory(cat.id)} className={`py-2 rounded-full text-xs font-bold transition-all text-center ${newCategory === cat.id ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-500 border border-white/5'}`}>
                                        {cat.icon} {cat.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Trigger type */}
                        <div className="mb-4">
                            <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-2">Trigger Type</label>
                            <div className="grid grid-cols-3 gap-2">
                                {(Object.keys(TRIGGER_LABELS) as MaintenanceTriggerType[]).map(t => (
                                    <button key={t} onClick={() => setNewTrigger(t)} className={`py-2 rounded-full text-xs font-bold transition-all text-center ${newTrigger === t ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-500 border border-white/5'}`}>
                                        {TRIGGER_LABELS[t]}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Engine hours interval */}
                        {newTrigger === 'engine_hours' && (
                            <>
                                <div className="mb-4">
                                    <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Interval (Hours)</label>
                                    <input type="text" inputMode="numeric" value={newInterval} onChange={e => setNewInterval(e.target.value)} placeholder="200" className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30" />
                                </div>
                                <div className="mb-6">
                                    <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Next Due at (Hours)</label>
                                    <input type="text" inputMode="numeric" value={newDueHours} onChange={e => setNewDueHours(e.target.value)} placeholder={String(engineHours + 200)} className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30" />
                                </div>
                            </>
                        )}

                        {/* Due date — for non-engine triggers */}
                        {newTrigger !== 'engine_hours' && (
                            <div className="mb-6">
                                <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Next Due Date</label>
                                <input type="date" value={newDueDate} onChange={e => setNewDueDate(e.target.value)} className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30" />
                            </div>
                        )}

                        <button
                            onClick={handleEditTask}
                            disabled={!newTitle.trim()}
                            className="w-full py-3.5 bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl text-sm font-black text-white uppercase tracking-widest shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-cyan-500 transition-all active:scale-[0.97] disabled:opacity-30"
                        >
                            Save Changes
                        </button>
                    </div>
                </div>
            )}

            {/* ═══════════════════════════════════════════ */}
            {/* HISTORY OVERLAY */}
            {/* ═══════════════════════════════════════════ */}
            {showHistory && (
                <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4" onClick={() => setShowHistory(false)}>
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
                    <div
                        className="relative w-full max-w-2xl bg-slate-900 border border-white/10 rounded-3xl p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,24px))] animate-in fade-in zoom-in-95 duration-300 max-h-[85vh] overflow-y-auto"
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Close X */}
                        <button
                            onClick={() => setShowHistory(false)}
                            className="absolute top-4 right-4 p-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10"
                        >
                            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                        <h3 className="text-lg font-black text-white mb-4">Service History</h3>

                        {historyItems.length === 0 ? (
                            <p className="text-gray-500 text-sm text-center py-8">No service history recorded</p>
                        ) : (
                            <div className="space-y-3">
                                {historyItems.map(h => (
                                    <div key={h.id} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                                        <div className="flex items-center justify-between mb-1">
                                            <p className="text-sm font-bold text-white">
                                                {new Date(h.completed_at).toLocaleDateString()}
                                            </p>
                                            {h.engine_hours_at_service !== null && (
                                                <span className="text-[10px] text-sky-400 font-bold">
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
                    </div>
                </div>
            )}

            {/* ═══════════════════════════════════════════ */}
            {/* EXPORT PDF MODAL */}
            {/* ═══════════════════════════════════════════ */}
            {showExportModal && (
                <div className="fixed inset-0 z-[999] flex items-center justify-center" onClick={() => setShowExportModal(false)}>
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

                    <div
                        className="relative w-full max-w-sm mx-4 bg-slate-900 border border-white/10 rounded-3xl p-6 animate-in fade-in zoom-in-95 duration-200"
                        onClick={e => e.stopPropagation()}
                    >
                        <h3 className="text-lg font-black text-white mb-1">Export PDF</h3>
                        <p className="text-xs text-gray-500 mb-5">Choose a report format:</p>

                        {/* Option A: Blank Checklist */}
                        <button
                            onClick={() => handleExport('checklist')}
                            disabled={exporting}
                            className="w-full mb-3 p-4 bg-gradient-to-r from-sky-500/15 to-cyan-500/15 border border-sky-500/20 rounded-2xl text-left hover:from-sky-500/25 hover:to-cyan-500/25 transition-all active:scale-[0.98] disabled:opacity-50"
                        >
                            <div className="flex items-center gap-3">
                                <div className="p-2.5 bg-sky-500/20 rounded-xl">
                                    <svg className="w-5 h-5 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
                                    </svg>
                                </div>
                                <div>
                                    <p className="text-sm font-black text-white">Print Blank Checklist</p>
                                    <p className="text-[10px] text-gray-500 mt-0.5">Printable clipboard for the engine room</p>
                                </div>
                            </div>
                        </button>

                        {/* Option B: Service History */}
                        <button
                            onClick={() => handleExport('history')}
                            disabled={exporting}
                            className="w-full p-4 bg-gradient-to-r from-amber-500/15 to-orange-500/15 border border-amber-500/20 rounded-2xl text-left hover:from-amber-500/25 hover:to-orange-500/25 transition-all active:scale-[0.98] disabled:opacity-50"
                        >
                            <div className="flex items-center gap-3">
                                <div className="p-2.5 bg-amber-500/20 rounded-xl">
                                    <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                                    </svg>
                                </div>
                                <div>
                                    <p className="text-sm font-black text-white">Export Service History</p>
                                    <p className="text-[10px] text-gray-500 mt-0.5">Formal ledger of all completed work</p>
                                </div>
                            </div>
                        </button>

                        {exporting && (
                            <div className="flex items-center justify-center gap-2 mt-4">
                                <div className="w-4 h-4 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                                <span className="text-xs text-sky-400 font-bold">Generating PDF...</span>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
