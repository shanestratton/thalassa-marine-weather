/**
 * Shared constants for MaintenanceHub and its subcomponents.
 */
import type { MaintenanceCategory, MaintenanceTriggerType } from '../../../types';

export const CATEGORIES: { id: MaintenanceCategory; label: string; icon: string }[] = [
    { id: 'Engine', label: 'Engine', icon: '⚙️' },
    { id: 'Safety', label: 'Safety', icon: '🔴' },
    { id: 'Hull', label: 'Hull', icon: '🚢' },
    { id: 'Rigging', label: 'Rigging', icon: '⛵' },
    { id: 'Routine', label: 'Routine', icon: '📋' },
    { id: 'Repair', label: 'Repair', icon: '🔧' },
];

export const TRIGGER_LABELS: Record<MaintenanceTriggerType, string> = {
    engine_hours: '⚙️ Engine Hours',
    daily: '📅 Daily',
    weekly: '📅 Weekly',
    monthly: '📅 Monthly',
    bi_annual: '📅 Bi-Annual',
    annual: '📅 Annual',
};

export type { MaintenanceCategory, MaintenanceTriggerType };
