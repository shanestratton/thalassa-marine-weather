import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SectionHeader } from '../components/vesselHub/SectionHeader';

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

function Harness({ initialOpen = false }: { initialOpen?: boolean }) {
    const [open, setOpen] = useState(initialOpen);
    return (
        <div data-testid="port">
            <div data-testid="section">
                <SectionHeader
                    color="cyan"
                    label="Settings"
                    id="settings"
                    expanded={open}
                    onToggle={() => setOpen(!open)}
                />
                <div data-testid="expansion" style={{ gridTemplateRows: open ? '1fr' : '0fr' }}>
                    Account &amp; Settings
                </div>
            </div>
        </div>
    );
}

function deferredAnimation(endTime = 430) {
    let resolve!: () => void;
    let reject!: () => void;
    const finished = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return {
        animation: {
            finished,
            playState: 'running',
            effect: { getComputedTiming: () => ({ endTime }) },
        } as unknown as Animation,
        resolve,
        reject,
    };
}

const scroll = vi.fn();
const getAnimations = vi.fn<() => Animation[]>();
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const originalAnimations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getAnimations');

beforeEach(() => {
    vi.useFakeTimers();
    scroll.mockReset();
    getAnimations.mockReset().mockReturnValue([]);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: getAnimations });
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const [key, descriptor] of [
        ['scrollIntoView', originalScroll],
        ['getAnimations', originalAnimations],
    ] as const) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
        else Reflect.deleteProperty(HTMLElement.prototype, key);
    }
});

async function open() {
    fireEvent.click(screen.getByRole('button', { name: 'Expand Settings' }));
    await act(() => vi.advanceTimersByTimeAsync(300));
}

describe('Vessel section reveal lifecycle', () => {
    it('waits for the actual delayed expansion, not 280ms from the click', async () => {
        const transition = deferredAnimation();
        getAnimations.mockReturnValue([transition.animation]);
        render(<Harness />);
        await open();
        expect(scroll).not.toHaveBeenCalled();
        await act(async () => transition.resolve());
        expect(scroll).toHaveBeenCalledExactlyOnceWith({ behavior: 'smooth', block: 'end', inline: 'nearest' });
        expect(scroll.mock.instances[0]).toBe(screen.getByTestId('section'));
        expect(getAnimations.mock.instances[0]).toBe(screen.getByTestId('expansion'));
    });

    it('reveals without a fixed delay when reduced motion has no transition', async () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Expand Settings' }));
        await act(() => vi.advanceTimersByTimeAsync(20));
        expect(scroll).toHaveBeenCalledOnce();
    });

    it('does not wait for an infinite animation', async () => {
        getAnimations.mockReturnValue([deferredAnimation(Infinity).animation]);
        render(<Harness />);
        await open();
        expect(scroll).toHaveBeenCalledOnce();
    });

    it('does not reveal an initially expanded section without an opening tap', async () => {
        render(<Harness initialOpen />);
        await act(() => vi.advanceTimersByTimeAsync(500));
        expect(scroll).not.toHaveBeenCalled();
    });

    it('reveals exactly once for an opening tap under StrictMode', async () => {
        render(
            <React.StrictMode>
                <Harness />
            </React.StrictMode>,
        );
        await open();
        expect(scroll).toHaveBeenCalledOnce();
    });

    it('cancels a pending reveal when the section closes', async () => {
        const transition = deferredAnimation();
        getAnimations.mockReturnValue([transition.animation]);
        render(<Harness />);
        await open();
        fireEvent.click(screen.getByRole('button', { name: 'Collapse Settings' }));
        await act(async () => transition.resolve());
        expect(scroll).not.toHaveBeenCalled();
    });

    it('checks the committed collapsed DOM before passive effect cleanup', async () => {
        const transition = deferredAnimation();
        getAnimations.mockReturnValue([transition.animation]);
        render(<Harness />);
        await open();
        screen.getByRole('button', { name: 'Collapse Settings' }).setAttribute('aria-expanded', 'false');
        await act(async () => transition.resolve());
        expect(scroll).not.toHaveBeenCalled();
    });

    it('cancels a pending reveal when its pane unmounts', async () => {
        const transition = deferredAnimation();
        getAnimations.mockReturnValue([transition.animation]);
        const rendered = render(<Harness />);
        await open();
        rendered.unmount();
        await act(async () => transition.resolve());
        expect(scroll).not.toHaveBeenCalled();
    });

    it.each(['pointerdown', 'touchmove', 'wheel', 'keydown'])('does not override a newer %s gesture', async (event) => {
        const transition = deferredAnimation();
        getAnimations.mockReturnValue([transition.animation]);
        render(<Harness />);
        await open();
        fireEvent(screen.getByTestId('port'), new Event(event, { bubbles: true }));
        await act(async () => transition.resolve());
        expect(scroll).not.toHaveBeenCalled();
    });

    it('does not let a previous opening finish a newer reveal', async () => {
        const old = deferredAnimation();
        const current = deferredAnimation();
        getAnimations.mockReturnValueOnce([old.animation]).mockReturnValue([current.animation]);
        render(<Harness />);
        await open();
        fireEvent.click(screen.getByRole('button', { name: 'Collapse Settings' }));
        await open();
        await act(async () => old.resolve());
        expect(scroll).not.toHaveBeenCalled();
        await act(async () => current.resolve());
        expect(scroll).toHaveBeenCalledOnce();
    });

    it('remeasures and reveals when CSS cancels the transition while still open', async () => {
        const transition = deferredAnimation();
        getAnimations.mockReturnValue([transition.animation]);
        render(<Harness />);
        await open();
        await act(async () => transition.reject());
        expect(scroll).toHaveBeenCalledOnce();
    });
});
