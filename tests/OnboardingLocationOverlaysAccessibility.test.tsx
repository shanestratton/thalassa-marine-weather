import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomePortStep } from '../components/onboarding/HomePortStep';
import { OnboardingTooltips } from '../components/ui/OnboardingTooltips';

vi.mock('../components/map/MapHub', () => ({
    MapHub: () => <button>Map surface</button>,
}));

afterEach(() => {
    vi.useRealTimers();
    localStorage.removeItem('thalassa_tooltip_tour_v2');
});

function HomePortHarness() {
    const [showMap, setShowMap] = useState(false);

    return (
        <HomePortStep
            homePort="Brisbane"
            onHomePortChange={() => {}}
            isLocating={false}
            showMap={showMap}
            onShowMap={setShowMap}
            tempLocation={null}
            onLocate={() => {}}
            onMapSelect={() => {}}
            onConfirmMapSelection={() => {}}
            prefix=""
            onPrefixChange={() => {}}
            firstName="Shane"
            onFirstNameChange={() => {}}
            lastName="Stratton"
            onLastNameChange={() => {}}
            nickname=""
            onNicknameChange={() => {}}
            onNext={() => {}}
        />
    );
}

function TooltipHarness() {
    const [show, setShow] = useState(false);

    return (
        <>
            <button onClick={() => setShow(true)}>Start tips</button>
            {show && <OnboardingTooltips onComplete={() => setShow(false)} />}
        </>
    );
}

describe('onboarding location overlays', () => {
    it('contains the home-port map, dismisses with Escape, and restores its opener', async () => {
        render(<HomePortHarness />);

        const opener = screen.getByRole('button', { name: 'Pick home port on map' });
        opener.focus();
        fireEvent.click(opener);

        expect(await screen.findByRole('dialog', { name: 'Tap the chart to pick your home port' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Close map' })).toHaveFocus();
        expect(screen.getByRole('textbox', { name: 'Home Port' })).toBeInTheDocument();

        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Tap the chart to pick your home port' })).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });

    it('announces and contains the tooltip tour, then restores focus on dismissal', () => {
        vi.useFakeTimers();
        render(<TooltipHarness />);

        const opener = screen.getByRole('button', { name: 'Start tips' });
        opener.focus();
        fireEvent.click(opener);
        act(() => {
            vi.advanceTimersByTime(400);
        });

        expect(screen.getByRole('dialog', { name: 'Swipe for Views' })).toHaveAccessibleDescription(
            'Swipe left and right on the forecast cards to scrub through hours. Swipe vertically for different days.',
        );
        const next = screen.getByRole('button', { name: 'Next onboarding tip' });
        expect(next).toHaveFocus();

        fireEvent.click(next);
        expect(screen.getByRole('dialog', { name: 'Passage Planner' })).toBeInTheDocument();
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
        expect(localStorage.getItem('thalassa_tooltip_tour_v2')).toBe('done');

        act(() => {
            vi.advanceTimersByTime(300);
        });
        expect(screen.queryByText('Passage Planner')).not.toBeInTheDocument();
    });
});
