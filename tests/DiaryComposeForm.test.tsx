import { fireEvent, render, screen } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DiaryComposeForm } from '../components/diary/DiaryComposeForm';

const makeProps = (overrides: Partial<React.ComponentProps<typeof DiaryComposeForm>> = {}) => ({
    isEditing: false,
    title: 'Saturday 26 July 2026 · 07:30',
    body: 'A brisk south-easterly carried us across the bay.',
    mood: 'good' as const,
    photos: [],
    audioUrl: null,
    locationName: 'Moreton Bay',
    keyboardHeight: 0,
    saving: false,
    uploading: false,
    polishing: false,
    isRecording: false,
    recordingTime: 0,
    transcribing: false,
    polishStyle: 'polished' as const,
    onSetTitle: vi.fn(),
    onSetMood: vi.fn(),
    onSetLocationName: vi.fn(),
    onSetPolishStyle: vi.fn(),
    onSave: vi.fn(),
    onCancel: vi.fn(),
    onStartRecording: vi.fn(),
    onStopRecording: vi.fn(),
    onPolish: vi.fn(),
    onPhotoSelect: vi.fn(),
    onPhotoRemove: vi.fn(),
    ...overrides,
});

describe('DiaryComposeForm voice entry', () => {
    it('makes the narrative field voice-only while keeping the transcript readable', () => {
        render(<DiaryComposeForm {...makeProps()} />);

        const transcript = screen.getByRole('textbox', { name: 'Voice transcript' });
        expect(transcript).toHaveAttribute('readonly');
        expect(transcript).toHaveAttribute('aria-readonly', 'true');
        expect(transcript).toHaveAttribute('inputmode', 'none');
        expect(transcript).toHaveAttribute('tabindex', '-1');
    });

    it('uses the same microphone control to start and stop dictation', () => {
        const onStartRecording = vi.fn();
        const onStopRecording = vi.fn();
        const { rerender } = render(<DiaryComposeForm {...makeProps({ onStartRecording, onStopRecording })} />);

        fireEvent.click(screen.getByRole('button', { name: 'Start voice recording' }));
        expect(onStartRecording).toHaveBeenCalledOnce();

        rerender(<DiaryComposeForm {...makeProps({ isRecording: true, onStartRecording, onStopRecording })} />);
        fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
        expect(onStopRecording).toHaveBeenCalledOnce();
    });

    it('holds Save and new recording until the voice session has finished', () => {
        render(<DiaryComposeForm {...makeProps({ transcribing: true })} />);

        expect(screen.getByRole('button', { name: 'Start voice recording' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    });

    it('does not allow Save while the microphone is still recording', () => {
        render(<DiaryComposeForm {...makeProps({ isRecording: true })} />);

        expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Stop recording' })).toBeEnabled();
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
        expect(screen.getByRole('button', { name: 'Remove this item' })).toBeDisabled();
        expect(
            screen
                .getAllByRole('button', { name: /Add diary photo/ })
                .every((button) => button.hasAttribute('disabled')),
        ).toBe(true);

        cancelButtons.forEach((button) => fireEvent.click(button));
        fireEvent.click(screen.getByRole('button', { name: 'Remove this item' }));
        expect(onCancel).not.toHaveBeenCalled();
        expect(onPhotoRemove).not.toHaveBeenCalled();
    });
});
