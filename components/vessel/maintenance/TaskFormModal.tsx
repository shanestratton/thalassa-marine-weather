/**
 * TaskFormModal — Add/Edit task form for MaintenanceHub.
 * Extracted from MaintenanceHub to reduce component size.
 */
import React from 'react';
import type { MaintenanceTriggerType } from '../../../types';
import { FormField } from '../../ui/FormField';
import { ModalSheet } from '../../ui/ModalSheet';
import { Button } from '../../ui/Button';
import { RefreshIcon, WrenchIcon } from '../../icons/UIIcons';
import { CATEGORIES, TRIGGER_LABELS, TRIGGER_PERIODS } from './constants';
import { DEFAULT_HOURS_INTERVAL, wholeNumber } from './taskSchedule';
import type { UseMaintenanceFormReturn } from '../../../hooks/useMaintenanceForm';

/** A pre-trip check's line where a calendar task's day goes (132-B15). */
const PreTripNote: React.FC = () => (
    <p className="text-xs text-gray-400">Due before each trip, not by date, so it never shows as overdue.</p>
);

interface TaskFormModalProps {
    mode: 'add' | 'edit';
    form: UseMaintenanceFormReturn['form'];
    setField: UseMaintenanceFormReturn['setField'];
    setCategory: UseMaintenanceFormReturn['setCategory'];
    setTaskType: UseMaintenanceFormReturn['setTaskType'];
    setTrigger: UseMaintenanceFormReturn['setTrigger'];
    /** null until the skipper has entered engine hours. */
    engineHours: number | null;
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
    // What a blank 'Next due' saves (taskSchedule): the reading plus the
    // interval. With no engine hours entered, it would be counted from an
    // invented 0, so it waits for the first reading instead.
    const dueHoursPlaceholder =
        engineHours === null
            ? 'Hours at next service'
            : String(engineHours + (wholeNumber(form.interval) || DEFAULT_HOURS_INTERVAL));
    const repair = form.category === 'Repair';
    const preTrip = form.trigger === 'daily';

    if (isAdd) {
        return (
            <ModalSheet isOpen={true} onClose={onClose} title="New task">
                <div className="flex flex-col gap-2">
                    {/* Task Type Selector */}
                    <div>
                        <label className="text-label text-gray-400 font-bold uppercase tracking-wider block mb-1">
                            Type
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                aria-pressed={form.taskType === 'maintenance'}
                                onClick={() => {
                                    setTaskType('maintenance');
                                    setCategory('Engine');
                                }}
                                className={`flex min-h-[44px] items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-black transition-all text-center ${
                                    form.taskType === 'maintenance'
                                        ? 'bg-sky-500/20 text-sky-400 border-2 border-sky-500/40'
                                        : 'bg-white/5 text-gray-400 border-2 border-white/5'
                                }`}
                            >
                                <RefreshIcon className="h-3.5 w-3.5 shrink-0" />
                                Maintenance
                            </button>
                            <button
                                type="button"
                                aria-pressed={form.taskType === 'repair'}
                                onClick={() => {
                                    setTaskType('repair');
                                    setCategory('Repair');
                                }}
                                className={`flex min-h-[44px] items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-black transition-all text-center ${
                                    form.taskType === 'repair'
                                        ? 'bg-amber-500/20 text-amber-400 border-2 border-amber-500/40'
                                        : 'bg-white/5 text-gray-400 border-2 border-white/5'
                                }`}
                            >
                                <WrenchIcon className="h-3.5 w-3.5 shrink-0" />
                                Repair
                            </button>
                        </div>
                    </div>

                    {/* Category chips — only for Maintenance type */}
                    {form.taskType === 'maintenance' && (
                        <div>
                            <label className="text-label text-gray-400 font-bold uppercase tracking-wider block mb-1">
                                Category
                            </label>
                            <div className="grid grid-cols-3 gap-1.5">
                                {CATEGORIES.filter((cat) => cat.id !== 'Repair').map((cat) => (
                                    // Named by its label (every chip was 'Select category'),
                                    // with its state (UX scorecard run 7).
                                    <button
                                        type="button"
                                        aria-pressed={form.category === cat.id}
                                        key={cat.id}
                                        onClick={() => setCategory(cat.id)}
                                        className={`flex items-center justify-center gap-1.5 py-1 min-h-[44px] rounded-full text-label font-bold transition-all text-center ${
                                            form.category === cat.id
                                                ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                                                : 'bg-white/5 text-gray-400 border border-white/5'
                                        }`}
                                    >
                                        <cat.Icon className="h-3.5 w-3.5 shrink-0" />
                                        {cat.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Title */}
                    <FormField
                        label="Task name"
                        value={form.title}
                        onChange={(v) => setField('title', v)}
                        placeholder="Main engine oil change"
                        required
                        error={!form.title.trim() && form.title !== '' ? 'Task name is required' : undefined}
                    />

                    {/* Notes */}
                    <FormField
                        label="Notes (optional)"
                        type="textarea"
                        value={form.description}
                        onChange={(v) => setField('description', v)}
                        placeholder="Don't forget to check the bottom for rust..."
                        rows={1}
                    />

                    {/* Trigger type — hidden for Repair */}
                    {form.category !== 'Repair' && (
                        <div>
                            <label className="text-label text-gray-400 font-bold uppercase tracking-wider block mb-1">
                                Schedule
                            </label>
                            <div className="grid grid-cols-3 gap-1.5">
                                {(Object.keys(TRIGGER_LABELS) as MaintenanceTriggerType[]).map((t) => (
                                    <button
                                        type="button"
                                        aria-pressed={form.trigger === t}
                                        key={t}
                                        onClick={() => setTrigger(t)}
                                        className={`py-1 min-h-[44px] rounded-full text-label font-bold transition-all text-center ${
                                            form.trigger === t
                                                ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                                                : 'bg-white/5 text-gray-400 border border-white/5'
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
                                label="Interval (hours)"
                                value={form.interval}
                                onChange={(v) => setField('interval', v)}
                                placeholder="200"
                                inputMode="numeric"
                            />
                            <FormField
                                label="Next due (hours)"
                                value={form.dueHours}
                                onChange={(v) => setField('dueHours', v)}
                                placeholder={dueHoursPlaceholder}
                                inputMode="numeric"
                            />
                        </div>
                    )}

                    {/* Next due — for calendar triggers. A pre-trip check has
                        no day: it waits for a trip (132-B15). */}
                    {!repair && preTrip && <PreTripNote />}
                    {form.trigger !== 'engine_hours' && !repair && !preTrip && (
                        <FormField
                            label="First due"
                            type="date"
                            value={form.dueDate}
                            onChange={(v) => setField('dueDate', v)}
                            hint={`Repeats every ${TRIGGER_PERIODS[form.trigger] ?? TRIGGER_LABELS[form.trigger].toLowerCase()}`}
                        />
                    )}
                </div>

                {/* Save */}
                {!form.title.trim() && (
                    <p className="text-micro text-amber-400/80 text-center mt-2">Enter a task name to continue</p>
                )}
                <Button
                    variant="primary"
                    onClick={onSubmit}
                    disabled={!form.title.trim()}
                    className="w-full mt-2 shrink-0 disabled:cursor-not-allowed"
                >
                    Create task
                </Button>
            </ModalSheet>
        );
    }

    // ── Edit Mode (uses ModalSheet) ──
    return (
        <ModalSheet isOpen={true} onClose={onClose} title="Edit task">
            {/* Task Name */}
            <div className="mb-3">
                <FormField
                    label="Task name"
                    value={form.title}
                    onChange={(v) => setField('title', v)}
                    placeholder="Main engine oil change"
                    required
                />
            </div>

            {/* Notes */}
            <div className="mb-4">
                <FormField
                    label="Notes (optional)"
                    type="textarea"
                    value={form.description}
                    onChange={(v) => setField('description', v)}
                    placeholder="Don't forget to check for rust..."
                    rows={2}
                />
            </div>

            {/* Category */}
            <div className="mb-4">
                <label className="text-label text-gray-400 font-bold uppercase tracking-widest block mb-2">
                    Category
                </label>
                <div className="grid grid-cols-3 gap-2">
                    {CATEGORIES.map((cat) => (
                        <button
                            type="button"
                            aria-pressed={form.category === cat.id}
                            key={cat.id}
                            onClick={() => setCategory(cat.id)}
                            className={`flex items-center justify-center gap-1.5 py-2 min-h-[44px] rounded-full text-xs font-bold transition-all text-center ${form.category === cat.id ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-400 border border-white/5'}`}
                        >
                            <cat.Icon className="h-3.5 w-3.5 shrink-0" />
                            {cat.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Trigger type: a repair has no schedule (132-B15), as in Add */}
            {!repair && (
                <div className="mb-4">
                    <label className="text-label text-gray-400 font-bold uppercase tracking-widest block mb-2">
                        Schedule
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                        {(Object.keys(TRIGGER_LABELS) as MaintenanceTriggerType[]).map((t) => (
                            <button
                                type="button"
                                aria-pressed={form.trigger === t}
                                key={t}
                                onClick={() => setTrigger(t)}
                                className={`py-2 min-h-[44px] rounded-full text-xs font-bold transition-all text-center ${form.trigger === t ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-400 border border-white/5'}`}
                            >
                                {TRIGGER_LABELS[t]}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Engine hours interval */}
            {form.trigger === 'engine_hours' && !repair && (
                <>
                    <div className="mb-4">
                        <FormField
                            label="Interval (hours)"
                            value={form.interval}
                            onChange={(v) => setField('interval', v)}
                            placeholder="200"
                            inputMode="numeric"
                        />
                    </div>
                    <div className="mb-6">
                        <FormField
                            label="Next due (hours)"
                            value={form.dueHours}
                            onChange={(v) => setField('dueHours', v)}
                            placeholder={dueHoursPlaceholder}
                            inputMode="numeric"
                        />
                    </div>
                </>
            )}

            {/* Due date — for calendar triggers; a pre-trip check waits for a trip */}
            {!repair && preTrip && (
                <div className="mb-6">
                    <PreTripNote />
                </div>
            )}
            {form.trigger !== 'engine_hours' && !repair && !preTrip && (
                <div className="mb-6">
                    <FormField
                        label="Next due date"
                        type="date"
                        value={form.dueDate}
                        onChange={(v) => setField('dueDate', v)}
                    />
                </div>
            )}

            <Button
                variant="primary"
                onClick={onSubmit}
                disabled={!form.title.trim()}
                className="w-full disabled:cursor-not-allowed"
            >
                Save changes
            </Button>
        </ModalSheet>
    );
};
