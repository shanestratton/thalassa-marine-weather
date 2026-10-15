/**
 * useMaintenanceForm — Consolidates the 10+ useState hooks for
 * MaintenanceHub's add/edit form into a single useReducer.
 *
 * Reduces MaintenanceHub's state surface from 26 to ~16 useState calls,
 * and centralises form reset/populate logic.
 */
import { useReducer, useCallback } from 'react';
import type { MaintenanceCategory, MaintenanceTriggerType } from '../types';
import { toLocalDateString } from '../utils/localDate';

export interface MaintenanceFormState {
    title: string;
    description: string;
    taskType: 'maintenance' | 'repair';
    category: MaintenanceCategory;
    trigger: MaintenanceTriggerType;
    interval: string;
    dueDate: string;
    dueHours: string;
}

type FormAction =
    | { type: 'SET_FIELD'; field: keyof MaintenanceFormState; value: string }
    | { type: 'SET_CATEGORY'; value: MaintenanceCategory }
    | { type: 'SET_TASK_TYPE'; value: 'maintenance' | 'repair' }
    | { type: 'SET_TRIGGER'; value: MaintenanceTriggerType }
    | { type: 'RESET' }
    | { type: 'POPULATE'; payload: Partial<MaintenanceFormState> }
    | { type: 'OPEN_ADD'; today: string };

/** The form, and what the sheet that opens next needs to know about it. */
interface FormDraft {
    form: MaintenanceFormState;
    /** It holds a task opened for editing, not a new one. */
    holdsEdit: boolean;
    /** The skipper picked 'First due' themselves. */
    duePicked: boolean;
}

/**
 * An empty form. 'First due' starts on today's LOCAL day: the UTC date, fixed
 * when the module loaded, was yesterday before 10:00 in Queensland and
 * tomorrow on an American evening (131-B11, MAINT-07). Add moves it on again
 * when it opens (openForAdd), as the page can stay open overnight.
 */
const emptyForm = (): MaintenanceFormState => ({
    title: '',
    description: '',
    taskType: 'maintenance',
    category: 'Engine',
    trigger: 'monthly',
    interval: '200',
    dueDate: toLocalDateString(),
    dueHours: '',
});

const emptyDraft = (): FormDraft => ({ form: emptyForm(), holdsEdit: false, duePicked: false });

function formReducer(state: MaintenanceFormState, action: FormAction): MaintenanceFormState {
    switch (action.type) {
        case 'SET_FIELD':
            return { ...state, [action.field]: action.value };
        case 'SET_CATEGORY':
            return { ...state, category: action.value };
        case 'SET_TASK_TYPE': {
            const isRepair = action.value === 'repair';
            return {
                ...state,
                taskType: action.value,
                category: isRepair ? 'Repair' : state.category === 'Repair' ? 'Engine' : state.category,
            };
        }
        case 'SET_TRIGGER':
            return { ...state, trigger: action.value };
        case 'RESET':
            return emptyForm();
        case 'POPULATE':
            return { ...state, ...action.payload };
        default:
            return state;
    }
}

function draftReducer(state: FormDraft, action: FormAction): FormDraft {
    switch (action.type) {
        case 'RESET':
            return emptyDraft();
        case 'POPULATE':
            return { ...state, form: formReducer(state.form, action), holdsEdit: true };
        case 'OPEN_ADD':
            // A task opened for editing left its name and due day behind, and
            // Add opened on them: a new task starts clean (131-B11).
            if (state.holdsEdit) return emptyDraft();
            // A draft closed unsaved keeps what the skipper typed and any day
            // they picked; an untouched 'First due' is today, which is not
            // always the day the page opened (131-B11, MAINT-07).
            if (state.duePicked || state.form.dueDate === action.today) return state;
            return { ...state, form: { ...state.form, dueDate: action.today } };
        default:
            return {
                ...state,
                form: formReducer(state.form, action),
                duePicked: state.duePicked || (action.type === 'SET_FIELD' && action.field === 'dueDate'),
            };
    }
}

export type UseMaintenanceFormReturn = ReturnType<typeof useMaintenanceForm>;

export function useMaintenanceForm() {
    const [{ form }, dispatch] = useReducer(draftReducer, undefined, emptyDraft);

    const setField = useCallback((field: keyof MaintenanceFormState, value: string) => {
        dispatch({ type: 'SET_FIELD', field, value });
    }, []);

    const reset = useCallback(() => {
        dispatch({ type: 'RESET' });
    }, []);

    /** Fills the form from a task opened for editing. */
    const populate = useCallback((data: Partial<MaintenanceFormState>) => {
        dispatch({ type: 'POPULATE', payload: data });
    }, []);

    /** Readies the form for the Add sheet, as it opens (131-B11). */
    const openForAdd = useCallback(() => {
        dispatch({ type: 'OPEN_ADD', today: toLocalDateString() });
    }, []);

    return {
        form,
        setField,
        setCategory: (v: MaintenanceCategory) => dispatch({ type: 'SET_CATEGORY', value: v }),
        setTaskType: (v: 'maintenance' | 'repair') => dispatch({ type: 'SET_TASK_TYPE', value: v }),
        setTrigger: (v: MaintenanceTriggerType) => dispatch({ type: 'SET_TRIGGER', value: v }),
        reset,
        populate,
        openForAdd,
    };
}
