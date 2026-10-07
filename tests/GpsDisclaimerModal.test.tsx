/**
 * GpsDisclaimerModal — the phone notice, shown only when this phone is the
 * voyage's source (build 123, package VL; Shane 2026-10-07 saw the old "GPS
 * Accuracy Notice" while the boat's own GPS was feeding the log).
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

    it('says the phone is the source, honestly, and how to use the boat instead', () => {
        render(<GpsDisclaimerModal isOpen={true} onDismiss={vi.fn()} />);
        expect(screen.getByRole('dialog', { name: 'Logging from this phone' })).toBeInTheDocument();
        expect(screen.getByText(/less accurate on the water than a boat.s own receiver/)).toBeInTheDocument();
        expect(screen.getByText(/through a Wi-Fi gateway or a Thalassa Pi/)).toBeInTheDocument();
        expect(screen.getByText(/the log will use your boat instead/)).toBeInTheDocument();
    });

    it('never calls a Bad Elf a Wi-Fi gateway (it is a Bluetooth receiver that feeds the phone)', () => {
        render(<GpsDisclaimerModal isOpen={true} onDismiss={vi.fn()} alwaysAdvice />);
        const text = screen.getByRole('dialog').textContent ?? '';
        expect(text).not.toMatch(/Bad Elf/i);
        expect(text).not.toMatch(/WiFi gateway/);
        // No brand list at all: a global app names no gateway maker here.
        expect(text).not.toMatch(/YDWG|Vesper/);
    });

    it('advises Always (never demands it) when asked to, with the exact Settings path', () => {
        const { rerender } = render(<GpsDisclaimerModal isOpen={true} onDismiss={vi.fn()} />);
        expect(screen.queryByText(/set Location to Always/)).toBeNull();
        rerender(<GpsDisclaimerModal isOpen={true} onDismiss={vi.fn()} alwaysAdvice />);
        expect(
            screen.getByText(
                /To keep recording if iOS closes Thalassa, set Location to Always: Settings › Privacy & Security › Location Services › Thalassa › Always\./,
            ),
        ).toBeInTheDocument();
    });

    it('starts tracking from its one button', () => {
        const onDismiss = vi.fn();
        render(<GpsDisclaimerModal isOpen={true} onDismiss={onDismiss} />);
        fireEvent.click(screen.getByRole('button', { name: 'Start tracking' }));
        expect(onDismiss).toHaveBeenCalledTimes(1);
        expect(onDismiss).toHaveBeenCalledWith(false);
    });

    it('keeps the "don\'t show again" checkbox', () => {
        render(<GpsDisclaimerModal isOpen={true} onDismiss={vi.fn()} />);
        expect(screen.getByText(/Don't show this again/)).toBeInTheDocument();
    });
});
