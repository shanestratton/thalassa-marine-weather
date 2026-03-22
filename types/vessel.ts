/**
 * types/vessel.ts — Vessel & equipment domain types
 *
 * Vessel profile, dimensions, polars, NMEA, inventory, maintenance, equipment, documents.
 */

import type { LengthUnit, WeightUnit, VolumeUnit } from './units';
import type { PolarData, NmeaSample, SmartPolarBucket, SmartPolarBucketGrid } from './navigation';

export interface VesselDimensionUnits {
    length: LengthUnit;
    beam: LengthUnit;
    draft: LengthUnit;
    displacement: WeightUnit;
    volume?: VolumeUnit;
}

export interface VesselProfile {
    name: string;
    type: 'sail' | 'power' | 'observer';
    model?: string;
    riggingType?: 'Sloop' | 'Cutter' | 'Ketch' | 'Yawl' | 'Schooner' | 'Catboat' | 'Solent' | 'Other';
    length: number;
    beam: number;
    draft: number;
    displacement: number;
    airDraft?: number;
    hullType?: 'monohull' | 'catamaran' | 'trimaran';
    keelType?: 'fin' | 'full' | 'wing' | 'skeg' | 'centerboard' | 'bilge';
    maxWaveHeight: number;
    maxWindSpeed?: number;
    cruisingSpeed: number;
    fuelCapacity?: number;
    waterCapacity?: number;
    fuelBurn?: number;
    hullColor?: string;
    registration?: string;
    mmsi?: string;
    callSign?: string;
    phoneticName?: string;
    sailNumber?: string;
    crewCount?: number;
    customIconUrl?: string;
    estimatedFields?: string[];
}

/** Ship's Stores item categories */
export type StoresCategory =
    | 'Engine'
    | 'Plumbing'
    | 'Electrical'
    | 'Rigging'
    | 'Safety'
    | 'Provisions'
    | 'Medical'
    | 'Misc'
    | 'Pantry'
    | 'Freezer'
    | 'Fridge'
    | 'Dry'
    | 'Booze'
    | 'Deck'
    | 'Cleaning';

/** @deprecated Use StoresCategory */
export type InventoryCategory = StoresCategory;

export const STORES_CATEGORIES: StoresCategory[] = [
    'Engine',
    'Plumbing',
    'Electrical',
    'Rigging',
    'Safety',
    'Provisions',
    'Medical',
    'Misc',
    'Pantry',
    'Freezer',
    'Fridge',
    'Dry',
    'Booze',
    'Deck',
    'Cleaning',
];

/** @deprecated Use STORES_CATEGORIES */
export const INVENTORY_CATEGORIES = STORES_CATEGORIES;

export const STORES_CATEGORY_ICONS: Record<StoresCategory, string> = {
    Engine: '⚙️',
    Plumbing: '🔧',
    Electrical: '⚡',
    Rigging: '⛵',
    Safety: '🛟',
    Provisions: '🥫',
    Medical: '🏥',
    Misc: '📦',
    Pantry: '🥫',
    Freezer: '🧊',
    Fridge: '🧊',
    Dry: '🌾',
    Booze: '🍺',
    Deck: '⚓',
    Cleaning: '🧹',
};

/** @deprecated Use STORES_CATEGORY_ICONS */
export const INVENTORY_CATEGORY_ICONS = STORES_CATEGORY_ICONS;

export interface StoresItem {
    id: string;
    user_id: string;
    barcode: string | null;
    item_name: string;
    description: string | null;
    category: StoresCategory;
    quantity: number;
    min_quantity: number;
    unit: string;
    location_zone: string | null;
    location_specific: string | null;
    expiry_date: string | null;
    created_at: string;
    updated_at: string;
}

/** @deprecated Use StoresItem */
export type InventoryItem = StoresItem;

export type MaintenanceCategory = 'Engine' | 'Safety' | 'Hull' | 'Rigging' | 'Routine' | 'Repair';
export type MaintenanceTriggerType = 'engine_hours' | 'daily' | 'quarterly' | 'monthly' | 'bi_annual' | 'annual';

export interface MaintenanceTask {
    id: string;
    user_id: string;
    title: string;
    description: string | null;
    category: MaintenanceCategory;
    trigger_type: MaintenanceTriggerType;
    interval_value: number | null;
    next_due_date: string | null;
    next_due_hours: number | null;
    last_completed: string | null;
    is_active: boolean;
    created_at: string;
    updated_at: string;
}

export interface MaintenanceHistory {
    id: string;
    user_id: string;
    task_id: string;
    completed_at: string;
    engine_hours_at_service: number | null;
    notes: string | null;
    cost: number | null;
    created_at: string;
}

export type EquipmentCategory = 'Propulsion' | 'Electronics' | 'HVAC' | 'Plumbing' | 'Rigging' | 'Galley';

export interface EquipmentItem {
    id: string;
    user_id: string;
    equipment_name: string;
    category: EquipmentCategory;
    make: string;
    model: string;
    serial_number: string;
    installation_date: string | null;
    warranty_expiry: string | null;
    manual_uri: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
}

export type DocumentCategory =
    | 'Registration'
    | 'Insurance'
    | 'Crew Visas/IDs'
    | 'Radio/MMSI'
    | 'Customs Clearances'
    | 'User Manuals';

export interface ShipDocument {
    id: string;
    user_id: string;
    document_name: string;
    category: DocumentCategory;
    issue_date: string | null;
    expiry_date: string | null;
    file_uri: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
    _offline?: boolean;
    _pendingFile?: string;
}

export interface LockerItem {
    name: string;
    icon: string;
    category: string;
}

// Re-export navigation types used in vessel context
export type { PolarData, NmeaSample, SmartPolarBucket, SmartPolarBucketGrid };
