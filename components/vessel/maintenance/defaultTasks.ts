/**
 * Default Maintenance Tasks — Seeded into every new user's R&M hub.
 *
 * 40 tasks across 4 groups:
 *   Engine  (10) — Mechanical & Engine ("The Heart")
 *   Hull    (10) — Plumbing & Hull ("Keeping Water Out")
 *   Safety  (10) — Electrical & Navigation ("The Brains")
 *   Rigging (10) — Rigging & Deck ("The Muscle")
 */
import type { MaintenanceCategory, MaintenanceTriggerType } from '../../../types';

export interface DefaultTaskTemplate {
    title: string;
    description: string;
    category: MaintenanceCategory;
    trigger_type: MaintenanceTriggerType;
    interval_value: number;
}

export const DEFAULT_MAINTENANCE_TASKS: DefaultTaskTemplate[] = [

    // ═══════════════════════════════════════════════════════════════
    // GROUP 1: MECHANICAL & ENGINE (The Heart)
    // ═══════════════════════════════════════════════════════════════
    {
        title: 'Check Engine Oil & Coolant Levels',
        description: 'Visual dipstick check and coolant reservoir level. Top up if needed.',
        category: 'Engine',
        trigger_type: 'daily',
        interval_value: 1,
    },
    {
        title: 'Inspect Raw Water Strainer',
        description: 'Check for Newport weed, jellyfish, and debris. Clean basket if blocked.',
        category: 'Engine',
        trigger_type: 'monthly',
        interval_value: 30,
    },
    {
        title: 'Inspect Drive Belts',
        description: 'Check tension and look for "black dust" (wear indicator). Replace if frayed.',
        category: 'Engine',
        trigger_type: 'quarterly',
        interval_value: 90,
    },
    {
        title: 'Check Fuel Filters / Water Separators',
        description: 'Look for water in the bowl. Drain if present. Replace filter if discoloured.',
        category: 'Engine',
        trigger_type: 'quarterly',
        interval_value: 90,
    },
    {
        title: 'Service Engine (Oil / Filters / Zincs)',
        description: 'Full engine service: oil change, oil filter, fuel filter, zincs. Reset hour counter.',
        category: 'Engine',
        trigger_type: 'engine_hours',
        interval_value: 100,
    },
    {
        title: 'Replace Engine Impeller',
        description: 'Preventative replacement. Check housing for scoring while open.',
        category: 'Engine',
        trigger_type: 'annual',
        interval_value: 365,
    },
    {
        title: 'Check Transmission / Gearbox Fluid',
        description: 'Check level and colour. Milky = water ingress. Top up with correct spec.',
        category: 'Engine',
        trigger_type: 'annual',
        interval_value: 365,
    },
    {
        title: 'Inspect Exhaust System / Elbows',
        description: 'Look for soot or rust "weeping" at joints. Check mixing elbow condition.',
        category: 'Engine',
        trigger_type: 'annual',
        interval_value: 365,
    },
    {
        title: 'Service Outboard (Plugs, Gear Oil, Greasing)',
        description: 'Spark plugs, lower unit gear oil, grease all fittings. Flush with fresh water.',
        category: 'Engine',
        trigger_type: 'annual',
        interval_value: 365,
    },
    {
        title: 'Inspect Propeller & Shaft',
        description: 'Check for fishing line wrap, dings, and shaft seal drip rate.',
        category: 'Engine',
        trigger_type: 'bi_annual',
        interval_value: 182,
    },

    // ═══════════════════════════════════════════════════════════════
    // GROUP 2: PLUMBING & HULL (Keeping Water Out)
    // ═══════════════════════════════════════════════════════════════
    {
        title: 'Exercise Seacocks',
        description: 'Open and close all seacocks to prevent seizing. Apply waterproof grease.',
        category: 'Hull',
        trigger_type: 'monthly',
        interval_value: 30,
    },
    {
        title: 'Test Bilge Pumps (Manual & Auto)',
        description: 'Test float switch triggers auto pump. Verify manual pump output. Check strainer.',
        category: 'Hull',
        trigger_type: 'monthly',
        interval_value: 30,
    },
    {
        title: 'Flush Toilets with Fresh Water',
        description: 'Run fresh water through heads to prevent calcium build-up and odour.',
        category: 'Hull',
        trigger_type: 'monthly',
        interval_value: 30,
    },
    {
        title: 'Check Hose Clamps',
        description: 'Nip up all accessible hose clamps. Double-clamp below waterline fittings.',
        category: 'Hull',
        trigger_type: 'quarterly',
        interval_value: 90,
    },
    {
        title: 'Inspect Through-Hull Fittings',
        description: 'Check for corrosion and verify bonding connections are secure.',
        category: 'Hull',
        trigger_type: 'bi_annual',
        interval_value: 182,
    },
    {
        title: 'Sanitize Fresh Water Tanks',
        description: 'Flush and sanitize with dilute bleach solution. Rinse thoroughly.',
        category: 'Hull',
        trigger_type: 'annual',
        interval_value: 365,
    },
    {
        title: 'Service Toilet Pump / Seal Kit',
        description: 'Replace pump valves, seals, and joker valve. Lubricate with silicone grease.',
        category: 'Hull',
        trigger_type: 'annual',
        interval_value: 365,
    },
    {
        title: 'Check Shower Sump Pump / Filter',
        description: 'Remove and clean hair/gunk from the sump filter. Test pump operation.',
        category: 'Hull',
        trigger_type: 'quarterly',
        interval_value: 90,
    },
    {
        title: 'Check Bungs & Seals',
        description: 'Verify all drain bungs are in place and seals are in good condition before every launch.',
        category: 'Hull',
        trigger_type: 'daily',
        interval_value: 1,
    },
    {
        title: 'Inspect Keel Bolts',
        description: 'Check for rust staining or movement around keel bolt heads inside the bilge.',
        category: 'Hull',
        trigger_type: 'annual',
        interval_value: 365,
    },

    // ═══════════════════════════════════════════════════════════════
    // GROUP 3: ELECTRICAL & NAVIGATION (The Brains)
    // ═══════════════════════════════════════════════════════════════
    {
        title: 'Test Navigation Lights',
        description: 'Verify all nav lights work: steaming, port, starboard, stern, anchor, tricolour.',
        category: 'Safety',
        trigger_type: 'monthly',
        interval_value: 30,
    },
    {
        title: 'Check Battery Terminals / Corrosion',
        description: 'Clean terminals with baking soda solution. Apply dielectric grease.',
        category: 'Safety',
        trigger_type: 'monthly',
        interval_value: 30,
    },
    {
        title: 'Test VHF Radio Check',
        description: 'Radio check on Ch 16 or coast station. Verify DSC MMSI programmed.',
        category: 'Safety',
        trigger_type: 'monthly',
        interval_value: 30,
    },
    {
        title: 'Inspect Shore Power Lead & Plug',
        description: 'Look for burn marks, corrosion, or melted pins. Test RCD/ELCB while connected.',
        category: 'Safety',
        trigger_type: 'monthly',
        interval_value: 30,
    },
    {
        title: 'Check Bilge High-Water Alarm',
        description: 'Test high-water alarm buzzer activates when float switch is raised.',
        category: 'Safety',
        trigger_type: 'bi_annual',
        interval_value: 182,
    },
    {
        title: 'Inventory Spare Fuses & Bulbs',
        description: 'Check spares kit has correct fuse ratings and replacement bulbs for all lights.',
        category: 'Safety',
        trigger_type: 'annual',
        interval_value: 365,
    },
    {
        title: 'Test Windlass / Anchor Winch',
        description: 'Run up and down under load. Check clutch holds. Inspect wiring and circuit breaker.',
        category: 'Safety',
        trigger_type: 'quarterly',
        interval_value: 90,
    },
    {
        title: 'Check Solar Panel Connections',
        description: 'Clean panels for efficiency. Check MC4 connectors and controller settings.',
        category: 'Safety',
        trigger_type: 'bi_annual',
        interval_value: 182,
    },
    {
        title: 'Verify GPS / Chartplotter Updates',
        description: 'Check for chart and firmware updates. Verify datum settings are correct.',
        category: 'Safety',
        trigger_type: 'annual',
        interval_value: 365,
    },
    {
        title: 'Check Compass Light / Deviation',
        description: 'Verify compass light works at night. Check deviation card is current.',
        category: 'Safety',
        trigger_type: 'annual',
        interval_value: 365,
    },

    // ═══════════════════════════════════════════════════════════════
    // GROUP 4: RIGGING & DECK (The Muscle)
    // ═══════════════════════════════════════════════════════════════
    {
        title: 'Rinse Deck Hardware with Fresh Water',
        description: 'Hose down all deck hardware, winches, and fittings after every salt-water trip.',
        category: 'Rigging',
        trigger_type: 'daily',
        interval_value: 1,
    },
    {
        title: 'Inspect Lifelines & Stanchions',
        description: 'Check for "meat hooks" (broken wire strands). Test stanchion base bolts.',
        category: 'Rigging',
        trigger_type: 'quarterly',
        interval_value: 90,
    },
    {
        title: 'Exercise / Lubricate Winches',
        description: 'Strip, clean, grease, and reassemble. Check pawls and springs.',
        category: 'Rigging',
        trigger_type: 'bi_annual',
        interval_value: 182,
    },
    {
        title: 'Inspect Standing Rigging (Swages)',
        description: 'Look for cracks at swage terminals. Check turnbuckle pins and split pins.',
        category: 'Rigging',
        trigger_type: 'annual',
        interval_value: 365,
    },
    {
        title: 'Check Running Rigging (Chafe)',
        description: 'Inspect halyards and sheets at contact points for chafe and UV damage.',
        category: 'Rigging',
        trigger_type: 'quarterly',
        interval_value: 90,
    },
    {
        title: 'Lubricate Sail Track / Slugs',
        description: 'Apply dry PTFE lubricant to mast track and mainsail slugs/slides.',
        category: 'Rigging',
        trigger_type: 'bi_annual',
        interval_value: 182,
    },
    {
        title: 'Inspect Anchor Chain & Shackle',
        description: 'Check for rust, seized shackles, and worn links. Verify swivel rotates freely.',
        category: 'Rigging',
        trigger_type: 'bi_annual',
        interval_value: 182,
    },
    {
        title: 'Polish Stainless Steel Rails',
        description: 'Polish with metal polish to prevent tea-staining. Apply protective wax.',
        category: 'Rigging',
        trigger_type: 'bi_annual',
        interval_value: 182,
    },
    {
        title: 'Check Bimini / Canvas Stitching',
        description: 'Inspect UV-exposed stitching. Re-stitch or patch any worn seams.',
        category: 'Rigging',
        trigger_type: 'annual',
        interval_value: 365,
    },
    {
        title: 'Climb Mast for Full Rig Check',
        description: 'Full masthead inspection: sheaves, lights, wind instruments, halyard exits, spreader boots.',
        category: 'Rigging',
        trigger_type: 'annual',
        interval_value: 365,
    },
];
