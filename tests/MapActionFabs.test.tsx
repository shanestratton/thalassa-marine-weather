/**
 * MapActionFabs — GPS locate and weather recenter FAB tests.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MapActionFabs } from '../components/map/MapActionFabs';

describe('MapActionFabs', () => {
    const defaultProps = {
        onLocateMe: vi.fn(),
        onRecenter: vi.fn(),
        recenterDisabled: false,
    };

    it('renders the GPS action and keeps the parked recenter action hidden', () => {
        render(<MapActionFabs {...defaultProps} />);
        expect(screen.getByLabelText('Locate me')).toBeInTheDocument();
        expect(screen.queryByLabelText('Recenter on weather location')).not.toBeInTheDocument();
    });

    it('calls onLocateMe when GPS button is clicked', () => {
        const onLocateMe = vi.fn();
        render(<MapActionFabs {...defaultProps} onLocateMe={onLocateMe} />);
        fireEvent.click(screen.getByLabelText('Locate me'));
        expect(onLocateMe).toHaveBeenCalledTimes(1);
    });

    it('positions at the bottom with safe area inset', () => {
        const { container } = render(<MapActionFabs {...defaultProps} />);
        const wrapper = container.firstChild as HTMLElement;
        expect(wrapper.style.bottom).toContain('calc(80px');
    });
});
