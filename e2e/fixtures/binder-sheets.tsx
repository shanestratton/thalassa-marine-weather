/**
 * Boat Binder pages and sheets · layout fixture (132-B19). The real
 * Equipment, Documents, Maintenance, Ship's Stores or Checklists page, with
 * the app's CSS under a copy of App.tsx's header and tab bar, over the real
 * local database, so each page and its Add and Edit sheets are measured
 * against the real chrome, the real ModalSheet and index.css
 * (browser-tests/equipment-layout.spec.ts and its four siblings).
 *
 * What is on each page, all of it as if synced from another device:
 *  - Equipment: gear in every category, long names, in English, French,
 *    Greek and Japanese; the main engine with notes;
 *  - Documents: papers with and without notes;
 *  - Maintenance: the forty suggested tasks the page seeds, an open repair, a
 *    paused task and a repair marked fixed, engine hours not yet entered;
 *  - Ship's Stores: spares and provisions across the categories;
 *  - Checklists: two lists with their items.
 *
 * No account, network or boat: the skipper is signed in by hand, every fetch
 * is refused, storage is page-only, and every name is fictional: the
 * Kestrel's binder from Horta to Opua.
 *
 * ?binder=equipment|documents|maintenance|stores|checklists
 * &insetTop=20 (the status bar's inset, which pushes the page down; a browser
 * draws env(safe-area-inset-*) as 0, so the header takes it from here).
 * Dispatch `test:keyboard` with a height to raise a keyboard.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import type { ChecklistEntry } from '../../services/vessel/LocalChecklistService';
import '../../index.css';

if (!import.meta.env.DEV)
    throw new Error('The binder-sheets fixture is available only through the development server.');

class FixtureStorage implements Storage {
    private entries = new Map<string, string>();
    get length() {
        return this.entries.size;
    }
    clear() {
        this.entries.clear();
    }
    getItem(key: string) {
        return this.entries.get(String(key)) ?? null;
    }
    key(index: number) {
        return [...this.entries.keys()][index] ?? null;
    }
    removeItem(key: string) {
        this.entries.delete(String(key));
    }
    setItem(key: string, value: string) {
        this.entries.set(String(key), String(value));
    }
}
// Isolation BEFORE any application service loads.
Object.defineProperty(window, 'localStorage', { configurable: true, value: new FixtureStorage() });
Object.defineProperty(window, 'sessionStorage', { configurable: true, value: new FixtureStorage() });
window.fetch = async () =>
    new Response(JSON.stringify({ error: 'Binder-sheets fixture: network disabled.' }), { status: 503 });

type Binder = 'equipment' | 'documents' | 'maintenance' | 'stores' | 'checklists';
const BINDERS: Binder[] = ['equipment', 'documents', 'maintenance', 'stores', 'checklists'];
const params = new URLSearchParams(location.search);
const binder = (BINDERS as string[]).includes(params.get('binder') ?? '')
    ? (params.get('binder') as Binder)
    : 'equipment';
const insetTop = Number(params.get('insetTop') ?? 20);

// A real browser shows no mobile keyboard under automation: the visual
// viewport is modelled (as e2e/fixtures/stores-boxes.tsx does) with the real
// app-wide keyboard guard; dispatch `test:keyboard` with a height.
const viewport = new EventTarget();
const keyboardCover = document.createElement('div');
keyboardCover.textContent = 'Keyboard (simulated)';
keyboardCover.setAttribute('data-testid', 'keyboard');
Object.assign(keyboardCover.style, {
    position: 'fixed',
    bottom: '0',
    left: '0',
    right: '0',
    height: '0',
    display: 'none',
    background: '#334155',
    color: '#cbd5e1',
    textAlign: 'center',
    paddingTop: '20px',
    zIndex: '2147483647',
});
document.body.append(keyboardCover);
Object.assign(viewport, { height: window.innerHeight, offsetTop: 0, scale: 1 });
Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
window.addEventListener('test:keyboard', ((event: CustomEvent<number>) => {
    Object.assign(viewport, { height: window.innerHeight - event.detail });
    keyboardCover.style.height = `${event.detail}px`;
    keyboardCover.style.display = event.detail ? 'block' : 'none';
    viewport.dispatchEvent(new Event('resize'));
}) as EventListener);

const SKIPPER = '5c7e9a1b-3d5f-4a7b-9c1d-3e5f7a9b1c3d';
const AT = '2026-10-12T01:00:00.000Z';
const DAY = 86_400_000;
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

const [{ setAuthIdentityScope, authScopedStorageKey, getAuthIdentityScope }, { useAuthStore }, database, keyboard] =
    await Promise.all([
        import('../../services/authIdentityScope'),
        import('../../stores/authStore'),
        import('../../services/vessel/LocalDatabase'),
        import('../../utils/keyboardScroll'),
    ]);
keyboard.initGlobalKeyboardScroll();
// The auth store signs the page out at import (no session here); let it finish
// before this fixture signs in.
await new Promise<void>((resolve) => {
    if (useAuthStore.getState().authChecked) return resolve();
    const stop = useAuthStore.subscribe((state) => {
        if (!state.authChecked) return;
        stop();
        resolve();
    });
});
setAuthIdentityScope(SKIPPER);
useAuthStore.setState({ user: { id: SKIPPER } as never, authChecked: true });
await database.initLocalDatabase(SKIPPER);

const own = { user_id: SKIPPER, created_at: AT, updated_at: AT };

async function seedEquipment() {
    const gear: [string, string, string, string, string | null][] = [
        [
            'Main engine',
            'Propulsion',
            'Yanmar',
            '3YM30AE',
            'Oil and filter every 150 h. Spare impeller in the lazarette.',
        ],
        ['Autopilot drive, below-deck hydraulic ram', 'Electronics', 'Example Marine', 'HR-2000', null],
        ['VHF radio with DSC', 'Electronics', 'Example Marine', 'V-25', null],
        ['Diesel cabin heater', 'HVAC', 'Example Heat', 'D2', null],
        ['Αντλία σεντίνας', 'Plumbing', 'Example Pumps', 'B-12', null],
        ['Watermaker, high-pressure pump and pre-filters', 'Plumbing', 'Example Water', 'WM-40', null],
        ['Guindeau électrique', 'Rigging', 'Example Winches', 'W-1000', null],
        ['冷蔵庫', 'Galley', 'Example Cold', 'R-60', null],
    ];
    await database.mergePulledRecords(
        'equipment_register',
        gear.map(([name, category, make, model, notes], i) => ({
            ...own,
            id: uuid('1e1e1e1e', i + 1),
            equipment_name: name,
            category,
            make,
            model,
            serial_number: `KST-${2400 + i}`,
            installation_date: '2024-03-01',
            warranty_expiry: i % 3 === 0 ? isoDay(200) : null,
            manual_uri: null,
            notes,
        })),
    );
}

async function seedDocuments() {
    const papers: [string, string, string | null][] = [
        ['Registo de Propriedade', 'Registration', null],
        ['Hull insurance, Horta to Opua', 'Insurance', 'Policy KX-2231, agent Pico Marine'],
        ['Ship radio licence', 'Radio/MMSI', 'Callsign VJN4417'],
        ['Despacho de saída, Horta', 'Customs Clearances', null],
        ['Watermaker manual', 'User Manuals', null],
    ];
    await database.mergePulledRecords(
        'ship_documents',
        papers.map(([name, category, notes], i) => ({
            ...own,
            id: uuid('2d2d2d2d', i + 1),
            document_name: name,
            category,
            issue_date: null,
            expiry_date: i === 1 ? isoDay(25) : null,
            file_uri: null,
            notes,
        })),
    );
}

async function seedMaintenance() {
    const { DEFAULT_MAINTENANCE_TASKS } = await import('../../components/vessel/maintenance/defaultTasks');
    // Seeded once already on this phone: the page never seeds on top.
    localStorage.setItem(authScopedStorageKey('thalassa_maintenance_seeded', getAuthIdentityScope()), '1');
    const suggested = DEFAULT_MAINTENANCE_TASKS.map((task, i) => ({
        ...own,
        id: uuid('3c3c3c3c', i + 1),
        title: task.title,
        description: task.description,
        category: task.category,
        trigger_type: task.trigger_type,
        interval_value: task.interval_value,
        next_due_date:
            task.trigger_type === 'engine_hours' || task.trigger_type === 'daily'
                ? null
                : isoDay(i % 7 === 0 ? -2 : task.interval_value),
        next_due_hours: null,
        last_completed: null,
        is_active: true,
    }));
    const repair = (n: number, title: string, active: boolean) => ({
        ...own,
        id: uuid('3c3c3c3c', 100 + n),
        title,
        description: null,
        category: 'Repair',
        trigger_type: 'daily',
        interval_value: null,
        next_due_date: null,
        next_due_hours: null,
        last_completed: active ? null : AT,
        is_active: active,
    });
    await database.mergePulledRecords('maintenance_tasks', [
        ...suggested,
        repair(1, 'Stern gland weeping, repack before the passage to Opua', true),
        repair(2, 'Masthead tricolour flickering', false),
        {
            ...suggested[0],
            id: uuid('3c3c3c3c', 103),
            title: 'Antifoul the hull at the haul-out in Whangārei',
            description: 'Two coats, extra on the waterline and the keel leading edge.',
            category: 'Hull',
            trigger_type: 'annual',
            interval_value: 365,
            next_due_date: isoDay(120),
            is_active: false,
        },
    ]);
}

async function seedStores() {
    localStorage.setItem(authScopedStorageKey('thalassa_inventory_deduped', getAuthIdentityScope()), '1');
    await database.updateSyncMeta({ optionalTablesReadAt: { stores_boxes: AT } });
    const stores: [string, string, number, number, string, string][] = [
        ['Raw-water impeller', 'Engine', 3, 2, 'Engine room', 'Spares box 3'],
        ['Fuel filter element, secondary', 'Engine', 1, 2, 'Engine room', 'Spares box 3'],
        ['Hose clamp 40 mm', 'Plumbing', 12, 4, 'Lazarette', 'Bin B'],
        ['Fusibles lame 15 A', 'Electrical', 10, 5, 'Nav desk', 'Drawer 2'],
        ['Shackle, galvanised 10 mm', 'Deck', 4, 2, 'Cockpit locker', 'Port side'],
        ['Flares, handheld red', 'Safety', 6, 4, 'Grab bag', ''],
        ['Paracetamol 500 mg', 'Medical', 2, 1, 'Heads', 'First-aid box'],
        ['Tinned chickpeas', 'Pantry', 14, 6, 'Saloon', 'Under-berth starboard'],
        ['Long-life milk', 'Dry', 8, 4, 'Saloon', 'Under-berth port'],
        ['味噌', 'Fridge', 1, 1, 'Galley', 'Fridge'],
    ];
    await database.mergePulledRecords(
        'inventory_items',
        stores.map(([name, category, quantity, min, zone, spot], i) => ({
            ...own,
            id: uuid('4b4b4b4b', i + 1),
            barcode: null,
            item_name: name,
            description: null,
            category,
            quantity,
            min_quantity: min,
            unit: 'whole',
            location_zone: zone,
            location_specific: spot,
            expiry_date: null,
            box_id: null,
        })),
    );
}

async function seedChecklists() {
    const lists: [string, string[]][] = [
        ['Pre-start', ['Engine oil level', 'Raw-water seacock open', 'Fuel on', 'Battery switch to house']],
        [
            'Leaving the mooring at Ponta Delgada',
            ['Shore power off and stowed', 'Lines singled up', 'VHF on channel 16', 'Fenders in once clear'],
        ],
    ];
    const rows: (ChecklistEntry & { user_id: string })[] = [];
    let order = 0;
    lists.forEach(([heading, items], h) => {
        const headingId = uuid('5a5a5a5a', (h + 1) * 100);
        rows.push({ ...own, id: headingId, type: 'heading', text: heading, heading_id: null, order: order++ });
        items.forEach((text, i) =>
            rows.push({
                ...own,
                id: uuid('5a5a5a5a', (h + 1) * 100 + i + 1),
                type: 'detail',
                text,
                heading_id: headingId,
                order: order++,
            }),
        );
    });
    await database.mergePulledRecords('checklists', rows);
}

const SEED: Record<Binder, () => Promise<void>> = {
    equipment: seedEquipment,
    documents: seedDocuments,
    maintenance: seedMaintenance,
    stores: seedStores,
    checklists: seedChecklists,
};
await SEED[binder]();

const PAGES: Record<Binder, () => Promise<React.FC<{ onBack: () => void }>>> = {
    equipment: async () => (await import('../../components/vessel/EquipmentList')).EquipmentList,
    documents: async () => (await import('../../components/vessel/DocumentsHub')).DocumentsHub,
    maintenance: async () => (await import('../../components/vessel/MaintenanceHub')).MaintenanceHub,
    stores: async () => (await import('../../components/vessel/InventoryList')).InventoryList,
    checklists: async () => (await import('../../components/vessel/ChecklistsPage')).ChecklistsPage,
};
const Page = await PAGES[binder]();

/**
 * App.tsx's header on a portrait phone (showHeader), with App.tsx's own
 * classes, as e2e/fixtures/skipper-takeover.tsx copies it: the 64 px mark (48
 * under 390), the wordmark and the SKIPPER · BETA badge every skipper sees
 * while the public beta is on (PUBLIC_BETA_ACCESS), the tagline and the 48 px
 * status button. In Verdana the badge wraps under the wordmark, and the
 * header is 19 px taller at 320 px and 18 at 375 than without it (86 and 91
 * px): every page here is measured under that, as a skipper's phone draws
 * it. Only the top pad is inline: max(1rem, the device's top inset).
 */
const AppHeader: React.FC = () => (
    <header
        data-testid="app-header"
        className="px-4 md:px-6 flex flex-col justify-between pointer-events-none shrink-0 py-2"
        style={{ paddingTop: `max(1rem, ${insetTop}px)`, gap: '8px' }}
    >
        <div className="flex items-start justify-between gap-2 pointer-events-auto shrink-0">
            <div className="flex min-w-0 items-center space-x-2">
                <img
                    src="/thalassa-icon-128.png"
                    alt=""
                    width={64}
                    height={64}
                    className="thalassa-header-logo w-[64px] h-[64px] max-[389px]:w-12 max-[389px]:h-12 rounded-lg"
                />
                <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
                        <p className="shrink-0 whitespace-nowrap text-xl font-bold tracking-wider uppercase shadow-black drop-shadow-lg">
                            Thalassa
                        </p>
                        <span className="thalassa-beta-badge flex shrink-0 items-center whitespace-nowrap rounded-sm border border-amber-300/30 bg-amber-400/15 px-1.5 py-0.5 text-amber-100 shadow-lg">
                            <span className="text-[11px] font-bold uppercase leading-none tracking-wider">
                                Skipper
                                <span className="font-semibold text-amber-200/70"> · Beta</span>
                            </span>
                        </span>
                    </div>
                    <p className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px] uppercase tracking-widest text-sky-200 shadow-black drop-shadow-md">
                        <span className="min-w-0 flex-1 truncate">Keeps watch with you</span>
                    </p>
                </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 pointer-events-auto">
                <span
                    aria-hidden="true"
                    className="relative w-12 h-12 rounded-2xl border border-white/10 bg-slate-900/90"
                />
            </div>
        </div>
    </header>
);

/**
 * The real tab bar's geometry (App.tsx): fixed, z-900, a 4rem row above the
 * home-indicator inset. That inset is env(), as the pages' own bottom padding
 * is, so both are 0 here; the specs add a phone's inset to what they measure.
 */
const TabBar: React.FC = () => (
    <nav
        aria-label="Main"
        className="fixed bottom-0 left-0 right-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
        style={{ background: 'rgb(10, 15, 20)', borderColor: 'rgba(56, 189, 248, 0.12)' }}
    >
        <div className="flex justify-around items-center h-16 mx-auto px-4 text-xs font-bold text-slate-300">
            <span>THE GLASS</span>
            <span>OBS</span>
            <span>PLAN</span>
            <span>LOG</span>
            <span className="text-sky-300">VESSEL</span>
        </div>
    </nav>
);

function Fixture() {
    return (
        <div className="relative h-dvh w-full overflow-hidden font-sans flex flex-col bg-slate-950 text-white">
            <AppHeader />
            <main id="main-content" className="grow relative flex flex-col overflow-hidden pt-0">
                <div className="relative flex-1 overflow-hidden">
                    {/* App.tsx's page frame on a phone: the page pads its own bottom. */}
                    <div className="absolute inset-0">
                        <Page onBack={() => undefined} />
                    </div>
                </div>
            </main>
            <TabBar />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
(window as unknown as { __binderSheetsReady?: boolean }).__binderSheetsReady = true;
