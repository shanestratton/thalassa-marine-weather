import { fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChatComposer } from '../components/chat/ChatComposer';
import SharePassageButton from '../components/passage/SharePassageButton';
import type { PassageBriefData } from '../services/PassageBriefService';

function ChatComposerHarness({ onOpenPinDrop = () => {} }: { onOpenPinDrop?: () => void }) {
    const [showAttachMenu, setShowAttachMenu] = useState(false);
    const [messageText, setMessageText] = useState('');
    const [isQuestion, setIsQuestion] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    return (
        <ChatComposer
            messageText={messageText}
            setMessageText={setMessageText}
            isQuestion={isQuestion}
            setIsQuestion={setIsQuestion}
            filterWarning={null}
            setFilterWarning={() => {}}
            isMuted={false}
            mutedUntil={null}
            showAttachMenu={showAttachMenu}
            setShowAttachMenu={setShowAttachMenu}
            keyboardOffset={0}
            inputRef={inputRef}
            onSend={() => {}}
            onOpenPinDrop={onOpenPinDrop}
            onOpenPoiPicker={() => {}}
            onOpenTrackPicker={() => {}}
        />
    );
}

describe('non-modal workflow menus', () => {
    it('navigates the chat attachment menu and restores its trigger on Escape', () => {
        render(<ChatComposerHarness />);

        const trigger = screen.getByRole('button', { name: 'Open attachment menu' });
        trigger.focus();
        fireEvent.click(trigger);

        expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
        expect(screen.getByRole('menu', { name: 'Share an attachment' })).toBeInTheDocument();
        const pin = screen.getByRole('menuitem', { name: 'Drop a pin to share location' });
        const point = screen.getByRole('menuitem', { name: 'Share a point of interest' });
        expect(pin).toHaveFocus();

        fireEvent.keyDown(pin, { key: 'ArrowDown' });
        expect(point).toHaveFocus();
        fireEvent.keyDown(point, { key: 'Escape' });

        expect(screen.queryByRole('menu', { name: 'Share an attachment' })).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });

    it('closes the attachment menu before launching its selected workflow', () => {
        const onOpenPinDrop = vi.fn();
        render(<ChatComposerHarness onOpenPinDrop={onOpenPinDrop} />);

        const trigger = screen.getByRole('button', { name: 'Open attachment menu' });
        trigger.focus();
        fireEvent.click(trigger);
        fireEvent.click(screen.getByRole('menuitem', { name: 'Drop a pin to share location' }));

        expect(onOpenPinDrop).toHaveBeenCalledOnce();
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });

    it('gives the passage share menu full arrow-key and dismissal semantics', () => {
        render(<SharePassageButton briefData={{} as PassageBriefData} />);

        const trigger = screen.getByRole('button', { name: 'Open share passage menu' });
        trigger.focus();
        fireEvent.click(trigger);

        expect(screen.getByRole('menu', { name: 'Share passage plan' })).toBeInTheDocument();
        const quickBrief = screen.getByRole('menuitem', { name: /Quick Brief/ });
        const cancel = screen.getByRole('menuitem', { name: 'Cancel' });
        expect(quickBrief).toHaveFocus();

        fireEvent.keyDown(quickBrief, { key: 'End' });
        expect(cancel).toHaveFocus();
        fireEvent.click(cancel);

        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });
});
