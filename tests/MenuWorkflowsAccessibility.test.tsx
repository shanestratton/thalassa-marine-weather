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
        const location = screen.getByRole('menuitem', { name: 'Share my current location' });
        const pin = screen.getByRole('menuitem', { name: 'Drop a pin on the chart' });
        expect(location).toHaveFocus();

        fireEvent.keyDown(location, { key: 'ArrowDown' });
        expect(pin).toHaveFocus();
        fireEvent.keyDown(pin, { key: 'Escape' });

        expect(screen.queryByRole('menu', { name: 'Share an attachment' })).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });

    it('closes the attachment menu before launching its selected workflow', () => {
        const onOpenPinDrop = vi.fn();
        render(<ChatComposerHarness onOpenPinDrop={onOpenPinDrop} />);

        const trigger = screen.getByRole('button', { name: 'Open attachment menu' });
        trigger.focus();
        fireEvent.click(trigger);
        fireEvent.click(screen.getByRole('menuitem', { name: 'Share my current location' }));

        expect(onOpenPinDrop).toHaveBeenCalledOnce();
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });

    it('gives the passage share menu full arrow-key and dismissal semantics', () => {
        const completeBrief: PassageBriefData = {
            routeName: 'Test passage',
            origin: { name: 'Newport', lat: -27.2, lon: 153.1 },
            destination: { name: 'Lady Musgrave', lat: -23.9, lon: 152.4 },
            departureTime: '2026-08-05T00:00:00.000Z',
            totalDistanceNM: 178,
            estimatedDuration: 30,
            speed: 6,
            crewCount: 3,
        };
        render(<SharePassageButton briefData={completeBrief} />);

        const trigger = screen.getByRole('button', { name: 'Open share passage menu' });
        trigger.focus();
        fireEvent.click(trigger);

        expect(screen.getByRole('menu', { name: 'Share passage plan' })).toBeInTheDocument();
        const floatPlan = screen.getByRole('menuitem', { name: /Float Plan/ });
        const quickBrief = screen.getByRole('menuitem', { name: /Quick Passage Brief/ });
        const cancel = screen.getByRole('menuitem', { name: 'Cancel' });
        expect(floatPlan).toHaveFocus();

        fireEvent.keyDown(floatPlan, { key: 'ArrowDown' });
        expect(quickBrief).toHaveFocus();

        fireEvent.keyDown(quickBrief, { key: 'End' });
        expect(cancel).toHaveFocus();
        fireEvent.click(cancel);

        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });
});
