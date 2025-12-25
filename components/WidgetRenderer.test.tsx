
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { WidgetRenderer, DashboardWidgetContext } from './WidgetRenderer';

// Mock the heavy child components to isolate Renderer logic
vi.mock('./dashboard/Advice', () => ({
    AdviceWidget: () => <div data-testid="advice-widget">Advice Widget</div>
}));

vi.mock('./dashboard/WeatherCharts', () => ({
    ForecastChartWidget: () => <div data-testid="charts-widget">Charts Widget</div>,
    HourlyWidget: () => <div>Hourly</div>,
    DailyWidget: () => <div>Daily</div>,
    MapWidget: () => <div data-testid="map-widget">Map Widget</div>
}));

vi.mock('./dashboard/WeatherGrid', () => ({
    BeaufortWidget: () => <div data-testid="beaufort-widget">Beaufort Widget</div>,
    DetailedMetricsWidget: () => <div data-testid="details-widget">Details Widget</div>
}));

vi.mock('./dashboard/TideAndVessel', () => ({
    VesselStatusWidget: () => <div data-testid="tides-widget">Tides Widget</div>
}));

// Create a robust mock context
const mockContext: DashboardWidgetContext = {
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
    lockerItems: ['PFD'],
    locationName: "Test Port",
    units: { speed: 'kts', length: 'ft', temp: 'C', distance: 'nm' },
    vessel: { name: 'Test Boat', type: 'sail', length: 30 } as any,
    isPro: true,
    chartData: [],
    chartView: 'hourly',
    hiddenSeries: {},
    isSpeaking: false,
    isBuffering: false,
    isAudioPreloading: false,
    isNightMode: false,
    backgroundUpdating: false,
    setChartView: vi.fn(),
    toggleChartSeries: vi.fn(),
    handleAudioBroadcast: vi.fn(),
    shareReport: vi.fn(),
    onTriggerUpgrade: vi.fn(),
    onOpenMap: vi.fn(),
    settings: {},
    weatherData: {}
};

describe('WidgetRenderer', () => {
    it('renders AdviceWidget when id is "advice"', () => {
        render(<WidgetRenderer id="advice" context={mockContext} />);
        expect(screen.getByTestId('advice-widget')).toBeInTheDocument();
    });

    it('renders Forecast Charts when id is "charts"', () => {
        render(<WidgetRenderer id="charts" context={mockContext} />);
        expect(screen.getByTestId('charts-widget')).toBeInTheDocument();
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

    it('renders Map Widget when id is "map"', () => {
        render(<WidgetRenderer id="map" context={mockContext} />);
        expect(screen.getByTestId('map-widget')).toBeInTheDocument();
    });

    it('renders nothing for an unknown widget ID', () => {
        const { container } = render(<WidgetRenderer id="unknown_widget_id" context={mockContext} />);
        expect(container).toBeEmptyDOMElement();
    });
});
