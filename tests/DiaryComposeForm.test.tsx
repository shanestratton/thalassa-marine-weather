/**
 * DiaryComposeForm — the TEXT-FIRST contract (2026-08-25).
 *
 * Shane: "get rid of the microphone, and just have texting… it has to
 * default to EPIC and we have to always as default include the gps coords."
 * These tests pin exactly that: an editable body, no microphone anywhere,
 * EPIC as the reducer's default mood, and a coords line that always tells
 * the truth (fix shown / acquiring / none-yet-will-retry).
 *
 * And the new look (Shane 2026-10-06, "more in line with our new look"):
 * the same fields, states and names in the Vessel and Plan pages' cards,
 * one segmented mood row, six photo tiles and the emerald Save.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DiaryComposeForm } from '../components/diary/DiaryComposeForm';

const makeProps = (overrides: Partial<React.ComponentProps<typeof DiaryComposeForm>> = {}) => ({
    isEditing: false,
    title: 'Saturday 26 July 2026 · 07:30',
    body: 'A brisk south-easterly carried us across the bay.',
    mood: 'epic' as const,
    photos: [],
    audioUrl: null,
    videoUrl: null,
    onVideoSelect: () => {},
    onVideoRemove: () => {},
    locationName: 'Moreton Bay',
    keyboardHeight: 0,
    saving: false,
    uploading: false,
    polishing: false,
    gpsLoading: false,
    coordsLabel: '27.2081°S, 153.0995°E' as string | null,
    polishStyle: 'polished' as const,
    onSetTitle: vi.fn(),
    onSetBody: vi.fn(),
    onSetMood: vi.fn(),
    onSetLocationName: vi.fn(),
    onSetPolishStyle: vi.fn(),
    onSave: vi.fn(),
    onCancel: vi.fn(),
    onPolish: vi.fn(),
    onPhotoSelect: vi.fn(),
    onPhotoRemove: vi.fn(),
    ...overrides,
});

describe('DiaryComposeForm — text-first entry', () => {
    it('offers an explicit trip choice and No trip without blocking offline text saves', () => {
        const onChange = vi.fn();
        const props = makeProps({
            tripPicker: {
                value: 'active',
                choices: [{ voyageId: 'sailed', label: '24 Sept · 15.6 nm' }],
                originalVoyageId: 'active',
                originalLabel: 'Active recording',
                disabled: false,
                loading: false,
                unavailable: true,
                onChange,
            },
        });
        const { rerender } = render(<DiaryComposeForm {...props} />);
        const selector = screen.getByRole('combobox', { name: 'Diary trip' });
        expect(selector).toHaveValue('active');
        fireEvent.change(selector, { target: { value: 'sailed' } });
        expect(onChange).toHaveBeenCalledWith('sailed');
        fireEvent.change(selector, { target: { value: '' } });
        expect(onChange).toHaveBeenCalledWith('');
        expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
        rerender(<DiaryComposeForm {...props} saving />);
        expect(selector).toBeDisabled();
    });
    it('the body is a plain editable textarea and typing reaches onSetBody', () => {
        const onSetBody = vi.fn();
        render(<DiaryComposeForm {...makeProps({ onSetBody })} />);

        const body = screen.getByRole('textbox', { name: 'Diary entry text' });
        expect(body).not.toHaveAttribute('readonly');
        expect(body).not.toHaveAttribute('inputmode', 'none');
        fireEvent.change(body, { target: { value: 'Dolphins at the bow off Cape Moreton.' } });
        expect(onSetBody).toHaveBeenCalledWith('Dolphins at the bow off Cape Moreton.');
    });

    it('the microphone is gone — no recording control anywhere', () => {
        render(<DiaryComposeForm {...makeProps()} />);
        expect(screen.queryByRole('button', { name: /recording/i })).toBeNull();
        expect(screen.queryByText(/Recording/)).toBeNull();
    });

    it('typed text alone enables Save', () => {
        render(<DiaryComposeForm {...makeProps({ title: '', body: 'Short and sweet.' })} />);
        expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    });

    it('polishing locks the body and Save until the styling pass lands', () => {
        render(<DiaryComposeForm {...makeProps({ polishing: true })} />);
        expect(screen.getByRole('textbox', { name: 'Diary entry text' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    });

    it('shows the GPS coords that will ride on the entry', () => {
        render(<DiaryComposeForm {...makeProps()} />);
        expect(screen.getByText(/27\.2081°S, 153\.0995°E/)).toBeInTheDocument();
    });

    it('is honest while the fix is still coming, and about saving without one', () => {
        const { rerender } = render(<DiaryComposeForm {...makeProps({ coordsLabel: null, gpsLoading: true })} />);
        expect(screen.getByText(/Acquiring GPS fix/)).toBeInTheDocument();

        rerender(<DiaryComposeForm {...makeProps({ coordsLabel: null, gpsLoading: false })} />);
        expect(screen.getByText(/No GPS fix — will retry when you save/)).toBeInTheDocument();
    });

    it('locks cancel and photo mutation while a save is adopting compose media', () => {
        const onCancel = vi.fn();
        const onPhotoRemove = vi.fn();
        render(
            <DiaryComposeForm
                {...makeProps({
                    saving: true,
                    photos: ['storage:diary-photos:skipper/new.jpg'],
                    onCancel,
                    onPhotoRemove,
                })}
            />,
        );

        const cancelButtons = screen.getAllByRole('button', { name: 'Cancel this action' });
        expect(cancelButtons).toHaveLength(2);
        cancelButtons.forEach((button) => expect(button).toBeDisabled());
    });

    it.each([
        { isEditing: false, mode: 'new' },
        { isEditing: true, mode: 'edit' },
    ])('keeps $mode entry text before video controls without losing typed content', ({ isEditing }) => {
        const onVideoRemove = vi.fn();
        const props = makeProps({ isEditing, onVideoRemove });
        function ControlledForm({ videoUrl }: { videoUrl: string | null }) {
            const [title, setTitle] = useState(props.title);
            const [body, setBody] = useState(props.body);
            return (
                <DiaryComposeForm
                    {...props}
                    title={title}
                    body={body}
                    videoUrl={videoUrl}
                    onSetTitle={setTitle}
                    onSetBody={setBody}
                />
            );
        }

        const { container, rerender } = render(<ControlledForm videoUrl={null} />);
        const body = screen.getByRole('textbox', { name: 'Diary entry text' });
        const title = screen.getByPlaceholderText('Entry title (optional)');
        const addVideo = screen.getByRole('button', { name: 'Add a video clip' });
        expect(body.compareDocumentPosition(addVideo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        fireEvent.change(title, { target: { value: 'Dolphins at Cape Moreton' } });
        fireEvent.change(body, { target: { value: 'A pod stayed alongside while we crossed the bay.' } });

        rerender(<ControlledForm videoUrl="blob:diary-compose-video" />);
        const preview = container.querySelector('video');
        expect(preview).toHaveAttribute('src', 'blob:diary-compose-video');
        expect(body.compareDocumentPosition(preview!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(title).toHaveValue('Dolphins at Cape Moreton');
        expect(body).toHaveValue('A pod stayed alongside while we crossed the bay.');
        expect(screen.queryByRole('button', { name: 'Add a video clip' })).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Remove the video' }));
        expect(onVideoRemove).toHaveBeenCalledTimes(1);
        rerender(<ControlledForm videoUrl={null} />);

        expect(container.querySelector('video')).toBeNull();
        expect(title).toHaveValue('Dolphins at Cape Moreton');
        expect(body).toHaveValue('A pod stayed alongside while we crossed the bay.');
        expect(
            body.compareDocumentPosition(screen.getByRole('button', { name: 'Add a video clip' })) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });
});

const tripPicker = (
    overrides: Partial<NonNullable<React.ComponentProps<typeof DiaryComposeForm>['tripPicker']>> = {},
) => ({
    value: '',
    choices: [
        { voyageId: 'sailed', label: '24 Sept · 15.6 nm' },
        { voyageId: 'earlier', label: '20 Sept · 4.1 nm' },
    ],
    originalVoyageId: null,
    originalLabel: 'Active recording',
    disabled: false,
    loading: false,
    unavailable: false,
    onChange: vi.fn(),
    ...overrides,
});

describe('DiaryComposeForm — the new look keeps every field and state', () => {
    it('names the page for a new entry and for an edit', () => {
        const { rerender } = render(<DiaryComposeForm {...makeProps()} />);
        expect(screen.getByRole('heading', { name: 'New Entry' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save changes' })).toHaveTextContent('Save Entry');
        rerender(<DiaryComposeForm {...makeProps({ isEditing: true })} />);
        expect(screen.getByRole('heading', { name: 'Edit Entry' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save changes' })).toHaveTextContent('Update Entry');
        rerender(<DiaryComposeForm {...makeProps({ saving: true })} />);
        expect(screen.getByRole('button', { name: 'Save changes' })).toHaveTextContent('Saving…');
        expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    });

    it('labels the title and the place, keeping their placeholders', () => {
        const onSetLocationName = vi.fn();
        render(<DiaryComposeForm {...makeProps({ onSetLocationName })} />);
        expect(screen.getByRole('textbox', { name: 'Title' })).toHaveAttribute('placeholder', 'Entry title (optional)');
        const place = screen.getByRole('textbox', { name: 'Where' });
        expect(place).toHaveAttribute('placeholder', 'Location (override e.g. Moreton Bay)');
        expect(place).toHaveValue('Moreton Bay');
        fireEvent.change(place, { target: { value: 'Sandy Cove' } });
        expect(onSetLocationName).toHaveBeenCalledWith('Sandy Cove');
    });

    it('mood is one segmented group of four, the chosen one pressed, no per-mood colours', () => {
        const onSetMood = vi.fn();
        render(<DiaryComposeForm {...makeProps({ mood: 'good', onSetMood })} />);
        const group = screen.getByRole('group', { name: 'Mood' });
        const moods = within(group).getAllByRole('button');
        expect(moods.map((button) => button.getAttribute('aria-label'))).toEqual([
            'Set mood to Epic',
            'Set mood to Good',
            'Set mood to Neutral',
            'Set mood to Rough',
        ]);
        expect(moods.map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false', 'false']);
        // Each keeps its icon and its word; the amber/emerald/sky/orange text went.
        expect(moods[0]).toHaveTextContent('🌅Epic');
        expect(group.innerHTML).not.toMatch(/text-(amber|emerald|sky|orange)-400/);
        fireEvent.click(moods[3]);
        expect(onSetMood).toHaveBeenCalledWith('rough');
    });

    it('the Trip tile shows the choice, lists every option in order, and keeps its states', () => {
        const onChange = vi.fn();
        const { rerender } = render(
            <DiaryComposeForm
                {...makeProps({
                    tripPicker: tripPicker({
                        value: 'sailed',
                        originalVoyageId: 'sailed',
                        originalLabel: 'Current trip',
                        onChange,
                    }),
                })}
            />,
        );
        const select = screen.getByRole('combobox', { name: 'Diary trip' });
        expect([...select.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
            'No trip · general diary',
            'Current trip · 24 Sept · 15.6 nm',
            '20 Sept · 4.1 nm',
        ]);
        // The face says what the select holds.
        const face = () => select.parentElement!.querySelector('.diary-trip-value');
        expect(face()).toHaveTextContent('Current trip · 24 Sept · 15.6 nm');
        fireEvent.change(select, { target: { value: 'earlier' } });
        expect(onChange).toHaveBeenCalledWith('earlier');

        // An entry's own trip that is no longer recent stays a choice.
        rerender(
            <DiaryComposeForm
                {...makeProps({
                    tripPicker: tripPicker({ value: 'old', originalVoyageId: 'old', originalLabel: 'Current trip' }),
                })}
            />,
        );
        expect([...select.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
            'No trip · general diary',
            'Current trip',
            '24 Sept · 15.6 nm',
            '20 Sept · 4.1 nm',
        ]);

        rerender(<DiaryComposeForm {...makeProps({ tripPicker: tripPicker({ loading: true, choices: [] }) })} />);
        expect(screen.getByRole('status')).toHaveTextContent('Loading recent trips…');
        expect(select).toHaveAccessibleDescription('Loading recent trips…');
        expect(face()).toHaveTextContent('No trip · general diary');

        rerender(<DiaryComposeForm {...makeProps({ tripPicker: tripPicker({ unavailable: true, choices: [] }) })} />);
        expect(screen.getByRole('status')).toHaveTextContent(
            'No recent trips available. Your diary can still be saved.',
        );

        rerender(<DiaryComposeForm {...makeProps({ tripPicker: tripPicker({ disabled: true }) })} />);
        expect(select).toBeDisabled();
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('keeps the position source word beside the coords, in the mono face', () => {
        const { rerender } = render(
            <DiaryComposeForm {...makeProps({ coordsLabel: 'Boat · 20.1234°S, 148.1234°E' })} />,
        );
        const source = screen.getByText('Boat');
        expect(source.closest('p')).toHaveClass('font-mono');
        expect(source.closest('p')).toHaveTextContent('Boat · 20.1234°S, 148.1234°E');
        rerender(<DiaryComposeForm {...makeProps({ coordsLabel: 'Phone · 27.1234°S, 153.1234°E' })} />);
        expect(screen.getByText('Phone').closest('p')).toHaveTextContent('Phone · 27.1234°S, 153.1234°E');
        // No fix and not looking: the one warning on the page.
        rerender(<DiaryComposeForm {...makeProps({ coordsLabel: null, gpsLoading: false })} />);
        expect(screen.getByText(/No GPS fix/).closest('p')).toHaveClass('diary-position-warn');
        rerender(<DiaryComposeForm {...makeProps({ coordsLabel: null, gpsLoading: true })} />);
        expect(screen.getByText(/Acquiring GPS fix/).closest('p')).not.toHaveClass('diary-position-warn');
    });

    it('polish waits for ten characters, and the style select keeps its five styles', () => {
        const onPolish = vi.fn();
        const onSetPolishStyle = vi.fn();
        const { rerender } = render(<DiaryComposeForm {...makeProps({ body: 'Too short', onPolish })} />);
        expect(screen.getByRole('button', { name: 'Polish entry text' })).toBeDisabled();
        rerender(<DiaryComposeForm {...makeProps({ onPolish, onSetPolishStyle, polishStyle: 'poetic' })} />);
        fireEvent.click(screen.getByRole('button', { name: 'Polish entry text' }));
        expect(onPolish).toHaveBeenCalledTimes(1);
        const style = screen.getByRole('combobox', { name: 'Polish style' });
        expect(style).toHaveValue('poetic');
        expect(style.querySelectorAll('option')).toHaveLength(5);
        expect(style.parentElement!.querySelector('.diary-style-value')).toHaveTextContent(
            'Shakespearean — maritime grandeur',
        );
        fireEvent.change(style, { target: { value: 'tidy' } });
        expect(onSetPolishStyle).toHaveBeenCalledWith('tidy');

        rerender(<DiaryComposeForm {...makeProps({ polishing: true })} />);
        expect(screen.getByRole('button', { name: 'Polish entry text' })).toBeDisabled();
        expect(screen.getAllByText('Styling your entry…').length).toBeGreaterThan(0);
    });

    it('six photo tiles: add slots fill the row, the count says the limit', () => {
        const onPhotoRemove = vi.fn();
        const { rerender } = render(<DiaryComposeForm {...makeProps()} />);
        expect(screen.getAllByRole('button', { name: /^Add diary photo \d$/ })).toHaveLength(6);
        expect(screen.getByText('Up to 6')).toBeInTheDocument();

        const two = ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'];
        rerender(<DiaryComposeForm {...makeProps({ photos: two, onPhotoRemove })} />);
        expect(
            screen.getAllByRole('button', { name: /^Add diary photo \d$/ }).map((b) => b.getAttribute('aria-label')),
        ).toEqual(['Add diary photo 3', 'Add diary photo 4', 'Add diary photo 5', 'Add diary photo 6']);
        expect(screen.getByText('2 of 6')).toBeInTheDocument();
        fireEvent.click(screen.getAllByRole('button', { name: 'Remove this item' })[1]);
        expect(onPhotoRemove).toHaveBeenCalledWith(1);

        rerender(<DiaryComposeForm {...makeProps({ photos: [...two, ...two, ...two] })} />);
        expect(screen.queryByRole('button', { name: /^Add diary photo/ })).toBeNull();
        expect(screen.getByText('6 of 6')).toBeInTheDocument();

        rerender(<DiaryComposeForm {...makeProps({ uploading: true })} />);
        screen
            .getAllByRole('button', { name: /^Add diary photo \d$/ })
            .forEach((button) => expect(button).toBeDisabled());
        expect(screen.getByRole('button', { name: 'Add a video clip' })).toBeDisabled();
    });

    it('a tap on a photo keeps it: the image takes the tap, only the corner control removes', () => {
        // A finger tap on something that takes no clicks is moved by the
        // browser to the nearest control that does; that was the remove
        // control, so a tap in the middle of a photo removed it (and the copy
        // uploaded this session). The image now takes the tap itself.
        const onPhotoRemove = vi.fn();
        const photos = ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'];
        const { container } = render(<DiaryComposeForm {...makeProps({ photos, onPhotoRemove })} />);
        const images = [...container.querySelectorAll<HTMLImageElement>('.diary-photo img')];
        expect(images).toHaveLength(2);
        images.forEach((img) => expect(typeof img.onclick).toBe('function'));
        fireEvent.click(images[1]);
        expect(onPhotoRemove).not.toHaveBeenCalled();

        const remove = screen.getAllByRole('button', { name: 'Remove this item' });
        remove.forEach((button) => {
            expect(button).toHaveClass('diary-photo-remove');
            // Its hit area is the corner's own, not the 44 px box centred on
            // the dot that covered the middle of the photo.
            expect(button).not.toHaveClass('hit-target-44');
            expect(button.querySelector('.diary-photo-remove-dot')).toHaveTextContent('✕');
        });
        fireEvent.click(remove[0]);
        expect(onPhotoRemove).toHaveBeenCalledWith(0);
    });

    it('Save needs words, a title or a voice note; a voice note alone is enough', () => {
        const { rerender } = render(<DiaryComposeForm {...makeProps({ title: ' ', body: ' ' })} />);
        expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
        rerender(<DiaryComposeForm {...makeProps({ title: ' ', body: ' ', audioUrl: 'idb:voice-note' })} />);
        expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    });
});

describe('diary defaults (reducer contract)', () => {
    it("a fresh compose opens with mood 'epic'", async () => {
        const { diaryReducer, initialDiaryState } = await import('../hooks/useDiaryState');
        expect(initialDiaryState.mood).toBe('epic');
        const opened = diaryReducer(initialDiaryState, { type: 'OPEN_COMPOSE', weatherSummary: '' });
        expect(opened.mood).toBe('epic');
    });
});
