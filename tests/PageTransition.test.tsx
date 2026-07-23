/**
 * PageTransition — CSS-only page transition tests.
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { PageTransition } from '../components/ui/PageTransition';

describe('PageTransition', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('renders children', () => {
        render(
            <PageTransition pageKey="dashboard" direction="tab">
                <p>Dashboard Content</p>
            </PageTransition>,
        );
        expect(screen.getByText('Dashboard Content')).toBeInTheDocument();
    });

    it('renders with tab direction without sliding', () => {
        const { container } = render(
            <PageTransition pageKey="settings" direction="tab">
                <p>Settings</p>
            </PageTransition>,
        );
        expect(container.firstChild).toBeDefined();
        expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    it('renders with push direction', () => {
        const { container } = render(
            <PageTransition pageKey="details" direction="push">
                <p>Details Page</p>
            </PageTransition>,
        );
        expect(container.firstChild).toBeDefined();
        expect(screen.getByText('Details Page')).toBeInTheDocument();
    });

    it('renders with pop direction', () => {
        render(
            <PageTransition pageKey="vessel" direction="pop">
                <p>Vessel Hub</p>
            </PageTransition>,
        );
        expect(screen.getByText('Vessel Hub')).toBeInTheDocument();
    });

    it('handles swipe back disabled by default', () => {
        const { container } = render(
            <PageTransition pageKey="test" direction="push">
                <p>Content</p>
            </PageTransition>,
        );
        // Should render without errors even without swipe back handler
        expect(container).toBeDefined();
    });

    it('accepts onSwipeBack callback without errors', () => {
        expect(() => {
            render(
                <PageTransition pageKey="test" direction="push" canSwipeBack onSwipeBack={() => {}}>
                    <p>Content</p>
                </PageTransition>,
            );
        }).not.toThrow();
    });

    it('does not leave a transform containing block behind while idle', () => {
        const { container } = render(
            <PageTransition pageKey="dashboard" direction="push">
                <p>Content</p>
            </PageTransition>,
        );

        const transition = container.firstElementChild as HTMLElement;
        expect(transition).toHaveAttribute('data-transition-phase', 'idle');
        expect(transition).toHaveStyle({ transform: 'none', willChange: 'auto' });
        expect(transition).not.toHaveClass('will-change-transform');
    });

    it('removes transform and will-change after a slide finishes', () => {
        vi.useFakeTimers();
        let nextFrameId = 0;
        const frames = new Map<number, FrameRequestCallback>();
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            const id = ++nextFrameId;
            frames.set(id, callback);
            return id;
        });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
            frames.delete(id);
        });
        const flushFrame = () => {
            const pending = Array.from(frames.values());
            frames.clear();
            pending.forEach((callback) => callback(performance.now()));
        };

        const { container, rerender } = render(
            <PageTransition pageKey="dashboard" direction="push">
                <p>Dashboard</p>
            </PageTransition>,
        );

        rerender(
            <PageTransition pageKey="settings" direction="push">
                <p>Settings</p>
            </PageTransition>,
        );

        let transition = container.firstElementChild as HTMLElement;
        expect(transition).toHaveAttribute('data-transition-phase', 'entering');
        expect(transition.style.transform).toBe('translate3d(100%, 0, 0)');

        act(flushFrame);
        act(flushFrame);
        transition = container.firstElementChild as HTMLElement;
        expect(transition).toHaveAttribute('data-transition-phase', 'animating');
        expect(transition.style.willChange).toBe('transform, opacity');

        act(() => vi.advanceTimersByTime(280));
        transition = container.firstElementChild as HTMLElement;
        expect(transition).toHaveAttribute('data-transition-phase', 'idle');
        expect(transition).toHaveStyle({ transform: 'none', willChange: 'auto' });
    });
});
