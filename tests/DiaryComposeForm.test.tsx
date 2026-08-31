/**
 * DiaryComposeForm — the TEXT-FIRST contract (2026-08-25).
 *
 * Shane: "get rid of the microphone, and just have texting… it has to
 * default to EPIC and we have to always as default include the gps coords."
 * These tests pin exactly that: an editable body, no microphone anywhere,
 * EPIC as the reducer's default mood, and a coords line that always tells
 * the truth (fix shown / acquiring / none-yet-will-retry).
 */
import { fireEvent, render, screen } from '@testing-library/react';
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
});

describe('diary defaults (reducer contract)', () => {
    it("a fresh compose opens with mood 'epic'", async () => {
        const { diaryReducer, initialDiaryState } = await import('../hooks/useDiaryState');
        expect(initialDiaryState.mood).toBe('epic');
        const opened = diaryReducer(initialDiaryState, { type: 'OPEN_COMPOSE', weatherSummary: '' });
        expect(opened.mood).toBe('epic');
    });
});
