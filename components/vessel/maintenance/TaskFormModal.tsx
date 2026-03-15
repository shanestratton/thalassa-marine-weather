/**
 * TaskFormModal — Add/Edit task form for MaintenanceHub.
 * Extracted from MaintenanceHub to reduce component size.
 */
import React from 'react';
import type { MaintenanceTriggerType } from '../../../types';
import { FormField } from '../../ui/FormField';
import { ModalSheet } from '../../ui/ModalSheet';
import { CATEGORIES, TRIGGER_LABELS } from './constants';
import type { UseMaintenanceFormReturn } from '../../../hooks/useMaintenanceForm';

interface TaskFormModalProps {
    mode: 'add' | 'edit';
    form: UseMaintenanceFormReturn['form'];
    setField: UseMaintenanceFormReturn['setField'];
    setCategory: UseMaintenanceFormReturn['setCategory'];
    setTaskType: UseMaintenanceFormReturn['setTaskType'];
    setTrigger: UseMaintenanceFormReturn['setTrigger'];
    engineHours: number;
    onSubmit: () => void;
    onClose: () => void;
}

export const TaskFormModal: React.FC<TaskFormModalProps> = ({
    mode,
    form,
    setField,
    setCategory,
    setTaskType,
    setTrigger,
    engineHours,
    onSubmit,
    onClose,
}) => {
    const isAdd = mode === 'add';

    if (isAdd) {
        return (
            <ModalSheet isOpen={true} onClose={onClose} title="New Task">
                <div className="flex flex-col gap-2">
                    {/* Task Type Selector */}
                    <div>
                        <label className="text-micro text-gray-500 font-bold uppercase tracking-wider block mb-1">
                            Type
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                            <button
                                onClick={() => {
                                    setTaskType('maintenance');
                                    setCategory('Engine');
                                }}
                                className={`py-2 rounded-xl text-xs font-black transition-all text-center ${
                                    form.taskType === 'maintenance'
                                        ? 'bg-sky-500/20 text-sky-400 border-2 border-sky-500/40'
                                        : 'bg-white/5 text-gray-500 border-2 border-white/5'
                                }`}
                            >
                                🔄 Maintenance
                            </button>
                            <button
                                onClick={() => {
                                    setTaskType('repair');
                                    setCategory('Repair');
                                }}
                                className={`py-2 rounded-xl text-xs font-black transition-all text-center ${
                                    form.taskType === 'repair'
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
                            <label className="text-micro text-gray-500 font-bold uppercase tracking-wider block mb-1">
                                Category
                            </label>
                            <div className="grid grid-cols-3 gap-1.5">
                                {CATEGORIES.filter((cat) => cat.id !== 'Repair').map((cat) => (
                                    <button
                                        key={cat.id}
                                        onClick={() => setCategory(cat.id)}
                                        className={`py-1 rounded-full text-label font-bold transition-all text-center ${
                                            form.category === cat.id
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
                        onChange={(v) => setField('title', v)}
                        placeholder="Main Engine Oil Change"
                        required
                        error={!form.title.trim() && form.title !== '' ? 'Task name is required' : undefined}
                    />

                    {/* Notes */}
                    <FormField
                        label="Notes (Optional)"
                        type="textarea"
                        value={form.description}
                        onChange={(v) => setField('description', v)}
                        placeholder="Don't forget to check the bottom for rust..."
                        rows={1}
                    />

                    {/* Trigger type — hidden for Repair */}
                    {form.category !== 'Repair' && (
                        <div>
                            <label className="text-micro text-gray-500 font-bold uppercase tracking-wider block mb-1">
                                Schedule
                            </label>
                            <div className="grid grid-cols-3 gap-1.5">
                                {(Object.keys(TRIGGER_LABELS) as MaintenanceTriggerType[]).map((t) => (
                                    <button
                                        key={t}
                                        onClick={() => setTrigger(t)}
                                        className={`py-1 rounded-full text-label font-bold transition-all text-center ${
                                            form.trigger === t
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
                                onChange={(v) => setField('interval', v)}
                                placeholder="200"
                                inputMode="numeric"
                            />
                            <FormField
                                label="Next Due (Hrs)"
                                value={form.dueHours}
                                onChange={(v) => setField('dueHours', v)}
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
                            onChange={(v) => setField('dueDate', v)}
                            hint={`Repeats every ${TRIGGER_LABELS[form.trigger].replace('📅 ', '').toLowerCase()}`}
                        />
                    )}
                </div>

                {/* Save */}
                {!form.title.trim() && (
                    <p className="text-micro text-amber-400/80 text-center mt-2">Enter a task name to continue</p>
                )}
                <button
                    onClick={onSubmit}
                    disabled={!form.title.trim()}
                    className="w-full py-3 mt-2 bg-gradient-to-r from-sky-600 to-sky-600 rounded-xl text-sm font-black text-white uppercase tracking-[0.15em] shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500 transition-all active:scale-[0.97] disabled:opacity-30 shrink-0"
                >
                    Create Task
                </button>
            </ModalSheet>
        );
    }

    // ── Edit Mode (uses ModalSheet) ──
    return (
        <ModalSheet isOpen={true} onClose={onClose} title="Edit Task">
            {/* Task Name */}
            <div className="mb-3">
                <FormField
                    label="Task Name"
                    value={form.title}
                    onChange={(v) => setField('title', v)}
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
                    onChange={(v) => setField('description', v)}
                    placeholder="Don't forget to check for rust..."
                    rows={2}
                />
            </div>

            {/* Category */}
            <div className="mb-4">
                <label className="text-label text-gray-500 font-bold uppercase tracking-widest block mb-2">
                    Category
                </label>
                <div className="grid grid-cols-3 gap-2">
                    {CATEGORIES.map((cat) => (
                        <button
                            key={cat.id}
                            onClick={() => setCategory(cat.id)}
                            className={`py-2 rounded-full text-xs font-bold transition-all text-center ${form.category === cat.id ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-500 border border-white/5'}`}
                        >
                            {cat.icon} {cat.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Trigger type */}
            <div className="mb-4">
                <label className="text-label text-gray-500 font-bold uppercase tracking-widest block mb-2">
                    Trigger Type
                </label>
                <div className="grid grid-cols-3 gap-2">
                    {(Object.keys(TRIGGER_LABELS) as MaintenanceTriggerType[]).map((t) => (
                        <button
                            key={t}
                            onClick={() => setTrigger(t)}
                            className={`py-2 rounded-full text-xs font-bold transition-all text-center ${form.trigger === t ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-500 border border-white/5'}`}
                        >
                            {TRIGGER_LABELS[t]}
                        </button>
                    ))}
                </div>
            </div>

            {/* Engine hours interval */}
            {form.trigger === 'engine_hours' && (
                <>
                    <div className="mb-4">
                        <FormField
                            label="Interval (Hours)"
                            value={form.interval}
                            onChange={(v) => setField('interval', v)}
                            placeholder="200"
                            inputMode="numeric"
                        />
                    </div>
                    <div className="mb-6">
                        <FormField
                            label="Next Due at (Hours)"
                            value={form.dueHours}
                            onChange={(v) => setField('dueHours', v)}
                            placeholder={String(engineHours + 200)}
                            inputMode="numeric"
                        />
                    </div>
                </>
            )}

            {/* Due date — for non-engine triggers */}
            {form.trigger !== 'engine_hours' && (
                <div className="mb-6">
                    <FormField
                        label="Next Due Date"
                        type="date"
                        value={form.dueDate}
                        onChange={(v) => setField('dueDate', v)}
                    />
                </div>
            )}

            <button
                onClick={onSubmit}
                disabled={!form.title.trim()}
                className="w-full py-3.5 bg-gradient-to-r from-sky-600 to-sky-600 rounded-xl text-sm font-black text-white uppercase tracking-widest shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500 transition-all active:scale-[0.97] disabled:opacity-30"
            >
                Save Changes
            </button>
        </ModalSheet>
    );
};
