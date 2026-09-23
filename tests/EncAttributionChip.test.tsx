import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type mapboxgl from 'mapbox-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EncAttributionChip } from '../components/map/EncAttributionChip';
import type { EncCell } from '../services/enc/types';
import { setEncDisplayState } from '../components/map/encDisplayState';

const mocks = vi.hoisted(() => ({
    cells: [] as EncCell[],
    notify: undefined as (() => void) | undefined,
}));

vi.mock('../services/enc/EncHazardService', () => ({
    getDisplayCoverage: () => mocks.cells,
    subscribe: (callback: () => void) => {
        mocks.notify = callback;
        return () => {
            mocks.notify = undefined;
        };
    },
}));

function cell(overrides: Partial<EncCell> = {}): EncCell {
    return {
        id: 'AU5TEST1',
        sourceHO: 'AU',
        edition: 3,
        issued: '2026-09-01',
        importedAt: '2026-09-01T00:00:00Z',
        bbox: [153, -28, 154, -27],
        geojsonPath: 'enc-cells/AU5TEST1.geojson',
        hazardCount: 1,
        usage: 'navigation',
        catzocRange: [1, 2],
        ...overrides,
    };
}

function mapRef() {
    return {
        current: {
            getBounds: () => ({
                getWest: () => 153.1,
                getEast: () => 153.2,
                getSouth: () => -27.5,
                getNorth: () => -27.4,
            }),
            on: vi.fn(),
            off: vi.fn(),
        } as unknown as mapboxgl.Map,
    };
}

beforeEach(() => {
    mocks.cells = [];
    mocks.notify = undefined;
});
afterEach(cleanup);

describe('ENC chart identity and authority', () => {
    it('calls installed chart data ENC and identifies the app renderer without inventing a producer', () => {
        mocks.cells = [cell({ sourceHO: 'OC', id: 'OC-61-TEST' })];
        render(<EncAttributionChip mapRef={mapRef()} mapReady />);
        const chip = screen.getByRole('button');
        expect(chip).toHaveTextContent('ENC: chart unavailable at this view');
        fireEvent.click(chip);
        expect(screen.getByText('OC ed.3 (2026)')).toBeInTheDocument();
        expect(screen.getByText('OC-61-TEST')).toBeInTheDocument();
        expect(screen.getByText(/Imported ENC layers, rendered by Thalassa/)).toBeInTheDocument();
        expect(screen.queryByText(/Source: hydrographic offices/)).not.toBeInTheDocument();
    });

    it('attributes a reference-only chart without calling it navigation coverage or using its confidence', () => {
        mocks.cells = [cell({ usage: 'reference', sourceHO: 'USER', catzocRange: [1, 1] })];
        render(<EncAttributionChip mapRef={mapRef()} mapReady />);
        const chip = screen.getByRole('button');
        expect(chip).toHaveTextContent('Reference: chart unavailable at this view');
        expect(chip).toHaveTextContent('display only');
        expect(chip).toHaveClass('border-amber-400/40');
        fireEvent.click(chip);
        expect(screen.getByText(/Reference display only. These imports do not establish/)).toBeInTheDocument();
        expect(screen.queryByText(/Available ENC confidence/)).not.toBeInTheDocument();
    });

    it('keeps trusted source, edition and confidence separate from overlapping reference data', () => {
        mocks.cells = [
            cell({ catzocRange: [4, 4] }),
            cell({ id: 'REF-1', usage: 'reference', sourceHO: 'USER', edition: 99, catzocRange: [1, 1] }),
        ];
        render(<EncAttributionChip mapRef={mapRef()} mapReady />);
        const chip = screen.getByRole('button');
        expect(chip).toHaveTextContent('ENC:');
        expect(chip).not.toHaveTextContent('ed.99');
        fireEvent.click(chip);
        expect(screen.getByText('AU ed.3 (2026) · 1 reference')).toBeInTheDocument();
        expect(screen.getByText(/Available ENC confidence: CATZOC C/)).toBeInTheDocument();
        expect(screen.getByText(/reference only — not navigation coverage/)).toBeInTheDocument();
    });

    it('distinguishes 23 available imports from 4 loaded cells at overview scale', () => {
        mocks.cells = Array.from({ length: 23 }, (_, i) => cell({ id: `AU-${i}` }));
        const ref = mapRef();
        setEncDisplayState(ref.current, { phase: 'loaded', overview: true, loadedCells: 4 });
        render(<EncAttributionChip mapRef={ref} mapReady />);
        const chip = screen.getByRole('button');
        expect(chip).toHaveTextContent('ENC: Overview · 4 loaded');
        expect(chip).not.toHaveTextContent('23');
        fireEvent.click(chip);
        expect(screen.getByText('Available imports · 23 cells')).toBeInTheDocument();
        expect(screen.getByText(/counts are not rendered coverage/)).toBeInTheDocument();
        act(() => setEncDisplayState(ref.current, { phase: 'off', overview: false, loadedCells: 0 }));
        expect(chip).toHaveTextContent('display off');
        expect(chip).not.toHaveTextContent('loaded');
    });

    it('does not claim ENC when no imported chart overlaps this viewport', () => {
        mocks.cells = [cell({ bbox: [100, 10, 101, 11] })];
        render(<EncAttributionChip mapRef={mapRef()} mapReady />);
        expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();
        act(() => {
            mocks.cells = [cell()];
            mocks.notify?.();
        });
        expect(screen.getByRole('button')).toHaveTextContent('ENC:');
        act(() => {
            mocks.cells = [];
            mocks.notify?.();
        });
        expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();
    });
});
