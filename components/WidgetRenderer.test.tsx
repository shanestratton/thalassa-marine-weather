
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { WidgetRenderer, DashboardWidgetContextType } from './WidgetRenderer';

// Mock the heavy child components to isolate Renderer logic
vi.mock('./dashboard/Advice', () => ({
    AdviceWidget: () => <div data-testid="advice-widget">Advice Widget</div>
}));

vi.mock('./dashboard/WeatherCharts', () => ({
    HourlyWidget: () => <div>Hourly</div>,
    DailyWidget: () => <div>Daily</div>,
    MapWidget: () => <div data-testid="map-widget">Map Widget</div>
}));

vi.mock('./dashboard/WeatherGrid', () => ({
    BeaufortWidget: () => <div data-testid="beaufort-widget">Beaufort Widget</div>,
    DetailedMetricsWidget: () => <div data-testid="details-widget">Details Widget</div>
}));

vi.mock('./dashboard/TideAndVessel', () => ({
    VesselStatusWidget: () => <div data-testid="vessel-widget">Vessel Widget</div>,
    TideWidget: () => <div data-testid="tides-widget">Tides Widget</div>
}));

// Create a robust mock context
const mockContext: DashboardWidgetContextType = {
    current: {
        windSpeed: 15,
        windDirection: 'N',
        waveHeight: 3,
        uvIndex: 5,
        pressure: 1013,
        condition: 'Sunny',
        description: 'Clear skies'
    } as any,
    forecast: [],
    hourly: [],
    tides: [],
    tideHourly: [],
    boatingAdvice: "Stay safe",
    lockerItems: [{ name: 'PFD', icon: '🦺', category: 'Safety' }],
    locationName: "Test Port",
    units: { speed: 'kts', length: 'ft', waveHeight: 'ft', temp: 'C', distance: 'nm' },
    vessel: { name: 'Test Boat', type: 'sail', length: 30 } as any,
    isPro: true,
    isSpeaking: false,
    isBuffering: false,
    isAudioPreloading: false,
    isNightMode: false,
    backgroundUpdating: false,
    handleAudioBroadcast: vi.fn(),
    shareReport: vi.fn(),
    onTriggerUpgrade: vi.fn(),
    onOpenMap: vi.fn(),
    settings: {},
};

describe('WidgetRenderer', () => {
    it('renders AdviceWidget when id is "advice"', () => {
        render(<WidgetRenderer id="advice" context={mockContext} />);
        expect(screen.getByTestId('advice-widget')).toBeInTheDocument();
    });



    it('renders Beaufort Widget when id is "beaufort"', () => {
        render(<WidgetRenderer id="beaufort" context={mockContext} />);
        expect(screen.getByTestId('beaufort-widget')).toBeInTheDocument();
    });

    it('renders Details Widget when id is "details"', () => {
        render(<WidgetRenderer id="details" context={mockContext} />);
        expect(screen.getByTestId('details-widget')).toBeInTheDocument();
    });

    it('renders Tides Widget when id is "tides"', () => {
        render(<WidgetRenderer id="tides" context={mockContext} />);
        expect(screen.getByTestId('tides-widget')).toBeInTheDocument();
    });

    it('renders Map Widget when id is "map"', async () => {
        render(<WidgetRenderer id="map" context={mockContext} />);
        const mapWidget = await screen.findByTestId('map-widget');
        expect(mapWidget).toBeInTheDocument();
    });

    it('renders nothing for an unknown widget ID', () => {
        const { container } = render(<WidgetRenderer id="unknown_widget_id" context={mockContext} />);
        expect(container).toBeEmptyDOMElement();
    });
});
