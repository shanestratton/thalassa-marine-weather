/**
 * useMaintenanceForm — Consolidates the 10+ useState hooks for
 * MaintenanceHub's add/edit form into a single useReducer.
 *
 * Reduces MaintenanceHub's state surface from 26 to ~16 useState calls,
 * and centralises form reset/populate logic.
 */
import { useReducer, useCallback } from 'react';
import type { MaintenanceCategory, MaintenanceTriggerType } from '../types';

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
    | { type: 'POPULATE'; payload: Partial<MaintenanceFormState> };

const initialState: MaintenanceFormState = {
    title: '',
    description: '',
    taskType: 'maintenance',
    category: 'Engine',
    trigger: 'monthly',
    interval: '200',
    dueDate: new Date().toISOString().split('T')[0],
    dueHours: '',
};

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
            return { ...initialState, dueDate: new Date().toISOString().split('T')[0] };
        case 'POPULATE':
            return { ...state, ...action.payload };
        default:
            return state;
    }
}

export type UseMaintenanceFormReturn = ReturnType<typeof useMaintenanceForm>;

export function useMaintenanceForm() {
    const [form, dispatch] = useReducer(formReducer, initialState);

    const setField = useCallback((field: keyof MaintenanceFormState, value: string) => {
        dispatch({ type: 'SET_FIELD', field, value });
    }, []);

    const reset = useCallback(() => {
        dispatch({ type: 'RESET' });
    }, []);

    const populate = useCallback((data: Partial<MaintenanceFormState>) => {
        dispatch({ type: 'POPULATE', payload: data });
    }, []);

    return {
        form,
        setField,
        setCategory: (v: MaintenanceCategory) => dispatch({ type: 'SET_CATEGORY', value: v }),
        setTaskType: (v: 'maintenance' | 'repair') => dispatch({ type: 'SET_TASK_TYPE', value: v }),
        setTrigger: (v: MaintenanceTriggerType) => dispatch({ type: 'SET_TRIGGER', value: v }),
        reset,
        populate,
    };
}
