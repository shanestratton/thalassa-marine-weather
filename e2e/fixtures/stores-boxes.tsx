/**
 * Stores boxes · layout fixture (126-11a). The real Ship's Stores page
 * (InventoryList) with the app's CSS under a copy of App.tsx's header and tab
 * bar, over the real local database, so the Boxes list and the box page are
 * measured against the real chrome, the real ModalSheet and index.css.
 *
 * No account, network or boat: the skipper is signed in by hand, every fetch
 * is refused here, storage is page-only, and the server is taken to have
 * stores_boxes already (SyncMeta.optionalTablesReadAt). Everything is
 * fictional and global: the Kestrel's boxes in English, French, Spanish,
 * German and Greek, with spares labelled in English and Japanese.
 *
 * A real browser shows no mobile keyboard under automation: the visual
 * viewport is modelled (as e2e/fixtures/move-anchor.tsx does) with the real
 * app-wide keyboard guard; dispatch `test:keyboard` with a height.
 *
 * ?pane=true (the iPad split pane, 507 x 640, beside a companion page)
 * &insetTop=20  &insetBottom=0
 */
import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';

if (!import.meta.env.DEV) throw new Error('The stores-boxes fixture is available only through the development server.');

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
    new Response(JSON.stringify({ error: 'Stores-boxes fixture: network disabled.' }), { status: 503 });

const params = new URLSearchParams(location.search);
const pane = params.get('pane') === 'true';
const insetTop = Number(params.get('insetTop') ?? 20);
const insetBottom = Number(params.get('insetBottom') ?? 0);
/** Nothing in Stores yet (?empty=true): boxes set up before any item. */
const empty = params.get('empty') === 'true';

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

const SKIPPER = '2d4f6a8c-0e1b-4c3d-9e5f-7a9b1c3d5e7f';
const AT = '2026-10-10T01:00:00.000Z';

const [{ setAuthIdentityScope, authScopedStorageKey, getAuthIdentityScope }, { useAuthStore }, database, keyboard] =
    await Promise.all([
        import('../../services/authIdentityScope'),
        import('../../stores/authStore'),
        import('../../services/vessel/LocalDatabase'),
        import('../../utils/keyboardScroll'),
    ]);
keyboard.initGlobalKeyboardScroll();
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
localStorage.setItem(authScopedStorageKey('thalassa_inventory_deduped', getAuthIdentityScope()), '1');
await database.updateSyncMeta({ optionalTablesReadAt: { stores_boxes: AT } });

const boxId = (n: number) => `b0c1d2e3-f4a5-4b6c-8d7e-${String(n).padStart(12, '0')}`;
const BOXES: [string, string][] = [
    ['Engine room spares 3', 'Engine room'],
    ['Lazarette bin B', 'Lazarette'],
    ['Coffre avant', 'Pointe avant'],
    ['Pañol de proa, caja 2', 'Proa'],
    ['Achterkajüte Kiste 4', 'Achterkajüte'],
    ['Εργαλειοθήκη κόκπιτ', 'Κόκπιτ'],
    ["Bosun's locker crate", 'Cockpit locker, port side'],
    ['Under-berth starboard', 'Saloon'],
];
await database.mergePulledRecords(
    'stores_boxes',
    BOXES.map(([name, zone], index) => ({
        id: boxId(index + 1),
        user_id: SKIPPER,
        name,
        location_zone: zone,
        notes: null,
        created_at: AT,
        updated_at: AT,
    })),
);

const SPARES: [string, number, number, number][] = [
    ['Raw-water impeller', 3, 2, 1],
    ['Racor 2010PM filter', 1, 1, 1],
    ['Fuel filter element, secondary', 2, 1, 1],
    ['Alternator V-belt 13 x 1000', 2, 1, 1],
    ['Zinc anode, shaft 30 mm', 4, 2, 1],
    ['Heat exchanger gasket set', 1, 0, 1],
    ['Thermostat 71 °C', 1, 1, 1],
    ['Coolant hose 32 mm, 1 m', 2, 0, 1],
    ['Hose clamp 40 mm', 12, 4, 1],
    ['冷却水ポンプ ベルト', 2, 0, 2],
    ['Oil filter', 3, 2, 3],
];
await database.mergePulledRecords(
    'inventory_items',
    (empty ? [] : SPARES).map(([name, quantity, min, box], index) => ({
        id: `a0b1c2d3-e4f5-4a6b-8c7d-${String(index + 1).padStart(12, '0')}`,
        user_id: SKIPPER,
        barcode: null,
        item_name: name,
        description: null,
        category: 'Engine',
        quantity,
        min_quantity: min,
        unit: 'whole',
        location_zone: BOXES[box - 1][1],
        location_specific: BOXES[box - 1][0],
        expiry_date: null,
        box_id: boxId(box),
        created_at: AT,
        updated_at: AT,
    })),
);

const [{ InventoryList }, { PanePortalScope }] = await Promise.all([
    import('../../components/vessel/InventoryList'),
    import('../../context/PanePortalContext'),
]);

/** App.tsx's header on a portrait phone, as e2e/fixtures/documents.tsx copies it. */
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
                    <p className="shrink-0 whitespace-nowrap text-xl font-bold tracking-wider uppercase">Thalassa</p>
                    <p className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px] uppercase tracking-widest text-sky-200">
                        <span className="min-w-0 flex-1 truncate">Keeps watch with you</span>
                    </p>
                </div>
            </div>
            <span
                aria-hidden="true"
                className="relative w-12 h-12 rounded-2xl border border-white/10 bg-slate-900/90"
            />
        </div>
    </header>
);

function Fixture() {
    const frame = useRef<HTMLElement>(null);
    const stores = (
        <div className="relative flex-1 overflow-hidden">
            <div className="absolute inset-0">
                <InventoryList onBack={() => undefined} />
            </div>
        </div>
    );
    return (
        <div className="relative h-dvh w-full overflow-hidden font-sans flex flex-col bg-slate-950 text-white">
            {!pane && <AppHeader />}
            <main id="main-content" className="grow relative flex flex-col overflow-hidden pt-0">
                {pane ? (
                    <div className="flex min-h-0 w-full flex-1 gap-2 p-2">
                        <aside
                            className="min-w-0 flex-1 rounded-2xl bg-slate-900 p-4 text-slate-300"
                            aria-label="Companion pane"
                        >
                            The Glass (companion pane)
                        </aside>
                        <PanePortalScope enabled paneId="stores-boxes-fixture" frameRef={frame}>
                            <section
                                ref={frame}
                                data-split-pane="stores-boxes-fixture"
                                className="relative flex shrink-0 flex-col overflow-hidden rounded-2xl border border-white/25 bg-slate-950"
                                style={{ width: 507, height: 640 }}
                            >
                                {stores}
                            </section>
                        </PanePortalScope>
                    </div>
                ) : (
                    stores
                )}
            </main>
            {/* The real tab bar's geometry (App.tsx): fixed, z-900, a 4rem row above the home-indicator inset. */}
            <nav
                aria-label="Main"
                className="fixed bottom-0 left-0 right-0 z-900 border-t"
                style={{
                    background: 'rgb(10, 15, 20)',
                    borderColor: 'rgba(56, 189, 248, 0.12)',
                    paddingBottom: insetBottom,
                }}
            >
                <div className="flex justify-around items-center h-16 mx-auto px-4 text-xs font-bold text-slate-300">
                    <span>THE GLASS</span>
                    <span>OBS</span>
                    <span>PLAN</span>
                    <span>LOG</span>
                    <span className="text-sky-300">VESSEL</span>
                </div>
            </nav>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
(window as unknown as { __storesBoxesFixtureReady?: boolean }).__storesBoxesFixtureReady = true;
