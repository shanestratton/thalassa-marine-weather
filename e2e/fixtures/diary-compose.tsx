import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DiaryComposeForm } from '../../components/diary/DiaryComposeForm';
import type { DiaryMood } from '../../services/DiaryService';
import type { PolishStyle } from '../../types/settings';
import { useKeyboardOffset } from '../../hooks/useKeyboardOffset';
import { initGlobalKeyboardScroll } from '../../utils/keyboardScroll';
import '../../index.css';

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
    const [title, setTitle] = useState('Wednesday at anchor');
    const [body, setBody] = useState(
        'We tucked into the bay before sunset. The water was calm and the crew was happy.',
    );
    const [mood, setMood] = useState<DiaryMood>('epic');
    const [location, setLocation] = useState('Moreton Bay');
    const [style, setStyle] = useState<PolishStyle>('clean');
    const [video, setVideo] = useState<string | null>(null);
    const offset = useKeyboardOffset();
    const pane = new URLSearchParams(window.location.search).get('pane') === 'true';
    useEffect(
        () => () => {
            if (video) URL.revokeObjectURL(video);
        },
        [video],
    );

    // DiaryPage renders compose directly into its available full-height page.
    // No login, GPS, persistence, media drain or cloud service is mounted.
    return (
        <main className="h-full overflow-hidden bg-slate-950 text-white">
            {pane && <aside className="absolute inset-y-0 left-0 w-1/2 bg-slate-900">Other tablet pane</aside>}
            <section
                className={`relative h-full overflow-hidden ${pane ? 'ml-auto w-1/2' : 'w-full'}`}
                data-split-pane={pane ? 'diary' : undefined}
                data-testid="diary-compose-shell"
            >
                <DiaryComposeForm
                    isEditing={false}
                    title={title}
                    body={body}
                    mood={mood}
                    photos={[]}
                    audioUrl={null}
                    videoUrl={video}
                    locationName={location}
                    keyboardHeight={offset}
                    saving={false}
                    uploading={false}
                    polishing={false}
                    gpsLoading={false}
                    coordsLabel="27.1234°S, 153.1234°E"
                    polishStyle={style}
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
                    onPhotoRemove={() => {}}
                    onVideoSelect={(event) => {
                        const file = event.target.files?.[0];
                        if (file) setVideo(URL.createObjectURL(file));
                        event.target.value = '';
                    }}
                    onVideoRemove={() => setVideo(null)}
                />
            </section>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
