/**
 * Skipper takeover fixture (build 125, 125-12): the Log page's "Recording, not
 * publishing" notice with its in-place takeover, and the Vessel page's skipper
 * card — with the Pi primary, the state Shane was in at the marina on
 * 2026-10-09, where the card had no button at all.
 *
 * The real components and CSS (LogPageHeader, SkipperClaimNotice,
 * SkipperDeviceControl, the Vessel hub's container tiers in
 * styles/menu-page-fit.css) under a copy of App.tsx's header and tab bar, so a
 * fit is measured against the real chrome. No account, network or boat: the
 * claim, the signed-in user and "the Pi is primary" are set by hand, and a
 * takeover stays in this page. Every device name and id is fictional.
 *
 * ?view=log|vessel  ?claim=forgotten|live|long|mine|none  ?pi=1|0  ?insetTop=20
 */
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';

if (!import.meta.env.DEV)
    throw new Error('The skipper-takeover fixture is available only through the development server.');

// Isolation BEFORE any application service loads: no network at all.
window.fetch = async () =>
    new Response(JSON.stringify({ error: 'Skipper takeover fixture: network disabled.' }), { status: 503 });
localStorage.clear();
localStorage.setItem('thalassa_device_id', 'dev-fictional-this-phone-9f3a');

const params = new URLSearchParams(location.search);
const view = params.get('view') === 'vessel' ? 'vessel' : 'log';
const piPrimary = params.get('pi') === '1';
const insetTop = Number(params.get('insetTop') ?? 20);
const insetBottom = Number(params.get('insetBottom') ?? 0);
const now = Date.now();
const DAY = 24 * 3_600_000;
const CLAIMS = {
    // The one Shane met: an install that no longer exists, claimed 32 days ago.
    forgotten: {
        deviceId: 'dev-fictional-old-install-7e1a',
        deviceName: 'iPhone/iPad · 7e1a',
        claimedAt: new Date(now - 32 * DAY).toISOString(),
    },
    // A holder seen recently: a real second device, so the takeover asks.
    live: {
        deviceId: 'dev-fictional-tablet-77c1',
        deviceName: 'iPad · 77c1',
        claimedAt: new Date(now - 40 * DAY).toISOString(),
        lastSeenAt: new Date(now - 20 * 60_000).toISOString(),
    },
    // A long, fictional, renamed device: the one-line rows must truncate.
    long: {
        deviceId: 'dev-fictional-tablet-77c1',
        deviceName: 'Wandering Albatross of Port Moselle iPad · 77c1',
        claimedAt: new Date(now - 40 * DAY).toISOString(),
        lastSeenAt: new Date(now - 3 * 3_600_000).toISOString(),
    },
    mine: {
        deviceId: 'dev-fictional-this-phone-9f3a',
        deviceName: 'iPhone · 9f3a',
        claimedAt: new Date(now - DAY).toISOString(),
    },
    none: null,
} as const;
const claimKey = (params.get('claim') ?? 'forgotten') as keyof typeof CLAIMS;
const claim = CLAIMS[claimKey] ?? CLAIMS.forgotten;

const [{ setAuthIdentityScope }, { awaitSettingsLoaded, useSettingsStore }, { useAuthStore }, telemetry] =
    await Promise.all([
        import('../../services/authIdentityScope'),
        import('../../stores/settingsStore'),
        import('../../stores/authStore'),
        import('../../services/CloudTelemetryService'),
    ]);
// The auth store signs the page out at import (no session here) and reloads
// settings for that scope; let it finish before this fixture signs in.
await new Promise<void>((resolve) => {
    if (useAuthStore.getState().authChecked) return resolve();
    const stop = useAuthStore.subscribe((state) => {
        if (!state.authChecked) return;
        stop();
        resolve();
    });
});
await awaitSettingsLoaded();
setAuthIdentityScope('fixture-skipper');
await awaitSettingsLoaded();
// Signed in, recording with live share on, and the claim under test. A
// takeover writes the store and nothing else.
useAuthStore.setState({ user: { id: 'fixture-skipper' } as never, authChecked: true });
useSettingsStore.setState({
    settings: { ...useSettingsStore.getState().settings, liveTrackShare: true, skipperDevice: claim ?? undefined },
    updateSettings: async (patch) => {
        useSettingsStore.setState((state) => ({ settings: { ...state.settings, ...patch } }));
    },
});
// The Pi reporting to the cloud a moment ago, without a cloud.
telemetry.CloudTelemetryService.retain = () => undefined;
telemetry.CloudTelemetryService.release = () => undefined;
telemetry.CloudTelemetryService.piIsPrimary = () => piPrimary;

const [{ LogPageHeader }, { SkipperClaimNotice }, { SkipperDeviceControl }] = await Promise.all([
    import('../../pages/log/LogPageHeader'),
    import('../../pages/log/SkipperClaimNotice'),
    import('../../components/VesselHub'),
]);

/** App.tsx's header on a portrait phone (showHeader), with App.tsx's own
 *  classes, as e2e/fixtures/diary-compose.tsx copies it: the 64 px mark (48
 *  under 390), the wordmark and badge, the tagline and the 48 px status button.
 *  Only the top pad is inline: max(1rem, the device's top inset). */
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

/** The real tab bar's geometry (App.tsx): fixed, z-900, a 4rem row above the
 *  home-indicator inset, opaque. */
const TabBar: React.FC = () => (
    <nav
        aria-label="Main"
        className="fixed bottom-0 left-0 right-0 z-900 border-t"
        style={{ background: 'rgb(10, 15, 20)', borderColor: 'rgba(56, 189, 248, 0.12)', paddingBottom: insetBottom }}
    >
        <div className="flex justify-around items-center h-16 mx-auto px-4 text-xs font-bold text-slate-300">
            <span>THE GLASS</span>
            <span>OBS</span>
            <span>PLAN</span>
            <span className={view === 'log' ? 'text-sky-300' : ''}>LOG</span>
            <span className={view === 'vessel' ? 'text-sky-300' : ''}>VESSEL</span>
        </div>
    </nav>
);

function LogView() {
    const trigger = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    const close = useRef<HTMLButtonElement>(null);
    const [showMenu, setShowMenu] = useState(false);
    return (
        <div className="relative h-full bg-slate-950 overflow-hidden">
            <div className="flex min-h-0 flex-col h-full">
                <LogPageHeader
                    isTracking
                    gpsStatus="locked"
                    hasRecordedFix
                    gpsHeadline="Recording"
                    overflowTriggerRef={trigger}
                    overflowMenuRef={menu}
                    overflowCloseRef={close}
                    overflowMenuId="fixture-log-menu"
                    showMenu={showMenu}
                    setShowMenu={setShowMenu}
                    closeOverflowMenu={() => setShowMenu(false)}
                    dispatch={() => undefined}
                    loggedVoyages={[]}
                    loggedEntries={[]}
                />
                <SkipperClaimNotice isTracking />
                <div data-testid="log-below-notice" className="mx-4 h-16 shrink-0 rounded-2xl border border-white/10" />
            </div>
        </div>
    );
}

function VesselView() {
    const skipperClaim = useSettingsStore((state) => state.settings.skipperDevice) ?? null;
    const updateSettings = useSettingsStore((state) => state.updateSettings);
    return (
        <div
            className="vessel-hub-surface w-full h-full flex flex-col vessel-hub-no-scrollbar vessel-hub-home"
            style={{ paddingBottom: `calc(4rem + ${insetBottom}px + 8px)` }}
        >
            <section className="vessel-hub-deck relative z-20 shrink-0 px-4 pt-4 pb-1">
                <div className="h-16 rounded-2xl border border-white/10" aria-hidden="true" />
            </section>
            <div className="flex-1 min-h-0 overflow-y-auto vessel-hub-no-scrollbar px-4 pt-2 pb-2 vessel-hub-port">
                <SkipperDeviceControl
                    claim={skipperClaim}
                    authenticatedUserId="fixture-skipper"
                    updateSettings={(patch) => void updateSettings(patch)}
                    vesselName="Wandering Albatross of Port Moselle"
                />
            </div>
        </div>
    );
}

function Fixture() {
    const holder = useSettingsStore((state) => state.settings.skipperDevice?.deviceId ?? 'none');
    return (
        <div className="relative h-dvh w-full overflow-hidden font-sans flex flex-col bg-slate-950 text-white">
            <AppHeader />
            <main id="main-content" className="grow relative flex flex-col overflow-hidden bg-slate-950 pt-0">
                <div className="relative flex-1 overflow-hidden">{view === 'log' ? <LogView /> : <VesselView />}</div>
            </main>
            <output data-testid="claim-holder" className="sr-only">
                {holder}
            </output>
            <TabBar />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
