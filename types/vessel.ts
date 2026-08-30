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
    /**
     * SAR-relevant gear, entered ONCE on the vessel rather than per voyage.
     * These exist for the float plan: the beacon's registered hex ID is what
     * lets a shore contact tie a distress alert to this boat, and raft
     * capacity tells a rescue coordinator how many souls the search is for.
     *
     * NEVER render these on the public tracking page. The hex ID is a
     * credential AMSA verifies against — publishing it invites hoax alerts
     * and registry social-engineering — and raft/flare details are an
     * inventory of portable, valuable gear attached to a live position.
     * They belong in the float plan, which goes to one chosen person.
     */
    epirbHexId?: string;
    liferaftCapacity?: number;
    /** ISO date (YYYY-MM-DD) the raft was last serviced. */
    liferaftServiceDate?: string;
    /** ISO date (YYYY-MM-DD) the flares expire. */
    flaresExpiry?: string;
    /** Free-text extra SAR gear for the float plan — "PLB ×2, drogue,
     *  Starlink, 6-person grab bag". Same never-public rule as the rest. */
    safetyNotes?: string;
    /** Skipper's mobile — seeds the float plan's "how to reach you" so it
     *  isn't retyped every voyage. Never rendered on the public page. */
    contactPhone?: string;
    /**
     * USCG-style search-and-rescue identification (2026-08-26, float plan
     * restructure). What a search aircraft or coordinator uses to FIND and
     * RECOGNISE the boat. Same never-public rule as the block above: these
     * ship only in the float plan, to one chosen person.
     */
    /** Port shown on the transom / rego — "Newport, QLD". */
    hailingPort?: string;
    /** Hull construction — fibreglass, steel, aluminium, timber. */
    hullMaterial?: string;
    /** Deck/trim colour, distinct from the hull. */
    trimColor?: string;
    /** What to look for from the air — "hard dodger, wind generator, tan
     *  sail covers". The single most SAR-useful free-text field. */
    prominentFeatures?: string;
    /** Radios and channels actually monitored — "VHF 16 + 67; HF 8291". */
    radiosMonitored?: string;
    /** Satellite phone number, if carried. */
    satPhone?: string;
    /** Tender/dinghy, separate from the liferaft — "grey 2.6 m RIB,
     *  5 hp outboard". A boat found without its tender tells SAR a story. */
    tenderDescription?: string;
    /**
     * Two people ashore who would plausibly have heard from us — partner,
     * family, the marina office. Name and number in one line: "Jane Stratton —
     * 0412 345 678".
     *
     * These exist for the float plan's overdue guide. Without them the holder
     * is told to "ask anyone else who might have heard", which is useless at
     * 2am to someone frightened; with them it is a name and a number to ring
     * before escalating. They are also the step that prevents most false
     * alarms, because the usual answer is that someone has already heard from
     * the boat.
     *
     * Same never-public rule as the SAR block above: these are third parties'
     * contact details, and they ship only in the float plan, to one chosen
     * person.
     */
    shoreContact1?: string;
    shoreContact2?: string;
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
    currency?: string | null;
    unit_value?: number | null;
    unit_system?: 'metric' | 'imperial' | null;
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
