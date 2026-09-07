import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RemotePassageCard } from '../pages/log/RemotePassageCard';
import type { RemotePassage } from '../services/shiplog/remotePassage';

const passage = (overrides: Partial<RemotePassage> = {}): RemotePassage => ({
    voyageId: 'voyage-1',
    voyageName: 'Newport → Whitsundays',
    departurePort: 'Newport',
    destinationPort: 'Airlie Beach',
    departureTime: null,
    savedRouteId: 'route-1',
    recordingDeviceName: "Shane's iPhone",
    recordingDeviceId: 'dev-iphone',
    link: {
        voyageId: 'voyage-1',
        planVoyageId: 'plan-1',
        deviceId: 'dev-iphone',
        deviceName: "Shane's iPhone",
        updatedAt: '2026-09-08T01:15:00.000Z',
    },
    linkHeldElsewhere: true,
    fetchedAt: '2026-09-08T04:00:00.000Z',
    ...overrides,
});

describe('RemotePassageCard — the account’s passage, under way on another device', () => {
    it('names the recorder, the route and who set it, and offers the two doors', () => {
        const onRecordHere = vi.fn();
        const onChangeRoute = vi.fn();
        render(
            <RemotePassageCard
                passage={passage()}
                routeLabel="Newport - Whitsundays (3 legs)"
                busy={false}
                onRecordHere={onRecordHere}
                onChangeRoute={onChangeRoute}
            />,
        );
        expect(screen.getByText('Under way on another device')).toBeInTheDocument();
        expect(screen.getByText('Newport → Whitsundays')).toBeInTheDocument();
        expect(screen.getByTestId('remote-passage-recorder')).toHaveTextContent("Recording on Shane's iPhone");
        expect(screen.getByTestId('remote-passage-route')).toHaveTextContent(
            "Following Newport - Whitsundays (3 legs) · set by Shane's iPhone",
        );
        fireEvent.click(screen.getByTestId('remote-passage-record'));
        fireEvent.click(screen.getByTestId('remote-passage-change-route'));
        expect(onRecordHere).toHaveBeenCalledTimes(1);
        expect(onChangeRoute).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('remote-passage-change-route')).toHaveTextContent('Change the route');
    });

    it('with no published route it says so and offers to follow one', () => {
        render(
            <RemotePassageCard
                passage={passage({ link: null, linkHeldElsewhere: false, recordingDeviceName: null })}
                routeLabel={null}
                busy={false}
                onRecordHere={vi.fn()}
                onChangeRoute={vi.fn()}
            />,
        );
        expect(screen.getByTestId('remote-passage-recorder')).toHaveTextContent('Recording on another device');
        expect(screen.getByTestId('remote-passage-route')).toHaveTextContent('No route on the public page yet');
        expect(screen.getByTestId('remote-passage-change-route')).toHaveTextContent('Follow a route');
    });

    it('an unstamped link names no setter and the buttons go quiet while joining', () => {
        render(
            <RemotePassageCard
                passage={passage({ linkHeldElsewhere: false })}
                routeLabel={null}
                busy
                onRecordHere={vi.fn()}
                onChangeRoute={vi.fn()}
            />,
        );
        expect(screen.getByTestId('remote-passage-route')).toHaveTextContent('Following a saved route');
        expect(screen.getByTestId('remote-passage-route')).not.toHaveTextContent('set by');
        expect(screen.getByTestId('remote-passage-record')).toBeDisabled();
        expect(screen.getByTestId('remote-passage-record')).toHaveTextContent('Starting…');
    });
});
