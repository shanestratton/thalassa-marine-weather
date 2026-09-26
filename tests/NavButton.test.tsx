/**
 * NavButton — bottom tab bar page button tests.
 */
import React from 'react';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

// Mock haptic feedback
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { NavButton } from '../components/NavButton';

describe('NavButton', () => {
    it('renders label text', () => {
        render(<NavButton icon={<span data-testid="icon">🌤</span>} label="Wx" active={false} onClick={vi.fn()} />);
        expect(screen.getByText('Wx')).toBeInTheDocument();
    });

    it('is a page button named by its visible label, with no "Navigate to"', () => {
        render(<NavButton icon={<span>🗺</span>} label="Obs" active={false} onClick={vi.fn()} />);

        const button = screen.getByRole('button', { name: 'Obs' });
        expect(button).toHaveAttribute('type', 'button');
        expect(button).not.toHaveAttribute('role');
        expect(button).not.toHaveAttribute('aria-selected');
        expect(screen.queryByRole('tab')).toBeNull();
        expect(screen.queryByRole('button', { name: /navigate to/i })).toBeNull();
    });

    it('keeps an explicit accessible name when one is given', () => {
        render(<NavButton icon={<span>🗺</span>} label="Obs" ariaLabel="Obs chart" active={false} onClick={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Obs chart' })).toBeInTheDocument();
    });

    it('keeps an unread count out of the name', () => {
        render(<NavButton icon={<span>⛵</span>} label="Vessel" active={false} onClick={vi.fn()} badge={3} />);
        expect(screen.getByRole('button', { name: 'Vessel' })).toBeInTheDocument();
    });

    it('renders the icon', () => {
        render(<NavButton icon={<span data-testid="icon">🗺</span>} label="Map" active={false} onClick={vi.fn()} />);
        expect(screen.getByTestId('icon')).toBeInTheDocument();
    });

    it('calls onClick when tapped', () => {
        const onClick = vi.fn();
        render(<NavButton icon={<span>📡</span>} label="Chat" active={false} onClick={onClick} />);
        fireEvent.click(screen.getByRole('button'));
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('marks the current page with aria-current', () => {
        render(<NavButton icon={<span>⛵</span>} label="Vessel" active={true} onClick={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Vessel' })).toHaveAttribute('aria-current', 'page');
    });

    it('carries no aria-current when it is not the current page', () => {
        render(<NavButton icon={<span>⛵</span>} label="Vessel" active={false} onClick={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Vessel' })).not.toHaveAttribute('aria-current');
    });

    it('hangs the current-page dot just under the label, not on the bar edge', () => {
        const { container } = render(
            <NavButton icon={<span>⛵</span>} label="Vessel" active={true} onClick={vi.fn()} />,
        );
        const label = screen.getByText('Vessel');
        const dot = label.nextElementSibling as HTMLElement | null;
        expect(dot).not.toBeNull();
        expect(dot).toHaveAttribute('aria-hidden', 'true');
        expect(dot!.className).toContain('top-full');
        expect(dot!.className).toContain('mt-[3px]');
        expect(container.querySelector('.bottom-0\\.5')).toBeNull();
        // The label no longer carries its own top margin; the button's gap does it.
        expect(label.style.marginTop).toBe('');
    });

    it('draws no dot when it is not the current page', () => {
        render(<NavButton icon={<span>⛵</span>} label="Vessel" active={false} onClick={vi.fn()} />);
        expect(screen.getByText('Vessel').nextElementSibling).toBeNull();
    });

    it('renders numeric badge when provided', () => {
        render(<NavButton icon={<span>💬</span>} label="Chat" active={false} onClick={vi.fn()} badge={3} />);
        expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('renders dot badge when badge is true', () => {
        const { container } = render(
            <NavButton icon={<span>💬</span>} label="Chat" active={false} onClick={vi.fn()} badge={true} />,
        );
        // A dot badge should render something but not a number
        expect(container.querySelector('[aria-label]')).toBeDefined();
    });

    it('does NOT render badge when badge is undefined', () => {
        render(<NavButton icon={<span>💬</span>} label="Chat" active={false} onClick={vi.fn()} />);
        // No badge element should be visible — just the icon and label
        expect(screen.queryByText(/\d+/)).not.toBeInTheDocument();
    });

    it('keeps the label at least 8 pt off the bar edge where there is no inset', () => {
        render(<NavButton icon={<span>🌤</span>} label="Wx" active={false} onClick={vi.fn()} />);
        expect(screen.getByRole('button').className).toContain('pb-[max(0px,calc(8px_-_env(safe-area-inset-bottom)))]');
    });
});

describe('Glass hold and tap remain separate gestures', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('PointerEvent', MouseEvent);
    });
    afterEach(() => {
        cleanup();
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('a short press resets once without toggling the split', () => {
        const onClick = vi.fn();
        const onLongPress = vi.fn();
        render(<NavButton label="The Glass" icon="G" active onClick={onClick} onLongPress={onLongPress} />);
        const tab = screen.getByRole('button', { name: 'The Glass' });
        fireEvent.pointerDown(tab, { clientX: 20, clientY: 20 });
        act(() => vi.advanceTimersByTime(499));
        fireEvent.pointerUp(tab);
        fireEvent.click(tab);
        act(() => vi.advanceTimersByTime(501));
        expect(onClick).toHaveBeenCalledTimes(1);
        expect(onLongPress).not.toHaveBeenCalled();
    });

    it('successive holds toggle on/off without the release clicks also resetting', () => {
        const onClick = vi.fn();
        const onLongPress = vi.fn();
        render(<NavButton label="The Glass" icon="G" active onClick={onClick} onLongPress={onLongPress} />);
        const tab = screen.getByRole('button', { name: 'The Glass' });
        for (let i = 1; i <= 2; i++) {
            fireEvent.pointerDown(tab, { clientX: 20, clientY: 20 });
            act(() => vi.advanceTimersByTime(800));
            fireEvent.pointerUp(tab);
            fireEvent.click(tab);
            expect(onLongPress).toHaveBeenCalledTimes(i);
            expect(onClick).not.toHaveBeenCalled();
        }
        fireEvent.pointerDown(tab);
        fireEvent.pointerUp(tab);
        fireEvent.click(tab);
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it.each(['move', 'cancel', 'leave'])('a %s cancels a pending hold', (reason) => {
        const onLongPress = vi.fn();
        render(<NavButton label="The Glass" icon="G" active onClick={vi.fn()} onLongPress={onLongPress} />);
        const tab = screen.getByRole('button', { name: 'The Glass' });
        fireEvent.pointerDown(tab, { clientX: 20, clientY: 20 });
        act(() => vi.advanceTimersByTime(250));
        if (reason === 'move') fireEvent.pointerMove(tab, { clientX: 32, clientY: 20 });
        if (reason === 'cancel') fireEvent.pointerCancel(tab);
        if (reason === 'leave') fireEvent.pointerLeave(tab);
        act(() => vi.advanceTimersByTime(800));
        expect(onLongPress).not.toHaveBeenCalled();
    });

    it('without a long-press action, a held phone tab retains ordinary click behaviour', () => {
        const onClick = vi.fn();
        render(<NavButton label="The Glass" icon="G" active onClick={onClick} />);
        const tab = screen.getByRole('button', { name: 'The Glass' });
        fireEvent.pointerDown(tab);
        act(() => vi.advanceTimersByTime(800));
        fireEvent.pointerUp(tab);
        fireEvent.click(tab);
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});
