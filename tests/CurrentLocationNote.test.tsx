import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PinDropSheet, type PinDropSheetProps } from '../components/chat/ChatAttachmentSheets';

function renderSheet(overrides: Partial<PinDropSheetProps> = {}) {
    const props: PinDropSheetProps = {
        pinLat: 0,
        pinLng: 0,
        pinCaption: '',
        setPinCaption: vi.fn(),
        pinLoading: false,
        pinSource: 'current',
        pinAccuracy: 5,
        pinTimestamp: Date.now(),
        pinRungLabel: null,
        locationError: null,
        saveToMyPlaces: false,
        setSaveToMyPlaces: vi.fn(),
        sending: false,
        onSendPin: vi.fn(),
        onRetryLocation: vi.fn(),
        onChoosePlace: vi.fn(),
        onClose: vi.fn(),
        ...overrides,
    };
    render(<PinDropSheet {...props} />);
    return props;
}

describe('Scuttlebutt current-location note', () => {
    it('keeps the note in its own shrinkable scroll and return-key scope', () => {
        const props = renderSheet();
        // A DIALOG now, not an inline region. Shane asked for these to be
        // centred modals (2026-09-05) precisely because the keyboard fight was
        // unwinnable while they lived inside ChatPage's resized flex column.
        // What this test actually protects — the note's own scroll scope, the
        // Return-key scope, and the change propagating — is unchanged.
        const sheet = screen.getByRole('dialog', { name: 'Share my current location' });
        const note = screen.getByRole('textbox', { name: 'Location note' });
        expect(sheet).toHaveClass('overflow-y-auto');
        expect(sheet).toHaveAttribute('data-keyboard-focus-scope');
        expect(note).toHaveAttribute('enterkeyhint', 'send');
        fireEvent.change(note, { target: { value: 'Anchored for the night' } });
        expect(props.setPinCaption).toHaveBeenCalledWith('Anchored for the night');
    });

    it('sends once on Return and prevents the global handler moving focus to the chat composer', () => {
        const props = renderSheet({ pinCaption: 'Anchored' });
        const note = screen.getByRole('textbox', { name: 'Location note' });
        note.focus();
        expect(fireEvent.keyDown(note, { key: 'Enter', cancelable: true })).toBe(false);
        expect(props.onSendPin).toHaveBeenCalledOnce();
        expect(note).toHaveFocus();
    });

    it('does not send while the keyboard is composing text', () => {
        const props = renderSheet();
        const note = screen.getByRole('textbox', { name: 'Location note' });
        fireEvent.keyDown(note, { key: 'Enter', isComposing: true });
        fireEvent.keyDown(note, { key: 'Enter', keyCode: 229 });
        expect(props.onSendPin).not.toHaveBeenCalled();
    });

    it('does not submit again while sharing is in progress', () => {
        const props = renderSheet({ sending: true });
        fireEvent.keyDown(screen.getByRole('textbox', { name: 'Location note' }), { key: 'Enter' });
        expect(props.onSendPin).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Share current location' })).toBeDisabled();
    });

    it('only exposes note entry after a valid current GPS fix', () => {
        renderSheet({ pinSource: null, locationError: 'No GPS fix' });
        expect(screen.queryByRole('textbox', { name: 'Location note' })).not.toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent('No GPS fix');
    });
});
