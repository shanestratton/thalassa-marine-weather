/**
 * Settings → Preferences, rendered for real (129-08): components/settings/
 * GeneralTab.tsx under the settings page header, with the "If the boat goes
 * quiet" section fed by fictional answers to the calls it makes. No network:
 * every other request fails here.
 *
 *   ?state=absent  the watch's table and the crew call answer as not there
 *                  (the column probe fails): the section is hidden
 *          owner   the skipper's watch is on, its window Wed 19:30-19:50 in
 *                  Pacific/Auckland, and she has a Pi; only 125's watchdog
 *                  answers (no crew call), so the line is 125's
 *          new     no watch row yet, but her Pi reports: the switch is off
 *          crew    a crew member on two boats, Αύρα (watch on, paging) and
 *                  Kestrel (watch off): no boat of their own
 *          both    owner and crew at once (the longest section)
 *   &fonts=wide    the house fit rule's wide fonts
 *   &tall=1        the page grows to its content, for a whole-page picture
 *   &sat=1         satellite mode on: the line says the watch cannot hear her
 *
 * Writes to vessel_quiet_watch answer as PostgREST does under 125's grants
 * (20261009150000: UPDATE on the switch and window only, never owner_id): an
 * upsert (on_conflict, or Prefer resolution=merge-duplicates) is refused
 * 42501, an update of no row answers [], an insert over a row answers 23505.
 * window.__boatQuietWrites lists them for the spec.
 *
 * Fictional people and boats only: this repository is public.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';

if (!import.meta.env.DEV) throw new Error('The boat-quiet fixture is available only through the development server.');

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
Object.defineProperty(window, 'localStorage', { configurable: true, value: new FixtureStorage() });
Object.defineProperty(window, 'sessionStorage', { configurable: true, value: new FixtureStorage() });

const params = new URLSearchParams(location.search);
const state = params.get('state') ?? 'owner';
if (params.get('fonts') === 'wide') {
    const wide = document.createElement('style');
    wide.textContent =
        ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; } body, button { font-family: Verdana, 'DejaVu Sans', sans-serif !important; }";
    document.head.append(wide);
}

const SKIPPER = '00000000-0000-4000-8000-000000000129';
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const missingTable = () =>
    json(
        { code: 'PGRST205', message: "Could not find the table 'public.vessel_quiet_watch' in the schema cache" },
        404,
    );
const missingFunction = () => json({ code: 'PGRST202', message: 'Could not find the function' }, 404);

const owner = state === 'owner' || state === 'both';
const crew = state === 'crew' || state === 'both';
let watchRow: Record<string, unknown> | null = owner
    ? {
          owner_id: SKIPPER,
          enabled: true,
          quiet_after_minutes: 15,
          window_dow: 3,
          window_start: '19:30:00',
          window_end: '19:50:00',
          window_tz: 'Pacific/Auckland',
      }
    : null;
const writes: { method: string; onConflict: string | null; prefer: string; keys: string[] }[] = [];
(window as unknown as { __boatQuietWrites: typeof writes }).__boatQuietWrites = writes;
const crewBoats = crew
    ? [
          { owner_id: '00000000-0000-4000-8000-0000000000a1', boat_name: 'Αύρα', watch_on: true, paging_me: true },
          { owner_id: '00000000-0000-4000-8000-0000000000a2', boat_name: 'Kestrel', watch_on: false, paging_me: false },
      ]
    : [];

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        location.href,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.pathname.endsWith('/rest/v1/vessel_quiet_watch')) {
        if (state === 'absent') return missingTable();
        if (method === 'GET') return json(watchRow ? [watchRow] : []);
        const prefer = new Headers(init?.headers).get('Prefer') ?? '';
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        writes.push({
            method,
            onConflict: url.searchParams.get('on_conflict'),
            prefer,
            keys: Object.keys(body).sort(),
        });
        if (url.searchParams.has('on_conflict') || /merge-duplicates/.test(prefer)) {
            // INSERT ... ON CONFLICT DO UPDATE SET owner_id = EXCLUDED.owner_id, ...: no UPDATE grant on owner_id.
            return json({ code: '42501', message: 'permission denied for table vessel_quiet_watch' }, 403);
        }
        if (method === 'PATCH') {
            if ('owner_id' in body)
                return json({ code: '42501', message: 'permission denied for table vessel_quiet_watch' }, 403);
            if (!watchRow) return json([]);
            watchRow = { ...watchRow, ...body };
            return json([{ owner_id: watchRow.owner_id }]);
        }
        if (method === 'POST') {
            if (watchRow)
                return json({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409);
            watchRow = { quiet_after_minutes: 15, ...body };
            return new Response(null, { status: 201 });
        }
        return json({ message: 'Boat-quiet fixture: no such write.' }, 405);
    }
    if (url.pathname.endsWith('/rest/v1/vessel_telemetry')) {
        return json(state === 'owner' || state === 'new' || state === 'both' ? [{ source: 'pi' }] : []);
    }
    if (url.pathname.endsWith('/rest/v1/rpc/vessel_quiet_watch_crew_boats')) {
        if (state === 'absent' || state === 'owner' || state === 'new') return missingFunction();
        return json(crewBoats);
    }
    if (url.pathname.endsWith('/rest/v1/rpc/set_vessel_quiet_watch_crew_page')) return json(null, 204);
    return json({ message: 'Boat-quiet fixture: network disabled.' }, 503);
};

const [{ GeneralTab }, { PageHeader }, { setAuthIdentityScope }, { useAuthStore }, { DEFAULT_SETTINGS }] =
    await Promise.all([
        import('../../components/settings/GeneralTab'),
        import('../../components/ui/PageHeader'),
        import('../../services/authIdentityScope'),
        import('../../stores/authStore'),
        import('../../stores/settingsStore'),
    ]);

setAuthIdentityScope(SKIPPER);
useAuthStore.setState({ user: { id: SKIPPER } as never, authChecked: true });

const settings = {
    ...DEFAULT_SETTINGS,
    units: { speed: 'kts', distance: 'nm', waveHeight: 'm', length: 'm', tideHeight: 'm', temp: 'C' },
    defaultLocation: 'Zzharbour',
    satelliteMode: params.get('sat') === '1',
} as unknown as React.ComponentProps<typeof GeneralTab>['settings'];

function Fixture() {
    const tall = params.has('tall');
    return (
        <main className={`flex ${tall ? 'min-h-screen' : 'h-screen'} flex-col bg-slate-950 text-white`}>
            <div className="shrink-0 border-b border-white/5 bg-slate-950/90">
                <PageHeader
                    title="Preferences"
                    subtitle="Units, alarms and switches"
                    breadcrumbs={['Settings', 'Preferences']}
                    onBack={() => undefined}
                    backLabel="Back to Settings"
                />
            </div>
            <div data-testid="settings-scroll" className="min-h-0 flex-1 overflow-y-auto p-4 pb-20">
                <GeneralTab
                    settings={settings}
                    onSave={() => undefined}
                    onLocationSelect={() => undefined}
                    onDetectLocation={async () => false}
                    onShowFactoryReset={() => undefined}
                />
            </div>
            <TabBar />
        </main>
    );
}

/** The real tab bar's geometry (App.tsx): fixed, a 4rem row above the home-indicator inset, opaque. */
function TabBar() {
    return (
        <nav
            aria-label="Main"
            className="fixed bottom-0 left-0 right-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
            style={{ background: 'rgb(10, 15, 20)', borderColor: 'rgba(56, 189, 248, 0.12)' }}
        >
            <div className="flex h-16 items-center justify-around px-4 text-xs font-bold text-slate-300">
                <span>Weather</span>
                <span>Chart</span>
                <span className="text-sky-300">Vessel</span>
                <span>Crew</span>
            </div>
        </nav>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
