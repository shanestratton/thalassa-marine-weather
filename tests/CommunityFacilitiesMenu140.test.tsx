import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { RadialHelmMenu } from '../components/map/RadialHelmMenu';
import type { WeatherLayer } from '../components/map/mapConstants';

it('offers one independent Community notes and Facilities entry, counts each once and clears each once', async () => {
    const notes = vi.fn(),
        facilities = vi.fn(),
        weather = vi.fn();
    function Menu() {
        const [communityNotesVisible, setNotes] = React.useState(false);
        const [facilitiesVisible, setFacilities] = React.useState(false);
        return (
            <RadialHelmMenu
                activeLayers={new Set<WeatherLayer>()}
                toggleLayer={weather}
                selectInGroup={vi.fn()}
                tacticalState={{
                    communityNotesVisible,
                    facilitiesVisible,
                    onToggleCommunityNotes: () => {
                        notes();
                        setNotes((v) => !v);
                    },
                    onToggleFacilities: () => {
                        facilities();
                        setFacilities((v) => !v);
                    },
                }}
            />
        );
    }
    render(<Menu />);
    fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sea layers' }));
    expect(screen.getAllByRole('menuitemcheckbox', { name: 'Community notes, off' })).toHaveLength(1);
    expect(screen.getAllByRole('menuitemcheckbox', { name: 'Facilities, off' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Community notes, off' }));
    expect(notes).toHaveBeenCalledTimes(1);
    expect(facilities).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Community notes, on' })).toHaveAttribute(
        'aria-checked',
        'true',
    );
    expect(screen.getByRole('menuitemcheckbox', { name: 'Facilities, off' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menuitem', { name: 'Clear all · 1 active' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Facilities, off' }));
    expect(facilities).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('menuitem', { name: 'Clear all · 2 active' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear all · 2 active' }));
    expect(notes).toHaveBeenCalledTimes(2);
    expect(facilities).toHaveBeenCalledTimes(2);
    expect(weather).toHaveBeenCalledOnce();
    expect(weather).toHaveBeenCalledWith('none');
    await waitFor(() => {
        expect(screen.getByRole('menuitemcheckbox', { name: 'Community notes, off' })).toHaveAttribute(
            'aria-checked',
            'false',
        );
        expect(screen.getByRole('menuitemcheckbox', { name: 'Facilities, off' })).toHaveAttribute(
            'aria-checked',
            'false',
        );
    });
});
