import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { BeaufortWidget } from './WeatherGrid';

describe('BeaufortWidget', () => {
    it('renders Beaufort scale for moderate wind', () => {
        render(<BeaufortWidget windSpeed={15} />);
        // Force 4 = "Moderate breeze" (11–16 kts)
        expect(screen.getByText(/moderate/i)).toBeDefined();
    });

    it('renders calm state for null wind', () => {
        render(<BeaufortWidget windSpeed={null} />);
        expect(screen.getByText(/calm/i)).toBeDefined();
    });

    it('renders calm state for zero wind', () => {
        render(<BeaufortWidget windSpeed={0} />);
        expect(screen.getByText(/calm/i)).toBeDefined();
    });

    it('renders gale for high wind', () => {
        render(<BeaufortWidget windSpeed={40} />);
        // Force 8+ should show gale/storm
        const container = screen.getByText(/gale|storm|hurricane/i);
        expect(container).toBeDefined();
    });
});
