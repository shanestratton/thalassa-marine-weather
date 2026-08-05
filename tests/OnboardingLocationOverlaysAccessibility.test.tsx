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

    it('does not let a resolving map label become the saved home port', () => {
        const onConfirm = vi.fn();
        render(
            <HomePortStep
                homePort=""
                onHomePortChange={() => {}}
                isLocating={false}
                showMap
                onShowMap={() => {}}
                tempLocation={{ lat: -27.47, lon: 153.03, name: 'Identifying...' }}
                onLocate={() => {}}
                onMapSelect={() => {}}
                onConfirmMapSelection={onConfirm}
                prefix=""
                onPrefixChange={() => {}}
                firstName="Shane"
                onFirstNameChange={() => {}}
                lastName="Stratton"
                onLastNameChange={() => {}}
                nickname=""
                onNicknameChange={() => {}}
                onNext={() => {}}
            />,
        );

        const confirm = screen.getByRole('button', { name: 'Confirm Identifying... as home port' });
        expect(confirm).toBeDisabled();
        expect(confirm).toHaveAttribute('aria-busy', 'true');
        fireEvent.click(confirm);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('marks identity and home-port inputs as required', () => {
        render(<HomePortHarness />);

        expect(screen.getByRole('textbox', { name: 'First name (required)' })).toBeRequired();
        expect(screen.getByRole('textbox', { name: 'Surname (required)' })).toBeRequired();
        expect(screen.getByRole('textbox', { name: 'Home Port' })).toBeRequired();
    });
});
