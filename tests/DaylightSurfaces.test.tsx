import { readFileSync } from 'node:fs';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TideCanvas } from '../components/dashboard/tide/TideCanvas';
import { ScopeRadar } from '../components/anchor-watch/ScopeRadar';

const surfaceCss = readFileSync('styles/daylight-surfaces.css', 'utf8');

function luminance(hex: string) {
    const rgb = hex.match(/[a-f\d]{2}/gi)!.map((part) => {
        const value = parseInt(part, 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

afterEach(() => {
    cleanup();
    document.documentElement.classList.remove('display-light', 'display-night');
    vi.restoreAllMocks();
});

describe('daylight component surfaces', () => {
    it('keeps primary, muted and semantic copy readable on bright surfaces', () => {
        const tokens = new Map(
            [...surfaceCss.matchAll(/(--day-ui-[\w-]+):\s*(#[\da-f]{6});/g)].map((m) => [m[1], m[2]]),
        );
        const surfaces = [
            'surface',
            'surface-soft',
            'success-surface',
            'amber-surface',
            'danger-surface',
            'purple-surface',
        ];
        for (const text of ['text', 'muted', 'accent', 'amber', 'danger', 'success', 'purple', 'orange']) {
            for (const background of surfaces) {
                const ratio =
                    (luminance(tokens.get(`--day-ui-${background}`)!) + 0.05) /
                    (luminance(tokens.get(`--day-ui-${text}`)!) + 0.05);
                expect(ratio, `${text} on ${background}`).toBeGreaterThanOrEqual(4.5);
            }
        }
        // The fallbacks in each component are the existing dark/night palette.
        // Tokens must never leak to those modes through an unscoped :root rule.
        expect(surfaceCss).not.toContain(':root');
        expect(surfaceCss).toContain('.display-light {');
    });

    it('redraws the mounted tide canvas on day/night switches without changing data geometry', async () => {
        const labels: { color: unknown; text: string }[] = [];
        const strokes: unknown[] = [];
        const context = {
            fillStyle: '' as unknown,
            strokeStyle: '' as unknown,
            clearRect: vi.fn(),
            scale: vi.fn(),
            save: vi.fn(),
            restore: vi.fn(),
            beginPath: vi.fn(),
            closePath: vi.fn(),
            moveTo: vi.fn(),
            lineTo: vi.fn(),
            arc: vi.fn(),
            fill: vi.fn(),
            stroke() {
                strokes.push(this.strokeStyle);
            },
            fillText(text: string) {
                labels.push({ color: this.fillStyle, text });
            },
            createLinearGradient: () => ({ addColorStop: vi.fn() }),
        };
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
            context as unknown as CanvasRenderingContext2D,
        );
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            width: 320,
            height: 150,
        } as DOMRect);
        const input = {
            dataPoints: [
                { time: 0, height: 1 },
                { time: 6, height: 2 },
                { time: 12, height: 1 },
            ],
            currentHour: 6,
            currentHeight: 2,
            minHeight: 1,
            maxHeight: 2,
            domainBuffer: 0.2,
        };
        const view = render(<TideCanvas {...input} />);
        const originalGeometry = context.lineTo.mock.calls.slice();
        expect(labels[0]).toEqual({ color: 'rgba(255, 255, 255, 0.45)', text: '00' });

        labels.length = 0;
        strokes.length = 0;
        context.lineTo.mockClear();
        await act(async () => {
            document.documentElement.classList.add('display-light');
        });
        await waitFor(() => expect(labels[0]).toEqual({ color: '#475569', text: '00' }));
        expect(strokes).toContain('rgba(51, 65, 85, 0.28)');
        expect(context.lineTo.mock.calls).toEqual(originalGeometry);
        expect(context.fillStyle).toBe('#0f172a');

        labels.length = 0;
        await act(async () => {
            document.documentElement.classList.remove('display-light');
            document.documentElement.classList.add('display-night');
        });
        await waitFor(() => expect(labels[0]).toEqual({ color: 'rgba(255, 255, 255, 0.45)', text: '00' }));
        expect(context.fillStyle).toBe('#ffffff');

        view.unmount();
        const drawCount = context.clearRect.mock.calls.length;
        await act(async () => {
            document.documentElement.classList.add('display-light');
        });
        expect(context.clearRect).toHaveBeenCalledTimes(drawCount);
    });

    it('keeps scope quality and its warning hue tied to the same ratio thresholds', () => {
        const { rerender } = render(<ScopeRadar rodeLength={40} waterDepth={5} rodeType="chain" safetyMargin={5} />);
        expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Scope radar: 8.0 to 1 ratio, excellent');
        expect(screen.getByText('EXCELLENT')).toHaveAttribute('fill', 'var(--day-ui-success, #34d399)');
        rerender(<ScopeRadar rodeLength={30} waterDepth={5} rodeType="chain" safetyMargin={5} />);
        expect(screen.getByText('ADEQUATE')).toHaveAttribute('fill', 'var(--day-ui-amber, #fbbf24)');
        rerender(<ScopeRadar rodeLength={20} waterDepth={5} rodeType="chain" safetyMargin={5} />);
        expect(screen.getByText('POOR')).toHaveAttribute('fill', 'var(--day-ui-danger, #f87171)');
    });
});
