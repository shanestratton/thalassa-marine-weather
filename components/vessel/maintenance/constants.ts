/**
 * Shared constants for MaintenanceHub and its subcomponents.
 */
import type React from 'react';
import type { MaintenanceCategory, MaintenanceTriggerType } from '../../../types';
import { ClipboardIcon, GearIcon, LifeBuoyIcon, WrenchIcon } from '../../icons/UIIcons';
import { BoatIcon, SailBoatIcon } from '../../icons/MaritimeIcons';

/** A stroke icon from components/icons; each one is aria-hidden. */
export type CategoryIcon = (props: { className?: string }) => React.JSX.Element;

// Line icons, not emoji: ⚙️ 🛟 🚢 ⛵ rendered as OS-varying colour glyphs
// beside the app's stroke icons (UX scorecard run 7).
export const CATEGORIES: { id: MaintenanceCategory; label: string; Icon: CategoryIcon }[] = [
    { id: 'Engine', label: 'Engine', Icon: GearIcon },
    // A life buoy, not a red dot: the dot sat beside the red/amber/green status
    // border and made every Safety task look overdue.
    { id: 'Safety', label: 'Safety', Icon: LifeBuoyIcon },
    { id: 'Hull', label: 'Hull', Icon: BoatIcon },
    { id: 'Rigging', label: 'Rigging', Icon: SailBoatIcon },
    { id: 'Routine', label: 'Routine', Icon: ClipboardIcon },
    { id: 'Repair', label: 'Repair', Icon: WrenchIcon },
];

export const TRIGGER_LABELS: Record<MaintenanceTriggerType, string> = {
    engine_hours: 'Engine hours',
    daily: 'Pre-trip',
    quarterly: 'Quarterly',
    monthly: 'Monthly',
    bi_annual: 'Six-monthly',
    annual: 'Annual',
};

/** How the "Repeats every …" hint names each time-based schedule. */
export const TRIGGER_PERIODS: Partial<Record<MaintenanceTriggerType, string>> = {
    quarterly: 'quarter',
    monthly: 'month',
    bi_annual: 'six months',
    annual: 'year',
};

export type { MaintenanceCategory, MaintenanceTriggerType };
