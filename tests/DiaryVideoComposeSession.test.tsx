/**
 * A diary video pick belongs to the compose it was made in.
 *
 * The pipeline — a metadata probe of up to 5 s, the remux, the trimmer, the
 * IndexedDB park — outlives renders, and Cancel stays live while uploading.
 * Before 2026-10-06 a clip still being processed landed in the NEXT compose:
 * even an Edit, where it could not be removed, Update dropped it (updateEntry
 * carries no video_url), and the parked blob — up to ~200MB — was orphaned in
 * IndexedDB for good. The route a reviewer found: New Entry → Add video → a
 * long camera movie → Cancel during the probe → Edit any entry → the trimmer
 * pops over the Edit form.
 *
 * These drive the real DiaryPage, with its form, trimmer and timeline card
 * stubbed down to the props that carry the bug. The contract block below pins
 * the one guard no behaviour can reach any more (the edit-save discard).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChangeEvent } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiaryEntry } from '../services/DiaryService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    getEntries: vi.fn(),
    saveVideoForEntry: vi.fn(),
    discardUnsavedVideo: vi.fn(),
    updateEntry: vi.fn(),
    createEntry: vi.fn(),
    enhanceWithGemini: vi.fn(),
    probeVideoDurationSeconds: vi.fn(),
    readContainerBrand: vi.fn(),
    remuxVideoLossless: vi.fn(),
    toast: {
        error: vi.fn(),
        info: vi.fn(),
        success: vi.fn(),
        persistentError: vi.fn(),
    },
    settings: { settings: {}, updateSettings: vi.fn() },
    weather: { weatherData: null },
    pendingComments: { counts: {}, error: '', refresh: vi.fn() },
    /** The newest onDone the trimmer was rendered with — a cut can finish after it unmounts. */
    trimmerDone: { current: null as ((blob: Blob) => void) | null },
}));

vi.mock('../services/DiaryService', () => ({
    DiaryService: {
        getEntries: mocks.getEntries,
        getPositionCandidates: vi.fn(async () => ({ vessel: null, phone: null })),
        reverseGeocode: vi.fn(async () => null),
        saveVideoForEntry: mocks.saveVideoForEntry,
        discardUnsavedVideo: mocks.discardUnsavedVideo,
        discardUnsavedPhoto: vi.fn(async () => undefined),
        uploadPhoto: vi.fn(async () => null),
        updateEntry: mocks.updateEntry,
        createEntry: mocks.createEntry,
        resolveServerId: vi.fn(() => null),
        enhanceWithGemini: mocks.enhanceWithGemini,
        transcribeAudio: vi.fn(async () => null),
        resolveAudioUrl: vi.fn(async () => null),
        deleteEntry: vi.fn(async () => true),
    },
}));

vi.mock('../services/videoTrim', () => ({
    probeVideoDurationSeconds: mocks.probeVideoDurationSeconds,
    readContainerBrand: mocks.readContainerBrand,
    remuxVideoLossless: mocks.remuxVideoLossless,
}));

vi.mock('../services/diaryVoyageSelection', () => ({
    captureDiaryTripContext: vi.fn(async () => ({ scope: null, boatId: null, originalVoyageId: null })),
    loadDiaryTripChoices: vi.fn(async () => []),
}));

vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: { getSnapshot: () => ({ state: 'idle', config: { waterDepth: 0 } }) },
}));

vi.mock('../context/WeatherContext', () => ({ useWeather: () => mocks.weather }));
vi.mock('../context/SettingsContext', () => ({ useSettings: () => mocks.settings }));
vi.mock('../hooks/useDiaryPendingComments', () => ({ useDiaryPendingComments: () => mocks.pendingComments }));
vi.mock('../hooks/useKeyboardOffset', () => ({ useKeyboardOffset: () => 0 }));
vi.mock('../utils/exifGps', () => ({ extractPhotoExif: vi.fn(async () => null) }));

vi.mock('../components/Toast', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../components/Toast')>()),
    toast: mocks.toast,
}));

vi.mock('../components/diary/DiaryComposeForm', () => ({
    DiaryComposeForm: (props: {
        isEditing: boolean;
        body: string;
        videoUrl: string | null;
        uploading: boolean;
        polishing: boolean;
        onSetBody: (v: string) => void;
        onVideoSelect: (e: ChangeEvent<HTMLInputElement>) => void;
        onPolish: () => void;
        onCancel: () => void;
        onSave: () => void;
    }) => (
        <div
            data-testid="compose"
            data-editing={String(props.isEditing)}
            data-uploading={String(props.uploading)}
            data-polishing={String(props.polishing)}
            data-video={props.videoUrl ?? ''}
        >
            <textarea
                aria-label="Diary entry text"
                value={props.body}
                onChange={(e) => props.onSetBody(e.target.value)}
            />
            <button type="button" onClick={props.onPolish}>
                Polish
            </button>
            <input aria-label="Video file" type="file" onChange={props.onVideoSelect} />
            <button type="button" onClick={props.onCancel}>
                Cancel
            </button>
            <button type="button" onClick={props.onSave}>
                {props.isEditing ? 'Update Entry' : 'Save Entry'}
            </button>
        </div>
    ),
}));

vi.mock('../components/diary/VideoTrimmer', () => ({
    VideoTrimmer: (props: { onDone: (blob: Blob) => void; onCancel: () => void }) => {
        mocks.trimmerDone.current = props.onDone;
        return (
            <div role="dialog" aria-label="Trim the video">
                <button type="button" onClick={() => props.onDone(new Blob(['the best minute']))}>
                    Use this minute
                </button>
            </div>
        );
    },
}));

vi.mock('../components/diary/SwipeableDiaryCard', () => ({
    SwipeableDiaryCard: (props: { entry: DiaryEntry; onEdit: () => void }) => (
        <button type="button" onClick={props.onEdit}>
            Edit {props.entry.title}
        </button>
    ),
}));

vi.mock('../components/ui/TapToAction', () => ({
    TapToAction: (props: { label: string; onConfirm: () => void }) => (
        <button type="button" onClick={props.onConfirm}>
            {props.label}
        </button>
    ),
}));

vi.mock('../components/diary/DiaryEntryView', () => ({ DiaryEntryView: () => null }));
vi.mock('../components/diary/DiaryPublishModal', () => ({ DiaryPublishModal: () => null }));

import { DiaryPage } from '../components/DiaryPage';

// Fictional entry — the repo is public.
const savedEntry = {
    id: 'entry-1',
    user_id: 'account-a',
    title: 'Across the bay',
    body: 'A clean reach in a steady breeze.',
    mood: 'good',
    photos: [],
    audio_url: null,
    video_url: null,
    latitude: -27.4,
    longitude: 153.1,
    location_name: 'Somewhere sheltered',
    weather_summary: '15 kt SE',
    weather_data: null,
    voyage_id: null,
    tags: [],
    is_public: false,
    created_at: '2026-07-23T08:00:00.000Z',
    updated_at: '2026-07-23T08:00:00.000Z',
} satisfies DiaryEntry;

function deferred<T>() {
    let resolveValue!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolveValue = done;
    });
    return { promise, resolve: resolveValue };
}

const movie = () => new File(['not really a movie'], 'long-movie.mov', { type: 'video/quicktime' });
const compose = () => screen.getByTestId('compose');
const trimmer = () => screen.queryByRole('dialog', { name: 'Trim the video' });

async function openNewEntry(): Promise<void> {
    fireEvent.click(await screen.findByRole('button', { name: 'Write entry' }));
    expect(compose().dataset.editing).toBe('false');
}

async function openEditOfSavedEntry(): Promise<void> {
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Across the bay' }));
    expect(compose().dataset.editing).toBe('true');
}

function pickVideo(file: File): void {
    fireEvent.change(screen.getByLabelText('Video file'), { target: { files: [file] } });
}

function cancelCompose(): void {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
}

/** Let queued promise callbacks (the pipeline's awaits) run. */
async function settle(): Promise<void> {
    await act(async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
    });
}

const createObjectURL = vi.fn(() => 'blob:probe');
const revokeObjectURL = vi.fn();
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
    setAuthIdentityScope('account-a');
    vi.clearAllMocks();
    // Each test queues its own probe answers and parks.
    mocks.probeVideoDurationSeconds.mockReset();
    mocks.saveVideoForEntry.mockReset();
    mocks.trimmerDone.current = null;
    mocks.getEntries.mockResolvedValue([savedEntry]);
    mocks.discardUnsavedVideo.mockResolvedValue(undefined);
    mocks.updateEntry.mockResolvedValue({ ok: true });
    mocks.createEntry.mockReset().mockResolvedValue(null);
    mocks.enhanceWithGemini.mockReset().mockResolvedValue(null);
    mocks.readContainerBrand.mockResolvedValue('isom');
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    // jsdom has no media pipeline: the element probe errors at once, so the
    // page falls through to the container probe each test controls.
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
        this.onerror?.(new Event('error'));
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    setAuthIdentityScope(null);
});

describe('diary video picks stay with their compose', () => {
    it('a long movie cancelled during the probe never opens the trimmer, not even over a later Edit', async () => {
        const probe = deferred<number | null>();
        mocks.probeVideoDurationSeconds.mockReturnValueOnce(probe.promise);
        render(<DiaryPage onBack={() => {}} />);

        await openNewEntry();
        pickVideo(movie());
        await waitFor(() => expect(mocks.probeVideoDurationSeconds).toHaveBeenCalledTimes(1));
        expect(compose().dataset.uploading).toBe('true');

        cancelCompose();
        await act(async () => {
            probe.resolve(90);
            await probe.promise;
        });
        await settle();

        await openEditOfSavedEntry();
        expect(trimmer()).toBeNull();
        expect(compose().dataset.video).toBe('');
        expect(compose().dataset.uploading).toBe('false');
        expect(mocks.saveVideoForEntry).not.toHaveBeenCalled();
        // A cancelled pick says nothing either.
        expect(mocks.toast.error).not.toHaveBeenCalled();
        expect(mocks.toast.persistentError).not.toHaveBeenCalled();
    });

    it('Cancel takes the trimmer with it, and its late cut adopts nothing', async () => {
        mocks.probeVideoDurationSeconds.mockResolvedValue(90);
        render(<DiaryPage onBack={() => {}} />);

        await openNewEntry();
        pickVideo(movie());
        expect(await screen.findByRole('dialog', { name: 'Trim the video' })).toBeInTheDocument();
        const lateCut = mocks.trimmerDone.current;
        expect(lateCut).not.toBeNull();

        cancelCompose();
        await openNewEntry();
        expect(trimmer()).toBeNull();
        cancelCompose();
        await openEditOfSavedEntry();
        expect(trimmer()).toBeNull();

        // The cut that was running when the compose went away finishes now.
        await act(async () => {
            lateCut?.(new Blob(['the best minute']));
        });
        await settle();
        expect(mocks.saveVideoForEntry).not.toHaveBeenCalled();
        expect(compose().dataset.video).toBe('');
    });

    it('an account switch closes the trimmer, and the old account’s cut adopts nothing', async () => {
        mocks.probeVideoDurationSeconds.mockResolvedValue(90);
        render(<DiaryPage onBack={() => {}} />);

        await openNewEntry();
        pickVideo(movie());
        expect(await screen.findByRole('dialog', { name: 'Trim the video' })).toBeInTheDocument();
        const lateCut = mocks.trimmerDone.current;

        act(() => {
            setAuthIdentityScope('account-b');
        });
        expect(trimmer()).toBeNull();
        expect(screen.queryByTestId('compose')).toBeNull();

        await openNewEntry();
        expect(trimmer()).toBeNull();
        await act(async () => {
            lateCut?.(new Blob(['the best minute']));
        });
        await settle();
        expect(mocks.saveVideoForEntry).not.toHaveBeenCalled();
        expect(compose().dataset.video).toBe('');
    });

    it('a clip parked after its compose closed is freed, never handed to the Edit that followed', async () => {
        mocks.probeVideoDurationSeconds.mockResolvedValue(30);
        const park = deferred<string | null>();
        mocks.saveVideoForEntry.mockReturnValueOnce(park.promise);
        render(<DiaryPage onBack={() => {}} />);

        await openNewEntry();
        pickVideo(movie());
        await waitFor(() => expect(mocks.saveVideoForEntry).toHaveBeenCalledTimes(1));
        expect(compose().dataset.uploading).toBe('true');

        cancelCompose();
        await openEditOfSavedEntry();
        await act(async () => {
            park.resolve('idb-video:stale-clip');
            await park.promise;
        });
        await settle();

        expect(mocks.discardUnsavedVideo).toHaveBeenCalledWith('idb-video:stale-clip');
        expect(compose().dataset.video).toBe('');
        expect(compose().dataset.uploading).toBe('false');

        // Update Entry carries no clip, and frees nothing a second time.
        fireEvent.click(screen.getByRole('button', { name: 'Update Entry' }));
        await waitFor(() => expect(mocks.updateEntry).toHaveBeenCalledTimes(1));
        expect(mocks.updateEntry.mock.calls[0][1]).not.toHaveProperty('video_url');
        expect(mocks.discardUnsavedVideo).toHaveBeenCalledTimes(1);
    });

    it('an Edit refuses a video pick outright', async () => {
        render(<DiaryPage onBack={() => {}} />);
        await openEditOfSavedEntry();

        pickVideo(movie());
        await settle();

        expect(createObjectURL).not.toHaveBeenCalled();
        expect(mocks.probeVideoDurationSeconds).not.toHaveBeenCalled();
        expect(mocks.saveVideoForEntry).not.toHaveBeenCalled();
        expect(compose().dataset.uploading).toBe('false');
        expect(compose().dataset.video).toBe('');
    });

    it('the compose that picked the clip still gets it — short clip and trimmed cut alike', async () => {
        mocks.probeVideoDurationSeconds.mockResolvedValueOnce(30).mockResolvedValueOnce(90);
        mocks.saveVideoForEntry.mockResolvedValueOnce('idb-video:short').mockResolvedValueOnce('idb-video:cut');
        render(<DiaryPage onBack={() => {}} />);

        await openNewEntry();
        pickVideo(movie());
        await waitFor(() => expect(compose().dataset.video).toBe('idb-video:short'));
        expect(compose().dataset.uploading).toBe('false');

        pickVideo(movie());
        fireEvent.click(await screen.findByRole('button', { name: 'Use this minute' }));
        await waitFor(() => expect(compose().dataset.video).toBe('idb-video:cut'));
        expect(trimmer()).toBeNull();
        // Replacing the short clip frees it; the cut is the compose's now.
        expect(mocks.discardUnsavedVideo).toHaveBeenCalledWith('idb-video:short');
        expect(mocks.discardUnsavedVideo).not.toHaveBeenCalledWith('idb-video:cut');
    });
});

// A Save in flight owns its clip: the page going away mid-save (the Log tab,
// an account switch) used to free the clip while createEntry went on to commit
// an entry pointing at it, and the next drain saved the text without it.
describe('a Save in flight keeps its clip', () => {
    async function saveWithClip() {
        mocks.probeVideoDurationSeconds.mockResolvedValue(30);
        mocks.saveVideoForEntry.mockResolvedValueOnce('idb-video:the-minute');
        const create = deferred<DiaryEntry | null>();
        mocks.createEntry.mockReturnValueOnce(create.promise);
        const page = render(<DiaryPage onBack={() => {}} />);
        await openNewEntry();
        pickVideo(movie());
        await waitFor(() => expect(compose().dataset.video).toBe('idb-video:the-minute'));
        fireEvent.click(screen.getByRole('button', { name: 'Save Entry' }));
        await waitFor(() => expect(mocks.createEntry).toHaveBeenCalledTimes(1));
        expect(mocks.createEntry.mock.calls[0][0]).toMatchObject({ video_url: 'idb-video:the-minute' });
        return { page, create };
    }

    it('the page unmounting mid-save leaves the clip to the entry that commits', async () => {
        const { page, create } = await saveWithClip();
        page.unmount();
        expect(mocks.discardUnsavedVideo).not.toHaveBeenCalled();

        await act(async () => {
            create.resolve({ ...savedEntry, id: 'offline-the-minute', video_url: 'idb-video:the-minute' });
            await create.promise;
        });
        await settle();
        expect(mocks.discardUnsavedVideo).not.toHaveBeenCalled();
    });

    it('a Save that never lands after the page went away frees the clip, once', async () => {
        const { page, create } = await saveWithClip();
        page.unmount();
        await act(async () => {
            create.resolve(null);
            await create.promise;
        });
        await settle();
        expect(mocks.discardUnsavedVideo).toHaveBeenCalledTimes(1);
        expect(mocks.discardUnsavedVideo).toHaveBeenCalledWith('idb-video:the-minute');
    });

    it('an account switch mid-save keeps the clip for the entry that commits', async () => {
        const { create } = await saveWithClip();
        act(() => {
            setAuthIdentityScope('account-b');
        });
        expect(mocks.discardUnsavedVideo).not.toHaveBeenCalled();
        await act(async () => {
            create.resolve({ ...savedEntry, id: 'offline-the-minute', video_url: 'idb-video:the-minute' });
            await create.promise;
        });
        await settle();
        expect(mocks.discardUnsavedVideo).not.toHaveBeenCalled();
    });
});

// The ✨ polish belongs to the entry it was asked for. Cancel stays live while
// Gemini works, and its answer used to replace the text of whatever compose
// was open when it came back — another entry's Edit, saved by Update.
describe('the ✨ polish stays with its compose', () => {
    const text = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Diary entry text' });

    it('a polish that returns after Cancel writes nothing into the next compose', async () => {
        const polish = deferred<string | null>();
        mocks.enhanceWithGemini.mockReturnValueOnce(polish.promise);
        render(<DiaryPage onBack={() => {}} />);

        await openEditOfSavedEntry();
        expect(text().value).toBe(savedEntry.body);
        fireEvent.click(screen.getByRole('button', { name: 'Polish' }));
        expect(compose().dataset.polishing).toBe('true');

        cancelCompose();
        await openNewEntry();
        expect(compose().dataset.polishing).toBe('false');
        fireEvent.change(text(), { target: { value: 'A different day entirely, at another anchorage.' } });

        await act(async () => {
            polish.resolve('Polished words for the first entry.');
            await polish.promise;
        });
        await settle();
        expect(text().value).toBe('A different day entirely, at another anchorage.');
        expect(compose().dataset.polishing).toBe('false');
    });

    it('the compose that asked still gets its polished words', async () => {
        mocks.enhanceWithGemini.mockResolvedValueOnce('The breeze held steady across the whole bay.');
        render(<DiaryPage onBack={() => {}} />);
        await openEditOfSavedEntry();
        fireEvent.click(screen.getByRole('button', { name: 'Polish' }));
        await waitFor(() => expect(text().value).toBe('The breeze held steady across the whole bay.'));
        expect(compose().dataset.polishing).toBe('false');
    });
});

describe('diary video compose-session contract', () => {
    const source = readFileSync(resolve(process.cwd(), 'components/DiaryPage.tsx'), 'utf8');
    const between = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end));

    it('every step of the pipeline re-checks the session, the account, the page and the edit state', () => {
        const begin = between('const beginVideoOperation = ', 'const handleVideoSelect = ');
        expect(begin).toContain('const composeSession = composeSessionRef.current;');
        expect(begin).toContain('pageActiveRef.current &&');
        expect(begin).toContain('isAuthIdentityScopeCurrent(scope) &&');
        expect(begin).toContain('composeSessionRef.current === composeSession &&');
        expect(begin).toContain('!latestEditingIdRef.current;');

        const select = between('const handleVideoSelect = ', 'const adoptCameraVideo = ');
        // Refused while editing, before the probe costs anything.
        expect(select.indexOf('if (latestEditingIdRef.current) return;')).toBeGreaterThan(-1);
        expect(select.indexOf('if (latestEditingIdRef.current) return;')).toBeLessThan(
            select.indexOf('URL.createObjectURL(file)'),
        );
        expect(select).toContain('setTrimRequest({ file, durationSec: duration, operationIsCurrent });');
        expect(select).toContain('if (operationIsCurrent()) setUploading(false);');
        expect(select).toContain('await adoptCameraVideo(file, operationIsCurrent);');

        const adopt = between('const adoptVideoBlob = ', 'const removeVideo = ');
        const parked = adopt.indexOf('await DiaryService.saveVideoForEntry(blob);');
        const staleGuard = adopt.indexOf('if (!operationIsCurrent()) {', parked);
        expect(staleGuard).toBeGreaterThan(parked);
        expect(adopt.indexOf('if (ref) void DiaryService.discardUnsavedVideo(ref);', staleGuard)).toBeGreaterThan(
            staleGuard,
        );
        expect(adopt.indexOf('unsavedVideoRef.current = ref;')).toBeGreaterThan(staleGuard);

        expect(source).toContain('void adoptVideoBlob(blob, request.operationIsCurrent);');
    });

    it('a new compose session never inherits the old one’s trimmer', () => {
        const invalidate = between('const invalidateComposeSession = ', 'const discardNewPhoto = ');
        const resetUi = invalidate.slice(invalidate.indexOf('if (resetUi) {'));
        expect(resetUi).toContain('setTrimRequest(null);');
        // Cancel, New Entry, Edit and the account switch all reset the UI.
        expect(between('const openCompose = ', 'const openEdit = ')).toContain('invalidateComposeSession();');
        expect(between('const openEdit = ', '// ── Audio Playback')).toContain('invalidateComposeSession();');
        expect(source).toMatch(/discardAllNewPhotos\(\);\s*\n\s*invalidateComposeSession\(\);/);
        expect(between('return subscribeAuthIdentityScope(', '// ── GPS helper')).toContain(
            'invalidateComposeSession();',
        );
    });

    it('an edit Save frees a stray compose clip instead of marking it adopted', () => {
        const save = between('const handleSave = async', '// ── Delete (soft-delete');
        expect(save).toContain('const saveVideoRef = unsavedVideoRef.current;');
        const update = save.slice(
            save.indexOf('if (editingId) {'),
            save.indexOf('entry = await DiaryService.createEntry('),
        );
        expect(update).toContain('if (saveVideoRef && unsavedVideoRef.current === saveVideoRef) {');
        expect(update).toContain('void DiaryService.discardUnsavedVideo(saveVideoRef);');
        // updateEntry carries no video_url — nulling the ref there was the leak.
        expect(update).not.toContain(
            'if (videoUrl && unsavedVideoRef.current === videoUrl) unsavedVideoRef.current = null;',
        );
    });
});
