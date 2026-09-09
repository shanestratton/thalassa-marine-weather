import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatComposer, type ChatComposerProps } from '../components/chat/ChatComposer';
import { ChatDMCompose, type ChatDMComposeProps } from '../components/chat/ChatDMView';

const channelProps = (): ChatComposerProps => ({
    messageText: 'Ahoy',
    setMessageText: vi.fn(),
    isQuestion: false,
    setIsQuestion: vi.fn(),
    filterWarning: null,
    setFilterWarning: vi.fn(),
    isMuted: false,
    mutedUntil: null,
    showAttachMenu: false,
    setShowAttachMenu: vi.fn(),
    keyboardOffset: 0,
    inputRef: React.createRef<HTMLInputElement>(),
    onSend: vi.fn(),
    onOpenPinDrop: vi.fn(),
    onOpenPoiPicker: vi.fn(),
    onOpenTrackPicker: vi.fn(),
});

const dmProps = (): ChatDMComposeProps => ({
    dmText: 'Ahoy Sparrow',
    setDmText: vi.fn(),
    partnerName: 'Sparrow',
    keyboardOffset: 0,
    isUserBlocked: false,
    blockedByMe: false,
    blockStatusLoading: false,
    blockStatusError: null,
    blockMutationPending: false,
    onRetryBlockStatus: vi.fn(),
    showBlockConfirm: false,
    setShowBlockConfirm: vi.fn(),
    onSendDM: vi.fn(),
    onBlock: vi.fn(),
    onUnblock: vi.fn(),
});

describe('chat composers', () => {
    it('keeps a visible, labelled field and send action in both conversations', () => {
        const channel = render(<ChatComposer {...channelProps()} />);
        expect(screen.getByRole('textbox', { name: 'Type a message' })).toHaveAttribute('data-no-keyboard-scroll');
        expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
        channel.unmount();
        render(<ChatDMCompose {...dmProps()} />);
        expect(screen.getByRole('textbox', { name: 'Message Sparrow' })).toHaveAttribute('data-no-keyboard-scroll');
        expect(screen.getByRole('button', { name: 'Send direct message' })).toBeEnabled();
    });

    it('sends once with Enter, owns the send key, and does not send unfinished IME text', () => {
        const props = channelProps();
        render(<ChatComposer {...props} />);
        const input = screen.getByRole('textbox');
        expect(input).toHaveAttribute('enterkeyhint', 'send');
        fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
        expect(props.onSend).not.toHaveBeenCalled();
        expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
        expect(props.onSend).toHaveBeenCalledTimes(1);
    });

    it('does not submit DMs while checking permissions or after an unavailable check, retaining the draft', () => {
        const props = dmProps();
        const { rerender } = render(<ChatDMCompose {...props} blockStatusLoading />);
        expect(screen.getByRole('button', { name: 'Send direct message' })).toBeDisabled();
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
        rerender(<ChatDMCompose {...props} blockStatusError="Could not check messaging permissions." />);
        expect(screen.getByRole('textbox')).toHaveValue('Ahoy Sparrow');
        expect(screen.getByRole('button', { name: 'Send direct message' })).toBeDisabled();
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
        expect(props.onSendDM).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(props.onRetryBlockStatus).toHaveBeenCalledOnce();
        rerender(<ChatDMCompose {...props} />);
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true });
        expect(props.onSendDM).not.toHaveBeenCalled();
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
        expect(props.onSendDM).toHaveBeenCalledOnce();
    });

    it('offers Unblock only for the current sailor’s own block', () => {
        const props = dmProps();
        const { rerender } = render(<ChatDMCompose {...props} isUserBlocked />);
        expect(screen.queryByRole('textbox')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Unblock user' })).toBeNull();
        expect(screen.getByRole('status')).toHaveTextContent('Messaging is unavailable');
        rerender(<ChatDMCompose {...props} isUserBlocked blockedByMe />);
        fireEvent.click(screen.getByRole('button', { name: 'Unblock user' }));
        expect(props.setShowBlockConfirm).toHaveBeenCalledWith(true);
    });

    it('requires confirmation and prevents repeat actions while saving a block', () => {
        const props = dmProps();
        const { rerender } = render(<ChatDMCompose {...props} showBlockConfirm />);
        fireEvent.click(screen.getByRole('button', { name: 'Block Sparrow' }));
        expect(props.onBlock).toHaveBeenCalledOnce();
        rerender(<ChatDMCompose {...props} showBlockConfirm blockMutationPending />);
        expect(screen.getByRole('button', { name: 'Block Sparrow' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
        rerender(<ChatDMCompose {...props} showBlockConfirm blockedByMe isUserBlocked />);
        fireEvent.click(screen.getByRole('button', { name: 'Unblock Sparrow' }));
        expect(props.onUnblock).toHaveBeenCalledOnce();
        expect(screen.getByText(/Messaging still depends on their settings/)).toBeVisible();
    });
});
