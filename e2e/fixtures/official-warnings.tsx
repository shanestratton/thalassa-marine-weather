/**
 * Official warnings in the app (129-06), rendered for real: the Warnings page
 * (components/WarningDetails.tsx with its official section), Settings →
 * Alerts (components/settings/AlertsTab.tsx under the settings page header,
 * with the official and cyclone switches shown) and the Glass's warnings row
 * (components/dashboard/CompactHeaderRow.tsx with the official chip, fed by
 * the real useOfficialWarnings hook).
 *
 * official_alerts_at answers from tests/fixtures/official-alerts/rpc-answers.json
 * (fictional; ?state= picks one, times shifted to now), and the two watcher
 * status calls answer "ran just now". ?state=absent answers as the function
 * not deployed. Every other request fails here: no network.
 *
 *   ?view=page|alerts|glass  &state=inforce|partial|none|rtl|nearby|offzone|...  &forecast=1
 *   &pin=1       a tapped official push (fictional) the page's answer does not list
 *   &fonts=wide  the house fit rule's wide fonts
 *   &ahead=1     weather_alert_status answers as the look-ahead check (129-07), with
 *                fictional status lines; without it, nothing answers (not deployed)
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import { setAuthIdentityScope, subscribeAuthIdentityScope } from '../../services/authIdentityScope';

if (!import.meta.env.DEV)
    throw new Error('The official-warnings fixture is available only through the development server.');

// Official warnings and their status are for signed-in users; the app never asks
// signed out (release run 38517476280). The fixture is a signed-in skipper.
setAuthIdentityScope('fixture-skipper');
// The app's auth start-up finds no session here and fences to anonymous; this page
// models a signed-in skipper, so it signs the fixture user straight back in.
subscribeAuthIdentityScope((scope) => {
    if (!scope.userId) queueMicrotask(() => setAuthIdentityScope('fixture-skipper'));
});

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'page';
const state = params.get('state') ?? 'inforce';
if (params.get('fonts') === 'wide') {
    const wide = document.createElement('style');
    wide.textContent =
        ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; } body, button { font-family: Verdana, 'DejaVu Sans', sans-serif !important; }";
    document.head.append(wide);
}

type Answer = { lat: number; lon: number } & Record<string, unknown>;
const realFetch = window.fetch.bind(window);
const fixtures = (await (await realFetch('/tests/fixtures/official-alerts/rpc-answers.json')).json()) as {
    anchor: string;
    answers: Record<string, Answer>;
};
/** Every ISO time in the answer moved by the same amount, so the anchor is now. */
const shift = (value: unknown, by: number): unknown => {
    if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?Z$/.test(value)) {
        return new Date(Date.parse(value) + by).toISOString();
    }
    if (Array.isArray(value)) return value.map((v) => shift(v, by));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shift(v, by)]));
    }
    return value;
};
const answer = fixtures.answers[state] ?? fixtures.answers.inforce;
const now = new Date().toISOString();
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

window.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        location.href,
    );
    if (url.pathname.endsWith('/rest/v1/rpc/official_alerts_at')) {
        if (state === 'absent') return json({ code: 'PGRST202', message: 'Could not find the function' }, 404);
        return json(shift(answer, Date.now() - Date.parse(fixtures.anchor)));
    }
    if (url.pathname.endsWith('/rest/v1/rpc/official_alerts_watch_status')) return json([{ ran_at: now }]);
    if (url.pathname.endsWith('/rest/v1/rpc/cyclone_watch_status')) {
        return json([{ ran_at: now, unavailable_since: null }]);
    }
    if (url.pathname.endsWith('/rest/v1/rpc/weather_alert_status') && params.get('ahead') === '1') {
        return json([
            {
                version: 2,
                ran_at: now,
                basis: 'saved',
                lines: [
                    'Wind: models disagree: ECMWF 28 kt, ICON 14 kt, UKMO not shown (your limit 20 kt).',
                    'Seas: no wave model here.',
                    'Good window: 2 of 3 models agree (ECMWF, ICON), Thu 06:00–12:00.',
                ],
            },
        ]);
    }
    return json({ message: 'Official-warnings fixture: network disabled.' }, 503);
};

const [
    { WarningDetails },
    { AlertsTab },
    { CompactHeaderRow },
    { PageHeader },
    { useOfficialWarnings },
    { officialInForce },
    { pinOfficialPush },
] = await Promise.all([
    import('../../components/WarningDetails'),
    import('../../components/settings/AlertsTab'),
    import('../../components/dashboard/CompactHeaderRow'),
    import('../../components/ui/PageHeader'),
    import('../../hooks/useOfficialWarnings'),
    import('../../services/officialWarnings'),
    import('../../services/officialPushPin'),
]);

if (params.get('pin') === '1') {
    // As a lock-screen tap leaves it: a gale warning sent for the home port, not this page's place.
    pinOfficialPush(
        {
            notification_type: 'official_warning',
            provider: 'nws',
            identifier: 'urn:oid:2.49.0.1.840.0.zz0199.001.1',
            basis: 'home',
            event: 'Gale Warning',
            expires: new Date(Date.now() + 12 * 3_600_000).toISOString(),
        },
        {
            title: 'Gale Warning',
            body: 'Gale Warning issued October 14 at 5:40AM EDT until October 15 at 12:00AM EDT by NWS Zzharbor MD (fictional)\nWarnings: National Weather Service (NOAA)',
        },
    );
}

const notifications = {
    wind: { enabled: true, threshold: 20 },
    gusts: { enabled: false, threshold: 30 },
    waves: { enabled: false, threshold: 2 },
    swellPeriod: { enabled: false, threshold: 12 },
    visibility: { enabled: false, threshold: 1 },
    uv: { enabled: false, threshold: 8 },
    tempHigh: { enabled: false, threshold: 35 },
    tempLow: { enabled: false, threshold: 5 },
    precipitation: { enabled: false },
};
const where = { lat: answer.lat, lon: answer.lon };
const forecast =
    params.get('forecast') === '1' ? ['Forecast: gale-force wind, 34 kt+', 'Forecast: rough seas, 8 ft+ (2.4 m)'] : [];

function GlassRow() {
    const official = useOfficialWarnings(where);
    return (
        <CompactHeaderRow
            alerts={forecast}
            sunrise="06:12"
            sunset="18:31"
            moonPhase="🌔"
            moonPhaseName="Waxing Gibbous"
            onOpenSunMoon={() => undefined}
            officialCount={official ? officialInForce(official, Date.now()).length : null}
        />
    );
}

function Fixture() {
    if (view === 'alerts') {
        return (
            <main
                className={`flex ${params.has('tall') ? 'min-h-screen' : 'h-screen'} flex-col bg-slate-950 text-white`}
            >
                <div className="shrink-0 border-b border-white/5 bg-slate-950/90">
                    <PageHeader
                        title="Alerts"
                        subtitle="Thresholds and safety pushes"
                        breadcrumbs={['Settings', 'Alerts']}
                        onBack={() => undefined}
                        backLabel="Back to Settings"
                    />
                </div>
                <div data-testid="settings-scroll" className="min-h-0 flex-1 overflow-y-auto p-4 pb-20">
                    <AlertsTab
                        settings={
                            {
                                notifications,
                                units: {},
                                homePort: 'Zzbaytown (39.1, -76.4)',
                                defaultLocation: 'Zzbaytown',
                            } as unknown as React.ComponentProps<typeof AlertsTab>['settings']
                        }
                        onSave={() => undefined}
                    />
                </div>
                <TabBar />
            </main>
        );
    }
    if (view === 'glass') {
        // As Dashboard.tsx marks a short viewport: the row's trimmed 32 pt rhythm.
        return (
            <main
                data-glass-rhythm={window.innerHeight < 700 ? 'short' : undefined}
                className="min-h-screen bg-slate-950 px-4 pt-4 text-white"
            >
                <div data-testid="glass-row">
                    <GlassRow />
                </div>
                <TabBar />
            </main>
        );
    }
    // ?tall=1: the page grows to its content, for a whole-page screenshot.
    return (
        <main className={`${params.has('tall') ? 'min-h-screen' : 'h-screen'} bg-slate-950 text-white`}>
            <WarningDetails
                alerts={forecast}
                placeName="Zzbaytown"
                coordinates={where}
                locationType="coastal"
                checkedAt={new Date(Date.now() - 12 * 60_000).toISOString()}
                modelUsed="wx:ecmwf_ifs025"
            />
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
                <span className="text-sky-300">Weather</span>
                <span>Chart</span>
                <span>Vessel</span>
                <span>Crew</span>
            </div>
        </nav>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
