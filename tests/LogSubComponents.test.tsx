/**
 * LogSubComponents — Unit tests for StatBox and MenuBtn
 *
 * These are small, presentational components extracted from LogPage.
 * StatBox renders a label/value pair, MenuBtn renders an action button.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../components/Icons', () => ({
    CompassIcon: () => <span>🧭</span>,
    WindIcon: () => <span>💨</span>,
}));
vi.mock('../../context/FollowRouteContext', () => ({
    useFollowRoute: () => ({
        followRoute: null,
        setFollowRoute: vi.fn(),
        isFollowing: false,
        setIsFollowing: vi.fn(),
    }),
}));
vi.mock('../../components/DateGroupedTimeline', () => ({
    DateGroupedTimeline: () => <div data-testid="timeline">Timeline</div>,
}));
vi.mock('../../components/LiveMiniMap', () => ({
    LiveMiniMap: () => <div data-testid="live-mini-map">Map</div>,
}));
vi.mock('../../utils/voyageData', () => ({
    groupEntriesByDate: vi.fn().mockReturnValue([]),
}));

import { StatBox, MenuBtn } from '../pages/log/LogSubComponents';

describe('StatBox', () => {
    it('renders label and value', () => {
        render(<StatBox label="Distance" value="42.5" />);
        expect(screen.getByText('Distance')).toBeDefined();
        expect(screen.getByText('42.5')).toBeDefined();
    });

    it('renders numeric values', () => {
        render(<StatBox label="Speed" value={7} />);
        expect(screen.getByText('Speed')).toBeDefined();
        expect(screen.getByText('7')).toBeDefined();
    });

    it('renders without crashing', () => {
        const { container } = render(<StatBox label="Test" value="0" />);
        expect(container).toBeDefined();
    });
});

describe('MenuBtn', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders the label', () => {
        render(<MenuBtn label="Export" icon="📤" onClick={vi.fn()} />);
        expect(screen.getByText('Export')).toBeDefined();
    });

    it('fires onClick when clicked', () => {
        const onClick = vi.fn();
        render(<MenuBtn label="Share" icon="📤" onClick={onClick} />);
        fireEvent.click(screen.getByText('Share'));
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('renders icon', () => {
        render(<MenuBtn label="Import" icon="📥" onClick={vi.fn()} />);
        expect(screen.getByText('📥')).toBeDefined();
    });
});
