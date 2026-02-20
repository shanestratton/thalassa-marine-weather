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
    date: 'Calendar Date',
    engine_hours: 'Engine Hours',
    recurring_days: 'Recurring Days',
};

// Traffic light colors
const LIGHT_COLORS: Record<TrafficLight, { dot: string; bg: string; border: string; text: string }> = {
    red: { dot: 'bg-red-500', bg: 'bg-red-500/10', border: 'border-red-500/30', text: 'text-red-400' },
    yellow: { dot: 'bg-amber-500', bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-400' },
    green: { dot: 'bg-emerald-500', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400' },
    grey: { dot: 'bg-gray-500', bg: 'bg-gray-500/10', border: 'border-gray-500/20', text: 'text-gray-500' },
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
    const [newTrigger, setNewTrigger] = useState<MaintenanceTriggerType>('engine_hours');
    const [newInterval, setNewInterval] = useState('200');
    const [newDueDate, setNewDueDate] = useState('');
    const [newDueHours, setNewDueHours] = useState('');

    // History
    const [historyItems, setHistoryItems] = useState<MaintenanceHistory[]>([]);
    const [showHistory, setShowHistory] = useState(false);

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
            await MaintenanceService.createTask({
                title: newTitle.trim(),
                description: null,
                category: newCategory,
                trigger_type: newTrigger,
                interval_value: newInterval ? parseInt(newInterval, 10) : null,
                next_due_date: newDueDate || null,
                next_due_hours: newDueHours ? parseInt(newDueHours, 10) : null,
                last_completed: null,
                is_active: true,
            });
            setShowAddForm(false);
            setNewTitle('');
            setNewInterval('200');
            setNewDueDate('');
            setNewDueHours('');
            await loadTasks();
        } catch (e) {
            console.error('Failed to create task:', e);
        }
    }, [newTitle, newCategory, newTrigger, newInterval, newDueDate, newDueHours, loadTasks]);

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

    // ── Render ──
    return (
        <div className="w-full max-w-2xl mx-auto px-4 pb-24 pt-4 animate-in fade-in duration-300 overflow-y-auto h-full">

            {/* ═══ HEADER ═══ */}
            <div className="flex items-center gap-3 mb-5">
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
            </div>

            {/* ═══ ENGINE HOURS CARD ═══ */}
            <div className="mb-5">
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
            <div className="flex gap-2 overflow-x-auto pb-3 mb-4 no-scrollbar">
                <button
                    onClick={() => setSelectedCategory('all')}
                    className={`shrink-0 px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest transition-all ${selectedCategory === 'all'
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
                            className={`shrink-0 px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest transition-all ${selectedCategory === cat.id
                                    ? 'bg-white/15 text-white border border-white/20'
                                    : 'bg-white/5 text-gray-500 border border-white/5'
                                }`}
                        >
                            {cat.icon} {cat.label} ({count})
                        </button>
                    );
                })}
            </div>

            {/* ═══ TRAFFIC LIGHT LIST ═══ */}
            <div className="space-y-2 mb-6">
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
                    tasksWithStatus.map(task => {
                        const light = LIGHT_COLORS[task.status];
                        const catConfig = CATEGORIES.find(c => c.id === task.category);

                        return (
                            <button
                                key={task.id}
                                onClick={() => {
                                    triggerHaptic('light');
                                    setSheetTask(task);
                                }}
                                className={`w-full flex items-stretch rounded-2xl border ${light.border} overflow-hidden hover:scale-[1.01] transition-all active:scale-[0.98]`}
                            >
                                {/* Traffic light bar */}
                                <div className={`w-1.5 shrink-0 ${light.dot}`} />

                                {/* Content */}
                                <div className="flex-1 p-4 bg-white/[0.03]">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex-1 text-left">
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="text-xs">{catConfig?.icon || '📋'}</span>
                                                <h4 className="text-sm font-black text-white tracking-wide">{task.title}</h4>
                                            </div>
                                            <p className={`text-[10px] font-bold uppercase tracking-widest ${light.text}`}>
                                                {task.statusLabel}
                                            </p>
                                            {task.last_completed && (
                                                <p className="text-[9px] text-gray-600 mt-1">
                                                    Last: {new Date(task.last_completed).toLocaleDateString()}
                                                </p>
                                            )}
                                        </div>

                                        {/* Trigger badge */}
                                        <div className="shrink-0">
                                            <span className="px-2 py-1 rounded-lg bg-white/5 text-[9px] font-bold text-gray-500 uppercase tracking-wider">
                                                {TRIGGER_LABELS[task.trigger_type]}
                                            </span>
                                            {task.next_due_hours !== null && (
                                                <p className="text-[10px] text-gray-500 text-right mt-1 font-bold">
                                                    @ {task.next_due_hours?.toLocaleString()} hrs
                                                </p>
                                            )}
                                            {task.next_due_date && (
                                                <p className="text-[10px] text-gray-500 text-right mt-1 font-bold">
                                                    {new Date(task.next_due_date).toLocaleDateString()}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </button>
                        );
                    })
                )}
            </div>

            {/* ═══ ADD TASK BUTTON ═══ */}
            <button
                onClick={() => {
                    triggerHaptic('light');
                    setShowAddForm(true);
                }}
                className="w-full py-4 bg-gradient-to-r from-emerald-600/20 to-teal-600/20 border border-emerald-500/20 rounded-2xl flex items-center justify-center gap-3 group hover:from-emerald-600/30 hover:to-teal-600/30 transition-all active:scale-[0.98]"
            >
                <div className="p-2 bg-emerald-500/20 rounded-lg group-hover:bg-emerald-500/30 transition-colors">
                    <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                </div>
                <span className="text-sm font-black text-emerald-400 uppercase tracking-[0.15em]">Add Maintenance Task</span>
            </button>

            {/* ═══════════════════════════════════════════ */}
            {/* LOG SERVICE BOTTOM SHEET */}
            {/* ═══════════════════════════════════════════ */}
            {sheetTask && (
                <div className="fixed inset-0 z-[999] flex items-end justify-center" onClick={() => setSheetTask(null)}>
                    {/* Backdrop */}
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

                    {/* Sheet */}
                    <div
                        className="relative w-full max-w-2xl bg-slate-900 border-t border-white/10 rounded-t-3xl p-6 pb-10 animate-in slide-in-from-bottom duration-300"
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Handle */}
                        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />

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

                        {/* Engine hours snapshot */}
                        <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-4 mb-4">
                            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-1">Engine Hours at Service</p>
                            <p className="text-xl font-black text-white">{engineHours.toLocaleString()} hrs</p>
                        </div>

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
                <div className="fixed inset-0 z-[999] flex items-end justify-center" onClick={() => setShowAddForm(false)}>
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

                    <div
                        className="relative w-full max-w-2xl bg-slate-900 border-t border-white/10 rounded-t-3xl p-6 pb-10 animate-in slide-in-from-bottom duration-300 max-h-[85vh] overflow-y-auto"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />
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

                        {/* Category chips */}
                        <div className="mb-4">
                            <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-2">Category</label>
                            <div className="flex flex-wrap gap-2">
                                {CATEGORIES.map(cat => (
                                    <button
                                        key={cat.id}
                                        onClick={() => setNewCategory(cat.id)}
                                        className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all ${newCategory === cat.id
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
                            <div className="flex flex-wrap gap-2">
                                {(Object.keys(TRIGGER_LABELS) as MaintenanceTriggerType[]).map(t => (
                                    <button
                                        key={t}
                                        onClick={() => setNewTrigger(t)}
                                        className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all ${newTrigger === t
                                                ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                                                : 'bg-white/5 text-gray-500 border border-white/5'
                                            }`}
                                    >
                                        {TRIGGER_LABELS[t]}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Interval */}
                        <div className="mb-4">
                            <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">
                                Interval ({newTrigger === 'engine_hours' ? 'Hours' : 'Days'})
                            </label>
                            <input
                                type="text"
                                inputMode="numeric"
                                value={newInterval}
                                onChange={e => setNewInterval(e.target.value)}
                                placeholder={newTrigger === 'engine_hours' ? '200' : '30'}
                                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30"
                            />
                        </div>

                        {/* Next due */}
                        {newTrigger === 'engine_hours' ? (
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
                        ) : (
                            <div className="mb-6">
                                <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Next Due Date</label>
                                <input
                                    type="date"
                                    value={newDueDate}
                                    onChange={e => setNewDueDate(e.target.value)}
                                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-sky-500/30 [color-scheme:dark]"
                                />
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
            {/* HISTORY OVERLAY */}
            {/* ═══════════════════════════════════════════ */}
            {showHistory && (
                <div className="fixed inset-0 z-[1000] flex items-end justify-center" onClick={() => setShowHistory(false)}>
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
                    <div
                        className="relative w-full max-w-2xl bg-slate-900 border-t border-white/10 rounded-t-3xl p-6 pb-10 animate-in slide-in-from-bottom duration-300 max-h-[70vh] overflow-y-auto"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />
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
        </div>
    );
};
