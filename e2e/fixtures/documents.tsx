/**
 * Documents · layout fixture (126-B3b). The real DocumentsHub with the app's
 * CSS under a copy of App.tsx's header and tab bar, over the real local
 * database and the real vault (the browser's Filesystem), so each card's
 * "On this phone" / "Needs signal to open" line and the ⋮ menu's "Share or
 * save selected" are measured against the real chrome and index.css.
 *
 * No account, network or boat: the skipper is signed in by hand, every fetch
 * is refused here (so Storage never answers and nothing downloads), storage
 * is page-only, and every paper is fictional: the Kestrel's papers from
 * Horta, Lyttelton and Papeete, in Portuguese, Greek, Japanese and English.
 *
 * ?mode=dark|light|night (light is the app's daylight theme; night is dark
 * under the red scrim)  &insetTop=20  &insetBottom=0
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';

if (!import.meta.env.DEV) throw new Error('The documents fixture is available only through the development server.');

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
    new Response(JSON.stringify({ error: 'Documents fixture: network disabled.' }), { status: 503 });

const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'light' ? 'light' : params.get('mode') === 'night' ? 'night' : 'dark';
const insetTop = Number(params.get('insetTop') ?? 20);
const insetBottom = Number(params.get('insetBottom') ?? 0);
document.documentElement.classList.toggle('display-light', mode === 'light');

const SKIPPER = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';
const AT = '2026-10-09T01:00:00.000Z';
const day = 86_400_000;
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);

const [{ setAuthIdentityScope }, { useAuthStore }, database] = await Promise.all([
    import('../../services/authIdentityScope'),
    import('../../stores/authStore'),
    import('../../services/vessel/LocalDatabase'),
]);
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

const [vault, { DocumentsHub }, { NIGHT_SCRIM_Z_INDEX }] = await Promise.all([
    import('../../services/vessel/vaultFiles'),
    import('../../components/vessel/DocumentsHub'),
    import('../../components/ui/OverlayPortal'),
]);

type Category = 'Registration' | 'Insurance' | 'Crew Visas/IDs' | 'Radio/MMSI' | 'Customs Clearances' | 'User Manuals';

function row(id: string, name: string, category: Category, fileUri: string | null, expiry: string | null = null) {
    return {
        id,
        user_id: SKIPPER,
        document_name: name,
        category,
        issue_date: null,
        expiry_date: expiry,
        file_uri: fileUri,
        notes: null,
        created_at: AT,
        updated_at: AT,
    };
}

async function pick(name: string): Promise<{ uri: string; bytes: number }> {
    const bytes = new TextEncoder().encode(`%PDF-1.7\n${name}\n`);
    const saved = await vault.saveAttachment(new File([bytes], `${name}.pdf`, { type: 'application/pdf' }));
    if (!saved.ok) throw new Error(`fixture: ${name} was not saved (${saved.reason})`);
    return saved;
}
const cloud = (id: string, ext = 'pdf') => `supabase-storage://vessel_vault/${SKIPPER}/documents/${id}.${ext}`;

// Filed on this phone: the file in the vault, the row naming it.
const registo = await pick('Registo de Propriedade');
await database.insertLocal(
    'ship_documents',
    row('1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', 'Registo de Propriedade', 'Registration', registo.uri, isoDay(400)),
);
await vault.recordLocalCopy('1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', registo.uri, registo.bytes);
const passport = await pick('Passport — Søren Holm');
await database.insertLocal(
    'ship_documents',
    row('2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', 'Passport — Søren Holm', 'Crew Visas/IDs', passport.uri, isoDay(12)),
);
await vault.recordLocalCopy('2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', passport.uri, passport.bytes);
// Filed on the iPad and opened here once with signal: a copy is kept.
const certificate = await pick('船舶検査証書');
await vault.recordLocalCopy('3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f', certificate.uri, certificate.bytes);
// Too big to back up: kept on this phone only, the row has no file.
const manual = await pick('Watermaker manual, Lyttelton service');
await database.insertLocal(
    'ship_documents',
    row('4d5e6f7a-8b9c-4d0e-9f2a-3b4c5d6e7f8a', 'Watermaker manual, Lyttelton service', 'User Manuals', null),
);
await vault.recordLocalCopy('4d5e6f7a-8b9c-4d0e-9f2a-3b4c5d6e7f8a', manual.uri, manual.bytes, { tooLarge: true });
// No file at all.
await database.insertLocal(
    'ship_documents',
    row('5e6f7a8b-9c0d-4e1f-8a3b-4c5d6e7f8a9b', 'Crew list, Papeete', 'Customs Clearances', null),
);
// The rest synced from the iPad, never opened here.
await database.mergePulledRecords('ship_documents', [
    row(
        '3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f',
        '船舶検査証書',
        'Registration',
        cloud('3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f'),
    ),
    row(
        '6f7a8b9c-0d1e-4f2a-9b4c-5d6e7f8a9b0c',
        'Πιστοποιητικό νηολόγησης',
        'Registration',
        cloud('6f7a8b9c-0d1e-4f2a-9b4c-5d6e7f8a9b0c', 'jpg'),
        isoDay(200),
    ),
    row(
        '7a8b9c0d-1e2f-4a3b-8c5d-6e7f8a9b0c1d',
        'Ship radio licence',
        'Radio/MMSI',
        cloud('7a8b9c0d-1e2f-4a3b-8c5d-6e7f8a9b0c1d'),
        isoDay(-3),
    ),
    row(
        '8b9c0d1e-2f3a-4b4c-9d6e-7f8a9b0c1d2e',
        'Hull insurance, Horta to Papeete',
        'Insurance',
        cloud('8b9c0d1e-2f3a-4b4c-9d6e-7f8a9b0c1d2e'),
        isoDay(25),
    ),
]);

/** App.tsx's header on a portrait phone, as e2e/fixtures/galley-scroll.tsx copies it. */
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

/** The real tab bar's geometry (App.tsx): fixed, z-900, a 4rem row above the home-indicator inset. */
const TabBar: React.FC = () => (
    <nav
        aria-label="Main"
        className="fixed bottom-0 left-0 right-0 z-900 border-t"
        style={{
            background: mode === 'light' ? '#f8fafc' : 'rgb(10, 15, 20)',
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
);

function Fixture() {
    return (
        <div
            className={`relative h-dvh w-full overflow-hidden font-sans flex flex-col ${
                mode === 'light' ? 'bg-slate-200 text-slate-900 display-light' : 'bg-slate-950 text-white'
            }`}
        >
            <AppHeader />
            <main id="main-content" className="grow relative flex flex-col overflow-hidden pt-0">
                <div className="relative flex-1 overflow-hidden">
                    <div className="absolute inset-0">
                        <DocumentsHub onBack={() => undefined} />
                    </div>
                </div>
            </main>
            <TabBar />
            {mode === 'night' && (
                <div
                    aria-hidden="true"
                    data-testid="night-scrim"
                    className="pointer-events-none fixed inset-0"
                    style={{ backgroundColor: 'rgba(69, 10, 10, 0.25)', zIndex: NIGHT_SCRIM_Z_INDEX }}
                />
            )}
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
(window as unknown as { __documentsFixtureReady?: boolean }).__documentsFixtureReady = true;
