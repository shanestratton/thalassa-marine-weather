import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HomePortStep } from '../components/onboarding/HomePortStep';

vi.mock('../components/map/MapHub', () => ({
    MapHub: () => <button>Map surface</button>,
}));

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
});
