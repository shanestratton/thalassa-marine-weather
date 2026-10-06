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
 */
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DiaryComposeForm } from '../../components/diary/DiaryComposeForm';
import type { DiaryMood } from '../../services/DiaryService';
import type { PolishStyle } from '../../types/settings';
import { useKeyboardOffset } from '../../hooks/useKeyboardOffset';
import { initGlobalKeyboardScroll } from '../../utils/keyboardScroll';
import { NIGHT_SCRIM_Z_INDEX } from '../../components/ui/OverlayPortal';
import '../../index.css';

const params = new URLSearchParams(window.location.search);
const scenario = params.get('scenario') as 'new' | 'edit' | null;
const mode = params.get('mode') ?? 'dark';
const busy = params.get('busy');
const trips = params.get('trips') ?? (scenario === 'edit' ? 'ready' : 'loading');
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
        title: 'Tuesday 6 October 2026 · 14:32',
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
    const [photos, setPhotos] = useState<string[]>(preset?.photos ?? []);
    const [trip, setTrip] = useState(scenario === 'edit' ? 'fixture-trip' : '');
    const [video, setVideo] = useState<string | null>(null);
    const offset = useKeyboardOffset();
    const pane = params.get('pane') === 'true';
    useEffect(
        () => () => {
            if (video) URL.revokeObjectURL(video);
        },
        [video],
    );

    // DiaryPage renders compose directly into its available full-height page.
    return (
        <main
            className={`h-full overflow-hidden ${
                mode === 'light' ? 'bg-slate-200 text-slate-900' : 'bg-slate-950 text-white'
            }`}
            data-mode={mode}
        >
            {pane && <aside className="absolute inset-y-0 left-0 w-1/2 bg-slate-900">Other tablet pane</aside>}
            <section
                className={`relative h-full overflow-hidden ${pane ? 'ml-auto w-1/2' : 'w-full'}`}
                data-split-pane={pane ? 'diary' : undefined}
                data-testid="diary-compose-shell"
            >
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
                    gpsLoading={false}
                    coordsLabel={preset?.coords ?? '27.1234°S, 153.1234°E'}
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
            </section>
            {/* The real tab bar's geometry (App.tsx): fixed, z-900, 4rem above
                the home indicator. The form keeps its own foot clear of it. */}
            {scenario && (
                <nav
                    aria-label="Main"
                    data-testid="app-bottom-nav"
                    className="fixed right-0 bottom-0 left-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
                    style={{
                        background: mode === 'light' ? '#f8fafc' : 'rgb(10, 15, 20)',
                        borderColor: 'rgba(56, 189, 248, 0.12)',
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
            )}
            {mode === 'night' && (
                <div
                    aria-hidden="true"
                    className="pointer-events-none fixed inset-0"
                    data-testid="night-scrim"
                    style={{ backgroundColor: 'rgba(69, 10, 10, 0.25)', zIndex: NIGHT_SCRIM_Z_INDEX }}
                />
            )}
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
