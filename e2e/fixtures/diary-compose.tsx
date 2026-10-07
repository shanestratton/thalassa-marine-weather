/**
 * Diary compose · layout fixture. The real DiaryComposeForm with the app's
 * CSS, against fictional content only. No login, GPS, persistence, media
 * drain or cloud service is mounted.
 *
 * With no query the layout spec's default (a typed entry, no trip picker,
 * no tab bar). Otherwise:
 *   ?scenario=new|edit  a fresh entry (date title, empty text, trips loading)
 *                       or an edited one (two photos, trips listed), with
 *                       the app's tab bar beneath
 *   &mode=dark|light|night  &busy=saving|polishing|uploading
 *   &trips=loading|ready|none  &pane=true
 *   &device=<key>       the real app chrome round the form for one of
 *                       DIARY_DEVICES (diary-compose-devices.ts): the THALASSA
 *                       header (App.tsx's own classes, its top pad
 *                       max(1rem, top inset)), the tab bar with its bottom
 *                       inset and, for the tablet, the split view's frame.
 *                       A browser has no notch, so env() is 0 here: the bottom
 *                       inset is laid under the form as padding, which takes
 *                       the same height off its column as the form's own
 *                       calc(4rem + env(safe-area-inset-bottom) + 8px) does
 *                       on the phone. &top=<px> / &bottom=<px> override.
 *   &photos=<0-6>       that many fictional photos
 *   &video=clip|missing a clip on the entry that plays (served beside this
 *                       page), or a saved clip that cannot be resolved
 *   &gps=acquiring|none no fix yet: still looking, or not looking
 *   &offline=true       the app offline (the header's Saved locally badge)
 *   &fonts=wide         the app's sans face swapped for Verdana (DejaVu Sans
 *                       on Linux): the Linux CI runner draws DejaVu Sans, far
 *                       wider than a Mac's system font, so a Mac run lays out
 *                       as CI does (CI run 37451031197 failed the fit there
 *                       while a Mac passed). It stands in for iOS Bold Text.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DiaryComposeForm } from '../../components/diary/DiaryComposeForm';
import type { DiaryMood } from '../../services/DiaryService';
import type { PolishStyle } from '../../types/settings';
import { useKeyboardOffset } from '../../hooks/useKeyboardOffset';
import { initGlobalKeyboardScroll } from '../../utils/keyboardScroll';
import { NIGHT_SCRIM_Z_INDEX } from '../../components/ui/OverlayPortal';
import { PanePortalScope } from '../../context/PanePortalContext';
import { DIARY_DEVICES, type DiaryDeviceKey } from './diary-compose-devices';
import { useUIStore } from '../../stores/uiStore';
import { formatEntryTitleDefault } from '../../utils/diaryTitle';
import { DiaryService } from '../../services/DiaryService';
import { getAuthIdentityScope, type AuthIdentityScope } from '../../services/authIdentityScope';
// The app's own CSS, in index.html's order: the iOS no-zoom rule (16 px in
// every field), then index.css.
import '../../styles/ios-input-zoom.css';
import '../../index.css';

const params = new URLSearchParams(window.location.search);
const scenario = params.get('scenario') as 'new' | 'edit' | null;
const mode = params.get('mode') ?? 'dark';
const busy = params.get('busy');
const trips = params.get('trips') ?? (scenario === 'edit' ? 'ready' : 'loading');
const device = DIARY_DEVICES[params.get('device') as DiaryDeviceKey] ?? null;
const insetTop = params.has('top') ? Number(params.get('top')) : (device?.top ?? 0);
const insetBottom = params.has('bottom') ? Number(params.get('bottom')) : (device?.bottom ?? 0);
const gps = params.get('gps');
const videoParam = params.get('video');
if (params.get('offline') === 'true') useUIStore.setState({ isOffline: true });
if (params.get('fonts') === 'wide') {
    const wide = document.createElement('style');
    wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
    document.head.append(wide);
}
document.documentElement.classList.toggle('display-light', mode === 'light');

/** Fictional "photos": two drawn gradients (raster, as SafeImage takes
 *  only raster data URLs), so no image leaves the page. */
const photo = (top: string, bottom: string) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 120;
    const ctx = canvas.getContext('2d')!;
    const sky = ctx.createLinearGradient(0, 0, 0, 120);
    sky.addColorStop(0, top);
    sky.addColorStop(1, bottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 120, 120);
    ctx.fillStyle = 'rgba(253, 230, 138, 0.85)';
    ctx.beginPath();
    ctx.arc(84, 44, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(12, 74, 110, 0.75)';
    ctx.fillRect(0, 88, 120, 32);
    return canvas.toDataURL('image/png');
};
const SCENARIO = {
    new: {
        isEditing: false,
        // The real default for this screen: the long form from 428 up, the
        // short one under it (utils/diaryTitle.ts).
        title: formatEntryTitleDefault(new Date(2026, 9, 6, 14, 32)),
        body: '',
        mood: 'epic' as DiaryMood,
        location: 'Airlie Beach, Queensland',
        coords: 'Boat · 20.1234°S, 148.1234°E',
        style: 'poetic' as PolishStyle,
        photos: [] as string[],
    },
    edit: {
        isEditing: true,
        title: 'Sunset at the anchorage',
        body: 'We picked up a mooring in the lee of the island. Turtles surfaced beside the boat while the kettle boiled, and the wind dropped right away at dusk.',
        mood: 'good' as DiaryMood,
        location: 'Sandy Cove',
        coords: 'Phone · 27.1234°S, 153.1234°E',
        style: 'tidy' as PolishStyle,
        photos: [photo('#f59e0b', '#7c2d12'), photo('#38bdf8', '#0f172a')],
    },
};
const PHOTO_SKIES: [string, string][] = [
    ['#f59e0b', '#7c2d12'],
    ['#38bdf8', '#0f172a'],
    ['#a78bfa', '#1e1b4b'],
    ['#34d399', '#064e3b'],
    ['#fb7185', '#4c0519'],
    ['#fde68a', '#78350f'],
];
const photoCount = params.has('photos') ? Math.min(6, Math.max(0, Number(params.get('photos')))) : null;
/** A clip that really plays, served beside this page: diary-compose-clip.mp4,
 *  one second of plain blue at 64x36 with no sound, made with ffmpeg, so
 *  nothing personal is in it. It is registered as this device's own, so the
 *  real resolveVideoUrl hands it to the player as it would a synced clip. (The
 *  player now says when a clip will not load, so the old stand-in, a few bytes
 *  of text labelled video/mp4, showed no player at all.) */
function ownedFixtureClip() {
    const url = new URL('./diary-compose-clip.mp4', window.location.href).href;
    (DiaryService as unknown as { _registerMediaRef(ref: string, scope: AuthIdentityScope): void })._registerMediaRef(
        url,
        getAuthIdentityScope(),
    );
    return url;
}
const VIDEO_PRESET =
    videoParam === 'clip'
        ? ownedFixtureClip()
        : videoParam === 'missing'
          ? 'storage:diary-video:fixture-someone-else/missing.mp4'
          : null;

/** The app header on every page but the chart (App.tsx, showHeader), with
 *  App.tsx's own classes: for a portrait page the 64 px mark (48 under 390),
 *  the THALASSA wordmark with its SKIPPER · BETA badge, the tagline and the
 *  48 px System status button; on a phone on its side (isMobileLandscape) one
 *  row, the 40 px mark, no tagline. Only the top pad is inline: the device's
 *  max(1rem, top inset), or max(0.5rem, top inset) on its side. */
const AppHeader: React.FC<{ landscape: boolean }> = ({ landscape }) => (
    <header
        data-testid="app-header"
        className={`px-4 md:px-6 flex flex-col justify-between pointer-events-none shrink-0 ${landscape ? 'py-1' : 'py-2'}`}
        style={{ paddingTop: `max(${landscape ? '0.5rem' : '1rem'}, ${insetTop}px)`, gap: '8px' }}
    >
        <div className="flex items-start justify-between gap-2 pointer-events-auto shrink-0">
            <div className="flex min-w-0 items-center space-x-2">
                <img
                    src="/thalassa-icon-128.png"
                    alt=""
                    width={64}
                    height={64}
                    className={`thalassa-header-logo ${landscape ? 'w-10 h-10' : 'w-[64px] h-[64px] max-[389px]:w-12 max-[389px]:h-12'} rounded-lg`}
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
                    <p
                        className={`flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px] uppercase tracking-widest text-sky-200 shadow-black drop-shadow-md ${landscape ? 'hidden' : ''}`}
                    >
                        <span className="min-w-0 flex-1 truncate">Keeps watch with you</span>
                    </p>
                </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 pointer-events-auto">
                <div className="flex flex-col items-end gap-1">
                    <span
                        aria-hidden="true"
                        className="relative w-12 h-12 rounded-2xl border border-white/10 bg-slate-900/90"
                    />
                </div>
            </div>
        </div>
    </header>
);

// Match the existing keyboard fixture: native keyboards are unavailable in
// browser automation, so publish a real resize event on a modeled visual
// viewport. The app's actual keyboard measurement and scroll guard still run.
const viewport = new EventTarget();
let keyboardHeight = 0;
Object.assign(viewport, { height: window.innerHeight, offsetTop: 0, scale: 1 });
Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
const keyboardCover = document.createElement('div');
keyboardCover.dataset.testid = 'keyboard-cover';
keyboardCover.textContent = 'Keyboard (simulated)';
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
function resizeViewport() {
    Object.assign(viewport, { height: window.innerHeight - keyboardHeight });
    keyboardCover.style.height = `${keyboardHeight}px`;
    keyboardCover.style.display = keyboardHeight ? 'block' : 'none';
    viewport.dispatchEvent(new Event('resize'));
}
window.addEventListener('test:keyboard', ((event: CustomEvent<number>) => {
    keyboardHeight = event.detail;
    resizeViewport();
}) as EventListener);
window.addEventListener('resize', resizeViewport);
initGlobalKeyboardScroll();

function Fixture() {
    const preset = scenario ? SCENARIO[scenario] : null;
    const [title, setTitle] = useState(preset?.title ?? 'Wednesday at anchor');
    const [body, setBody] = useState(
        preset?.body ?? 'We tucked into the bay before sunset. The water was calm and the crew was happy.',
    );
    const [mood, setMood] = useState<DiaryMood>(preset?.mood ?? 'epic');
    const [location, setLocation] = useState(preset?.location ?? 'Moreton Bay');
    const [style, setStyle] = useState<PolishStyle>(preset?.style ?? 'clean');
    const [photos, setPhotos] = useState<string[]>(() =>
        photoCount === null
            ? (preset?.photos ?? [])
            : Array.from({ length: photoCount }, (_, i) => photo(...PHOTO_SKIES[i % PHOTO_SKIES.length])),
    );
    const [trip, setTrip] = useState(scenario === 'edit' ? 'fixture-trip' : '');
    const [video, setVideo] = useState<string | null>(VIDEO_PRESET);
    const offset = useKeyboardOffset();
    const pane = params.get('pane') === 'true' || !!device?.pane;
    const paneFrameRef = useRef<HTMLDivElement>(null);
    useEffect(
        () => () => {
            if (video?.startsWith('blob:')) URL.revokeObjectURL(video);
        },
        [video],
    );

    const form = (
        <DiaryComposeForm
            isEditing={preset?.isEditing ?? false}
            title={title}
            body={body}
            mood={mood}
            photos={photos}
            audioUrl={null}
            videoUrl={video}
            locationName={location}
            keyboardHeight={offset}
            saving={busy === 'saving'}
            uploading={busy === 'uploading'}
            polishing={busy === 'polishing'}
            gpsLoading={gps === 'acquiring'}
            coordsLabel={gps ? null : (preset?.coords ?? '27.1234°S, 153.1234°E')}
            polishStyle={style}
            tripPicker={
                scenario
                    ? {
                          value: trip,
                          choices:
                              trips === 'ready'
                                  ? [
                                        { voyageId: 'fixture-trip', label: 'Sat 3 Oct · 18.4 nm' },
                                        { voyageId: 'fixture-trip-2', label: 'Thu 1 Oct · 6.2 nm' },
                                    ]
                                  : [],
                          originalVoyageId: scenario === 'edit' ? 'fixture-trip' : null,
                          originalLabel: scenario === 'edit' ? 'Current trip' : 'Active recording',
                          disabled: false,
                          loading: trips === 'loading',
                          unavailable: trips === 'none',
                          onChange: setTrip,
                      }
                    : undefined
            }
            onSetTitle={setTitle}
            onSetBody={setBody}
            onSetMood={setMood}
            onSetLocationName={setLocation}
            onSetPolishStyle={setStyle}
            onSave={() => {
                throw new Error('Layout fixture must not save a diary');
            }}
            onCancel={() => {}}
            onPolish={() => {}}
            onPhotoSelect={() => {}}
            onPhotoRemove={(index) => setPhotos((list) => list.filter((_, i) => i !== index))}
            onVideoSelect={(event) => {
                const file = event.target.files?.[0];
                if (file) setVideo(URL.createObjectURL(file));
                event.target.value = '';
            }}
            onVideoRemove={() => setVideo(null)}
        />
    );
    const surface = mode === 'light' ? 'bg-slate-200 text-slate-900' : 'bg-slate-950 text-white';

    // The real tab bar's geometry (App.tsx): fixed, z-900, 4rem above the
    // home indicator. The form keeps its own foot clear of it. On a phone on
    // its side the bar is folded into App.tsx's toggle, bottom left (its
    // renderLandscapeNavToggle classes); the form keeps the same allowance,
    // which clears the toggle too.
    const landscape = !!device?.landscape;
    const tabBar = landscape ? (
        <nav aria-label="Main" data-testid="app-bottom-nav">
            <button
                type="button"
                aria-label="Log, show navigation"
                className="press fixed bottom-3 z-901 flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-2xl border border-white/8 bg-slate-900/90 pl-2.5 pr-3 text-white"
                style={{ left: '1rem', marginBottom: `${insetBottom}px` }}
            >
                <span className="whitespace-nowrap text-[12px] font-black uppercase tracking-wider">Log</span>
            </button>
        </nav>
    ) : (
        (scenario || device) && (
            <nav
                aria-label="Main"
                data-testid="app-bottom-nav"
                className="fixed right-0 bottom-0 left-0 z-900 border-t"
                style={{
                    background: mode === 'light' ? '#f8fafc' : 'rgb(10, 15, 20)',
                    borderColor: 'rgba(56, 189, 248, 0.12)',
                    paddingBottom: `${insetBottom}px`,
                }}
            >
                <div className="mx-auto flex h-16 items-center justify-around px-4 text-xs font-bold text-slate-400">
                    <span>The Glass</span>
                    <span>Obs</span>
                    <span>Plan</span>
                    <span>Log</span>
                    <span className="text-sky-400">Vessel</span>
                </div>
            </nav>
        )
    );
    const scrim = mode === 'night' && (
        <div
            aria-hidden="true"
            className="pointer-events-none fixed inset-0"
            data-testid="night-scrim"
            style={{ backgroundColor: 'rgba(69, 10, 10, 0.25)', zIndex: NIGHT_SCRIM_Z_INDEX }}
        />
    );

    if (device) {
        // App.tsx's chain for a registered page: the h-dvh flex column, the
        // header, the page area, and the page's own h-full scroller. The
        // inset under the form stands in for env(safe-area-inset-bottom).
        // With the keyboard up the form pads by the keyboard alone, as on
        // the phone, so the inset goes too.
        const page = (
            <div
                className="h-full overflow-y-auto overflow-x-hidden"
                style={{ paddingBottom: offset > 0 ? 0 : `${insetBottom}px` }}
            >
                {form}
            </div>
        );
        return (
            <div
                className={`relative h-dvh w-full overflow-hidden font-sans flex flex-col ${surface}`}
                data-mode={mode}
                data-device={params.get('device')}
            >
                <AppHeader landscape={landscape} />
                <main id="main-content" className="grow relative flex flex-col overflow-hidden">
                    {pane ? (
                        // The split view (App.tsx): the Glass on the left, the page
                        // in a framed pane that already clears the tab bar; the page
                        // surface overhangs the frame by the tab bar allowance, so
                        // the form's own clearance lands at the frame's bottom.
                        <div
                            className="relative flex flex-1 gap-2 overflow-hidden bg-black p-2"
                            style={{ paddingBottom: `calc(4rem + ${insetBottom}px + 0.5rem)` }}
                        >
                            <section
                                data-split-pane="glass"
                                className="relative h-full min-w-0 flex-1 overflow-hidden rounded-2xl border border-cyan-400/50 bg-slate-950 p-4 text-sm"
                            >
                                The Glass (other pane)
                            </section>
                            <PanePortalScope enabled paneId="page" frameRef={paneFrameRef}>
                                <div
                                    ref={paneFrameRef}
                                    data-split-pane="page"
                                    data-testid="diary-compose-shell"
                                    className="relative h-full min-w-0 flex-1 overflow-hidden rounded-2xl border border-white/25 bg-slate-950"
                                >
                                    <div
                                        className="absolute inset-x-0 top-0"
                                        style={{ height: `calc(100% + 4.5rem + ${insetBottom}px)` }}
                                    >
                                        {page}
                                    </div>
                                </div>
                            </PanePortalScope>
                        </div>
                    ) : (
                        <div className="relative flex-1 overflow-hidden">
                            <div className="absolute inset-0" data-testid="diary-compose-shell">
                                {page}
                            </div>
                        </div>
                    )}
                </main>
                {tabBar}
                {scrim}
            </div>
        );
    }

    // DiaryPage renders compose directly into its available full-height page.
    return (
        <main className={`h-full overflow-hidden ${surface}`} data-mode={mode}>
            {pane && <aside className="absolute inset-y-0 left-0 w-1/2 bg-slate-900">Other tablet pane</aside>}
            <section
                className={`relative h-full overflow-hidden ${pane ? 'ml-auto w-1/2' : 'w-full'}`}
                data-split-pane={pane ? 'diary' : undefined}
                data-testid="diary-compose-shell"
            >
                {form}
            </section>
            {tabBar}
            {scrim}
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
