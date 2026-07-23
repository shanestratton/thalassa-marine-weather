import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ChartDepthControls,
    LiveTideAckModal,
    TIDE_DEPTH_ACK_KEY,
    type ChartDepthControlsProps,
} from '../components/map/ChartDepthControls';

const triggerHaptic = vi.hoisted(() => vi.fn());
vi.mock('../utils/system', () => ({ triggerHaptic }));

function props(overrides: Partial<ChartDepthControlsProps> = {}): ChartDepthControlsProps {
    return {
        surfaceVisible: true,
        plotting: false,
        tideDepthMode: true,
        tideOffsetInfo: {
            offsetM: 1.2,
            trend: 'rising',
            stationName: 'Brisbane Bar',
            approx: false,
        } as ChartDepthControlsProps['tideOffsetInfo'],
        tideScrubQ: 0,
        onTideScrubChange: vi.fn(),
        onToggleTideDepth: vi.fn(),
        encCellCount: 1,
        encVisible: true,
        encHydration: { total: 0, remaining: 0 },
        encNoCoverage: false,
        nightDim: false,
        onNightDimChange: vi.fn(),
        onToggleChartKey: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    triggerHaptic.mockClear();
    localStorage.clear();
});

describe('ChartDepthControls', () => {
    it('shows live tide context and toggles back to chart datum', () => {
        const input = props();
        render(<ChartDepthControls {...input} />);

        expect(screen.getByText(/LIVE DEPTH \+1.2 m ↑ · Brisbane Bar/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Live tide depth is on/ }));
        expect(triggerHaptic).toHaveBeenCalledWith('light');
        expect(input.onToggleTideDepth).toHaveBeenCalledOnce();
        expect(input.onTideScrubChange).not.toHaveBeenCalled();
    });

    it('returns a future tide scrub to now without disabling live depths', () => {
        const input = props({ tideScrubQ: 8 });
        render(<ChartDepthControls {...input} />);

        fireEvent.click(screen.getByRole('button', { name: /future tide/ }));
        expect(input.onTideScrubChange).toHaveBeenCalledWith(0);
        expect(input.onToggleTideDepth).not.toHaveBeenCalled();

        fireEvent.change(screen.getByRole('slider', { name: /Scrub the tide/ }), {
            target: { value: '12' },
        });
        expect(input.onTideScrubChange).toHaveBeenCalledWith(12);
    });

    it('makes missing tide data explicit and still allows the mode to be disabled', () => {
        const input = props({ tideOffsetInfo: null });
        render(<ChartDepthControls {...input} />);

        expect(screen.getByText('LIVE DEPTH — no tide data, showing chart datum')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Live tide depth is on/ }));
        expect(input.onToggleTideDepth).toHaveBeenCalledOnce();
        expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    });

    it('reports hydration, coverage gaps, chart key, and night dim state', () => {
        const input = props({
            plotting: true,
            encHydration: { total: 4, remaining: 2 },
            nightDim: true,
        });
        const { rerender } = render(<ChartDepthControls {...input} />);

        expect(screen.getByText('Chart downloading… (3 of 4)')).toBeInTheDocument();
        const night = screen.getByRole('button', { name: 'Toggle night dim' });
        expect(night).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(night);
        expect(input.onNightDimChange).toHaveBeenCalledWith(false);

        fireEvent.click(screen.getByRole('button', { name: /chart colours/ }));
        expect(input.onToggleChartKey).toHaveBeenCalledOnce();
        expect(triggerHaptic).toHaveBeenCalledWith('light');

        rerender(<ChartDepthControls {...input} encHydration={{ total: 4, remaining: 0 }} encNoCoverage />);
        expect(screen.getByText('No chart coverage here — depths unverified')).toBeInTheDocument();
    });

    it('renders nothing map-relative when the map surface is hidden', () => {
        render(<ChartDepthControls {...props({ surfaceVisible: false, plotting: true, encNoCoverage: true })} />);
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        expect(screen.queryByText(/coverage/)).not.toBeInTheDocument();
    });
});

describe('LiveTideAckModal', () => {
    it('is absent while hidden and cancels from either cancel control or backdrop', () => {
        const onCancel = vi.fn();
        const { container, rerender } = render(
            <LiveTideAckModal visible={false} onCancel={onCancel} onAccept={vi.fn()} />,
        );
        expect(container).toBeEmptyDOMElement();

        rerender(<LiveTideAckModal visible onCancel={onCancel} onAccept={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onCancel).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByText('Live tide depth').parentElement!.parentElement!);
        expect(onCancel).toHaveBeenCalledTimes(2);
    });

    it('records acknowledgement before accepting', () => {
        const onAccept = vi.fn();
        render(<LiveTideAckModal visible onCancel={vi.fn()} onAccept={onAccept} />);

        fireEvent.click(screen.getByRole('button', { name: 'Show live depths' }));
        expect(onAccept).toHaveBeenCalledOnce();
        expect(Number.isNaN(Date.parse(localStorage.getItem(TIDE_DEPTH_ACK_KEY) ?? ''))).toBe(false);
    });

    it('acts as a keyboard-contained dialog and restores the control that opened it', () => {
        const onCancel = vi.fn();
        const { rerender } = render(
            <>
                <button>Enable live tide</button>
                <LiveTideAckModal visible={false} onCancel={onCancel} onAccept={vi.fn()} />
            </>,
        );
        const trigger = screen.getByRole('button', { name: 'Enable live tide' });
        trigger.focus();

        rerender(
            <>
                <button>Enable live tide</button>
                <LiveTideAckModal visible onCancel={onCancel} onAccept={vi.fn()} />
            </>,
        );
        const dialog = screen.getByRole('dialog', { name: 'Live tide depth' });
        const cancel = screen.getByRole('button', { name: 'Cancel' });
        const accept = screen.getByRole('button', { name: 'Show live depths' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(cancel).toHaveFocus();

        fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
        expect(accept).toHaveFocus();
        fireEvent.keyDown(accept, { key: 'Tab' });
        expect(cancel).toHaveFocus();
        fireEvent.keyDown(cancel, { key: 'Escape' });
        expect(onCancel).toHaveBeenCalledOnce();

        rerender(
            <>
                <button>Enable live tide</button>
                <LiveTideAckModal visible={false} onCancel={onCancel} onAccept={vi.fn()} />
            </>,
        );
        expect(trigger).toHaveFocus();
    });
});
