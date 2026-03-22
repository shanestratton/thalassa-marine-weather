/**
 * GpsDisclaimerModal — GPS accuracy warning modal tests.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { GpsDisclaimerModal } from '../pages/log/GpsDisclaimerModal';

describe('GpsDisclaimerModal', () => {
    it('renders nothing when isOpen is false', () => {
        const { container } = render(<GpsDisclaimerModal isOpen={false} onDismiss={vi.fn()} />);
        expect(container.firstChild).toBeNull();
    });

    it('renders modal content when isOpen is true', () => {
        render(<GpsDisclaimerModal isOpen={true} onDismiss={vi.fn()} />);
        expect(screen.getByText('GPS Accuracy Notice')).toBeInTheDocument();
        expect(screen.getByText(/Phone GPS accuracy/)).toBeInTheDocument();
        expect(screen.getByText(/NMEA GPS/)).toBeInTheDocument();
    });

    it('renders the dismiss button', () => {
        render(<GpsDisclaimerModal isOpen={true} onDismiss={vi.fn()} />);
        expect(screen.getByText(/Got it/)).toBeInTheDocument();
    });

    it('calls onDismiss when button is clicked', () => {
        const onDismiss = vi.fn();
        render(<GpsDisclaimerModal isOpen={true} onDismiss={onDismiss} />);
        fireEvent.click(screen.getByLabelText('Dismiss GPS disclaimer'));
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('renders the "don\'t show again" checkbox', () => {
        render(<GpsDisclaimerModal isOpen={true} onDismiss={vi.fn()} />);
        expect(screen.getByText(/Don't show this again/)).toBeInTheDocument();
    });
});
