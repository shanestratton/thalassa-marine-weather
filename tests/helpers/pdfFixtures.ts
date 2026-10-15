/**
 * pdfFixtures — the made-up boats, crews and logbooks the PDF tests print.
 *
 * Shared by the float plan, maintenance, Stores and Equipment PDF tests and
 * by the before/after page renders of package 129-10, so both sides of the
 * comparison print the same documents. Every name, number and identifier here is invented (the
 * repo is public): MMSIs are 503000000-style, phones are 0400 000 00x, hex
 * IDs are zero-filled.
 *
 * GLOBAL_TEXT carries every script the old html2canvas renderer could print
 * because it drew with the device's own fonts: Latin with accents, Greek,
 * Cyrillic, Japanese, Hebrew, Arabic and Thai. jsPDF's built-in Helvetica
 * encodes WinAnsi only, so this string is the guard that nothing a skipper
 * types is dropped or turned into "?".
 */
import type { FloatPlanInput } from '../../services/floatPlan';
import type { EquipmentItem, InventoryItem, MaintenanceHistory, MaintenanceTask } from '../../types';

/** 08:00 on Tuesday 13 October 2026 in Brisbane (UTC+10). */
export const PDF_FIXTURE_NOW = Date.UTC(2026, 9, 12, 22, 0, 0);
const HOUR = 3600e3;
const DAY = 24 * HOUR;

export const GLOBAL_PLACES = {
    latin: 'Nouméa Ålesund',
    greek: 'Θεσσαλονίκη',
    cyrillic: 'Владивосток',
    japanese: '長崎',
    hebrew: 'חיפה',
    arabic: 'الإسكندرية',
    thai: 'ภูเก็ต',
} as const;

/** Every script in one string, in the order the plan's decision B lists them. */
export const GLOBAL_TEXT = Object.values(GLOBAL_PLACES).join(' ');

export function standardFloatPlan(): FloatPlanInput {
    return {
        vessel: {
            name: 'Southerly Spirit',
            model: 'Bavaria 46',
            type: 'sail',
            hullType: 'monohull',
            hullMaterial: 'GRP',
            length: 46,
            draft: 6.9,
            hullColor: 'White',
            trimColor: 'Navy',
            hailingPort: 'Scarborough',
            registration: 'QX000Z',
            mmsi: '503000000',
            callSign: 'VZZ0000',
            prominentFeatures: 'Navy sail covers, wind generator on the stern arch',
            radiosMonitored: 'VHF 16 and 73',
            satPhone: '+881 600 000 000',
            fuelCapacity: 200 / 3.78541,
            waterCapacity: 400 / 3.78541,
            cruisingSpeed: 6,
            epirbHexId: '3EF0000000000000',
            liferaftCapacity: 6,
            liferaftServiceDate: 'Mar 2026',
            flaresExpiry: 'Jun 2027',
            tenderDescription: 'Grey 3 m inflatable, 15 hp outboard',
            safetyNotes: 'Jacklines rigged; danbuoy on the stern rail',
            shoreContact1: 'Alex Example (sister) — 0400 000 001',
            shoreContact2: 'Sam Sample (marina office) — 0400 000 002',
        },
        route: {
            name: 'Scarborough to Mooloolaba',
            from: 'Scarborough Marina',
            to: 'Mooloolaba',
            waypoints: [
                { lat: -27.2, lon: 153.11 },
                { lat: -27.05, lon: 153.25 },
                { lat: -26.82, lon: 153.2 },
                { lat: -26.68, lon: 153.13 },
            ],
        },
        departureMs: PDF_FIXTURE_NOW,
        etaMs: PDF_FIXTURE_NOW + 9 * HOUR,
        overdueMs: PDF_FIXTURE_NOW + 13 * HOUR,
        personsOnBoard: 3,
        personsRoster: [
            { name: 'Jordan Example', role: 'Deckhand', age: 19 },
            { name: 'Robin Sample', role: 'Skipper', age: 58, phone: '0400 000 003' },
            { name: 'Casey Placeholder', role: 'First mate', age: 54, medical: 'Asthma, inhaler in the nav station' },
        ],
        whoToCall: 'VMR Example Bay — 07 5000 0000',
        contactAboard: 'Sat phone +881 600 000 000; VHF 16',
        provisionsDays: 5,
        timeZone: 'Australia/Brisbane',
    };
}

/** Every script, in a vessel name, a crew name, the places, a note and a contact. */
export function globalFloatPlan(): FloatPlanInput {
    const base = standardFloatPlan();
    return {
        ...base,
        vessel: {
            ...base.vessel,
            name: `Étoile ${GLOBAL_TEXT}`,
            hailingPort: GLOBAL_PLACES.japanese,
            prominentFeatures: `Red dodger — «${GLOBAL_PLACES.greek}» on the transom`,
            safetyNotes: `Note: ${GLOBAL_TEXT}`,
            shoreContact1: `${GLOBAL_PLACES.hebrew} — +972 0 000 0000`,
            shoreContact2: `${GLOBAL_PLACES.arabic} — +20 0 000 0000`,
        },
        route: {
            name: `${GLOBAL_PLACES.latin} → ${GLOBAL_PLACES.thai}`,
            from: GLOBAL_TEXT,
            to: `${GLOBAL_PLACES.cyrillic} (${GLOBAL_PLACES.japanese})`,
            waypoints: base.route.waypoints,
        },
        personsOnBoard: 4,
        personsRoster: [
            { name: GLOBAL_TEXT, role: 'Skipper', age: 47, medical: `Note: ${GLOBAL_TEXT}` },
            { name: 'Ingrid Ødegård', role: 'First mate', age: 39 },
            { name: 'דוד כהן', role: 'Navigator', age: 33, medical: 'אלרגיה לפניצילין' },
            { name: 'ليلى حداد', role: 'Cook', age: 29, phone: '+20 0 000 0001' },
        ],
        whoToCall: 'MRCC Nouméa — +687 00 00 00',
        contactAboard: `Iridium +881 600 000 000 · ${GLOBAL_PLACES.thai}`,
        timeZone: 'Pacific/Noumea',
    };
}

const LONG_NOTE =
    'Carries a spare impeller, belts and a full set of filters; the liferaft cradle is on the coachroof aft of the mast, ' +
    'the grab bag lives in the port cockpit locker with handheld VHF, flares, water and a printed copy of this plan, ' +
    'and the second EPIRB is registered to the tender rather than the yacht so a search should expect two beacons.';

/** Twelve aboard and long notes: the plan wraps and breaks pages. */
export function longFloatPlan(): FloatPlanInput {
    const base = standardFloatPlan();
    const roles = ['Skipper', 'Co-skipper', 'First mate', 'Navigator', 'Engineer', 'Cook', 'Deckhand', 'Guest'];
    return {
        ...base,
        vessel: {
            ...base.vessel,
            prominentFeatures: `Navy sail covers, wind generator, radar dome on the mast; ${LONG_NOTE}`,
            safetyNotes: LONG_NOTE,
        },
        route: {
            ...base.route,
            name: 'Scarborough to Lady Musgrave Island via Mooloolaba, Double Island Point and Bundaberg',
            waypoints: Array.from({ length: 40 }, (_, index) => ({
                lat: -27.2 + index * 0.08,
                lon: 153.11 + Math.sin(index / 4) * 0.2,
            })),
        },
        personsOnBoard: 12,
        personsRoster: Array.from({ length: 12 }, (_, index) => ({
            name: `Crew Member ${String.fromCharCode(65 + index)} Example-Placeholder`,
            role: roles[index % roles.length],
            age: 20 + index * 3,
            phone: `0400 000 ${String(100 + index).padStart(3, '0')}`,
            medical:
                index % 3 === 0
                    ? 'Seasick on the first day; takes ginger and is fine after that, keeps a spare pack in the grab bag, and wants to be woken for every sail change at night'
                    : 'No medical conditions; strong swimmer; has done the sea survival course',
        })),
        provisionsDays: 14,
    };
}

export const FLOAT_PLAN_FIXTURES = {
    standard: standardFloatPlan,
    global: globalFloatPlan,
    long: longFloatPlan,
} as const;

function task(overrides: Partial<MaintenanceTask> & Pick<MaintenanceTask, 'id' | 'title'>): MaintenanceTask {
    return {
        user_id: 'user-fixture',
        description: null,
        category: 'Engine',
        trigger_type: 'annual',
        interval_value: 180,
        next_due_date: null,
        next_due_hours: null,
        last_completed: null,
        is_active: true,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        ...overrides,
    };
}

function isoDay(offsetDays: number): string {
    return new Date(PDF_FIXTURE_NOW + offsetDays * DAY).toISOString().slice(0, 10);
}

/** A boat's open jobs: every status, hours and dates, and one in every script. */
export function maintenanceTasks(): MaintenanceTask[] {
    return [
        task({ id: 't1', title: 'Change engine oil and filter', trigger_type: 'engine_hours', next_due_hours: 1210 }),
        task({ id: 't2', title: 'Replace raw water impeller', trigger_type: 'engine_hours', next_due_hours: 1350 }),
        task({ id: 't3', title: 'Service the winches', next_due_date: isoDay(-12) }),
        task({ id: 't4', title: 'Antifoul and replace anodes', category: 'Hull', next_due_date: isoDay(5) }),
        task({ id: 't5', title: 'Liferaft service', category: 'Safety', next_due_date: isoDay(140) }),
        task({ id: 't6', title: 'Check rig and turnbuckles', category: 'Rigging', next_due_date: null }),
        task({ id: 't7', title: `Service tender outboard — ${GLOBAL_TEXT}`, next_due_date: isoDay(30) }),
        task({
            id: 't8',
            title: 'Fuel polishing (legacy hours schedule)',
            trigger_type: 'engine_hours',
            interval_value: 100,
            next_due_hours: 100,
        }),
    ];
}

/** Forty jobs, so the checklist runs past one page. */
export function longMaintenanceTasks(): MaintenanceTask[] {
    const base = maintenanceTasks();
    return [
        ...base,
        ...Array.from({ length: 36 }, (_, index) =>
            task({
                id: `l${index}`,
                title: `Inspect and grease seacock ${index + 1} (${index % 2 ? 'port' : 'starboard'} bilge)`,
                next_due_date: isoDay(index * 7 - 20),
            }),
        ),
    ];
}

export function maintenanceHistory(): (MaintenanceHistory & { taskTitle?: string; taskCategory?: string })[] {
    const entry = (
        index: number,
        taskTitle: string | undefined,
        notes: string | null,
        cost: number | null,
        hours: number | null,
    ): MaintenanceHistory & { taskTitle?: string; taskCategory?: string } => ({
        id: `h${index}`,
        user_id: 'user-fixture',
        task_id: `t${index}`,
        completed_at: new Date(PDF_FIXTURE_NOW - (index + 1) * 9 * DAY).toISOString(),
        engine_hours_at_service: hours,
        notes,
        cost,
        created_at: '2026-01-01T00:00:00Z',
        taskTitle,
        taskCategory: 'Engine',
    });
    return [
        entry(0, 'Change engine oil and filter', 'Oil was clean; 7.5 L of 15W-40', 142.5, 1110),
        entry(1, 'Replace raw water impeller', null, 68, 1102),
        entry(2, `Service tender outboard — ${GLOBAL_TEXT}`, `Note: ${GLOBAL_TEXT}`, 0, null),
        entry(3, undefined, 'Task since deleted', 25, null),
        entry(4, 'Antifoul and replace anodes', LONG_NOTE, 2380, null),
        ...Array.from({ length: 30 }, (_, index) =>
            entry(
                5 + index,
                `Inspect and grease seacock ${index + 1}`,
                index % 4 ? null : 'Stiff, freed off',
                index % 5 ? 0 : 12.75,
                900 + index,
            ),
        ),
    ];
}

export const MAINTENANCE_VESSEL = 'Southerly Spirit';
export const MAINTENANCE_ENGINE_HOURS = 1198;

// ── Ship's Stores and the Equipment Register (130-B8) ───────────

/** A long name with spaces: the old tables cut it at 30-odd characters without a mark. */
export const LONG_STORES_NAME = 'Long-life milk, full cream, one litre cartons bought for the Coral Sea crossing';
export const LONG_MODEL = 'Axiom+ 12 RV multifunction display with RealVision 3D sonar';

function storesItem(
    overrides: Partial<InventoryItem> & Pick<InventoryItem, 'id' | 'item_name' | 'category'>,
): InventoryItem {
    return {
        user_id: 'user-fixture',
        barcode: null,
        description: null,
        quantity: 4,
        min_quantity: 0,
        unit: 'each',
        location_zone: 'Galley',
        location_specific: null,
        expiry_date: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        ...overrides,
    };
}

/** A boat's stores: low stock, part units, every expiry state, a long name and every script. */
export function storesItems(): InventoryItem[] {
    return [
        storesItem({ id: 's1', item_name: LONG_STORES_NAME, category: 'Provisions', quantity: 12, min_quantity: 6 }),
        storesItem({ id: 's2', item_name: 'Basmati rice', category: 'Dry', quantity: 2.5, unit: 'kg' }),
        storesItem({
            id: 's3',
            item_name: 'Seasickness tablets',
            category: 'Medical',
            quantity: 1,
            min_quantity: 4,
            location_zone: 'Nav station',
            location_specific: 'Top drawer, red first-aid box behind the chart folio',
            expiry_date: isoDay(-3),
        }),
        storesItem({
            id: 's4',
            item_name: 'Handheld flares',
            category: 'Safety',
            quantity: 6,
            min_quantity: 4,
            location_zone: 'Cockpit locker',
            expiry_date: isoDay(40),
        }),
        storesItem({
            id: 's5',
            item_name: 'Engine oil 15W-40',
            category: 'Engine',
            quantity: 10,
            expiry_date: isoDay(400),
            location_zone: null,
            location_specific: 'Under the saloon sole',
        }),
        storesItem({ id: 's6', item_name: `Ouzo — ${GLOBAL_PLACES.greek}`, category: 'Booze', quantity: 2 }),
        storesItem({
            id: 's7',
            item_name: `味噌 miso from ${GLOBAL_PLACES.japanese}`,
            category: 'Pantry',
            quantity: 1,
        }),
        storesItem({ id: 's8', item_name: `Za'atar — ${GLOBAL_PLACES.arabic}`, category: 'Pantry', quantity: 3 }),
    ];
}

/** Ninety items in one category: the table runs over pages. */
export function longStoresItems(): InventoryItem[] {
    return [
        ...storesItems(),
        ...Array.from({ length: 90 }, (_, index) =>
            storesItem({
                id: `p${index}`,
                item_name: `Tinned tomatoes, batch ${index + 1}${index % 7 ? '' : ` — ${LONG_STORES_NAME}`}`,
                category: 'Provisions',
                quantity: index % 5,
                min_quantity: 2,
                expiry_date: isoDay(index * 9 - 30),
            }),
        ),
    ];
}

function equipmentItem(
    overrides: Partial<EquipmentItem> & Pick<EquipmentItem, 'id' | 'equipment_name' | 'category'>,
): EquipmentItem {
    return {
        user_id: 'user-fixture',
        make: '',
        model: '',
        serial_number: '',
        installation_date: null,
        warranty_expiry: null,
        manual_uri: null,
        notes: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        ...overrides,
    };
}

/** A register with long makes, models and serials, every warranty state, and a category the app no longer has. */
export function equipmentItems(): EquipmentItem[] {
    return [
        equipmentItem({
            id: 'e1',
            equipment_name: 'Main engine',
            category: 'Propulsion',
            make: 'Yanmar',
            model: '4JH57 common-rail turbo diesel, saildrive SD60',
            serial_number: 'E000000-0000000000-SD60',
            warranty_expiry: isoDay(-20),
        }),
        equipmentItem({
            id: 'e2',
            equipment_name: 'Chartplotter',
            category: 'Electronics',
            make: 'Raymarine',
            model: LONG_MODEL,
            serial_number: '0000000',
            warranty_expiry: isoDay(60),
        }),
        equipmentItem({
            id: 'e3',
            equipment_name: `VHF — ${GLOBAL_PLACES.cyrillic}`,
            category: 'Electronics',
            make: 'Standard Horizon',
            model: 'GX2400',
            warranty_expiry: isoDay(700),
        }),
        equipmentItem({ id: 'e4', equipment_name: 'Watermaker', category: 'Plumbing', make: 'Spectra' }),
        equipmentItem({
            id: 'e5',
            equipment_name: 'Liferaft',
            // A category from an older build: it still prints, under Other.
            category: 'Safety' as EquipmentItem['category'],
            make: 'Example Rafts',
        }),
    ];
}

export const STORES_VESSEL = 'Serene Example';
