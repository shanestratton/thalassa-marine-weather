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

    it('renders both action buttons', () => {
        render(<MapActionFabs {...defaultProps} />);
        expect(screen.getByLabelText('Locate me')).toBeInTheDocument();
        expect(screen.getByLabelText('Recenter on weather location')).toBeInTheDocument();
    });

    it('calls onLocateMe when GPS button is clicked', () => {
        const onLocateMe = vi.fn();
        render(<MapActionFabs {...defaultProps} onLocateMe={onLocateMe} />);
        fireEvent.click(screen.getByLabelText('Locate me'));
        expect(onLocateMe).toHaveBeenCalledTimes(1);
    });

    it('calls onRecenter when recenter button is clicked', () => {
        const onRecenter = vi.fn();
        render(<MapActionFabs {...defaultProps} onRecenter={onRecenter} />);
        fireEvent.click(screen.getByLabelText('Recenter on weather location'));
        expect(onRecenter).toHaveBeenCalledTimes(1);
    });

    it('disables recenter button when recenterDisabled is true', () => {
        render(<MapActionFabs {...defaultProps} recenterDisabled={true} />);
        expect(screen.getByLabelText('Recenter on weather location')).toBeDisabled();
    });

    it('does NOT disable recenter button when recenterDisabled is false', () => {
        render(<MapActionFabs {...defaultProps} recenterDisabled={false} />);
        expect(screen.getByLabelText('Recenter on weather location')).not.toBeDisabled();
    });

    it('positions at the bottom with safe area inset', () => {
        const { container } = render(<MapActionFabs {...defaultProps} />);
        const wrapper = container.firstChild as HTMLElement;
        expect(wrapper.style.bottom).toContain('calc(80px');
    });
});
