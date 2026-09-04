/**
 * The ENC layer has an off switch again — with a writer this time.
 *
 * MapHub carried `const encVisible = true;` and a note: restore the persisted
 * state "only alongside a real control, and give it a writer in the same
 * commit". This is that commit.
 *
 * The reason is not the old one (comparing against raster underneath). On
 * 2026-09-04 a jetsam report showed com.apple.WebKit.WebContent killed at
 * exactly 2048.0 MB with reason "per-process-limit" — the webview hitting
 * iOS's hard 2GB ceiling, twice, while the native process sat at 93 MB. That
 * session's flight recorder is dominated by enc:merge-start (9 cells, 25.3 MB
 * per merge) and enc:merge-breathe backing off under pressure.
 *
 * A layer that can allocate at that scale must be switchable off — so a
 * skipper can rescue their own session, and so the layer can be ruled in or
 * out without a rebuild.
 */
import { readFileSync } from 'node:fs';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChartDepthControls, type ChartDepthControlsProps } from '../components/map/ChartDepthControls';

const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
const hubCode = hub.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function props(over: Partial<ChartDepthControlsProps> = {}): ChartDepthControlsProps {
    return {
        surfaceVisible: true,
        chartKeyVisible: false,
        plotting: false,
        tideDepthMode: false,
        tideOffsetInfo: null,
        tideScrubQ: 0,
        onTideScrubChange: vi.fn(),
        onToggleTideDepth: vi.fn(),
        encCellCount: 9,
        encReferenceCellCount: 0,
        encVisible: true,
        encHydration: { total: 9, remaining: 0 },
        encNoCoverage: false,
        referenceNoticeVisible: false,
        nightDim: false,
        onNightDimChange: vi.fn(),
        onToggleChartKey: vi.fn(),
        onOpenEncLibrary: vi.fn(),
        onToggleEncVisible: vi.fn(),
        ...over,
    } as ChartDepthControlsProps;
}

describe('the ENC master switch', () => {
    it('is persisted state with a real writer, not a hardcoded true', () => {
        expect(hubCode).toMatch(/usePersistedState\('thalassa_map_enc_visible', true\)/);
        expect(hubCode).toMatch(/setEncVisible\(\(on\) => !on\)/);
        expect(hubCode).not.toMatch(/const encVisible = true;/);
    });

    it('renders and toggles', () => {
        const onToggleEncVisible = vi.fn();
        render(<ChartDepthControls {...props({ onToggleEncVisible })} />);
        const button = screen.getByLabelText('Turn ENC charts off');
        fireEvent.click(button);
        expect(onToggleEncVisible).toHaveBeenCalledOnce();
    });

    it('is STILL offered once the charts are off — or it would be a one-way door', () => {
        render(<ChartDepthControls {...props({ encVisible: false })} />);
        expect(screen.getByLabelText('Turn ENC charts on')).toBeInTheDocument();
    });

    it('says which state it is in, rather than only what tapping does', () => {
        const { rerender } = render(<ChartDepthControls {...props()} />);
        expect(screen.getByText(/ENC ON/)).toBeInTheDocument();
        rerender(<ChartDepthControls {...props({ encVisible: false })} />);
        expect(screen.getByText(/ENC OFF/)).toBeInTheDocument();
    });

    it('stays out of the way when there are no charts to switch', () => {
        render(<ChartDepthControls {...props({ encCellCount: 0 })} />);
        expect(screen.queryByLabelText(/Turn ENC charts/)).toBeNull();
    });
});
