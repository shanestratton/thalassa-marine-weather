/**
 * A forecast push in the foreground (129-07) looks like a forecast, never
 * like an official warning. check-weather-alerts sends storm force agreed
 * within 3 h as severe_weather_alert (send-push's critical type), so the
 * toast styles that type as the forecast weather alert (sky, the storm
 * glyph), not as the default, which is the official card's radio mast.
 * A tap on it opens the dashboard, as weather_alert's does (the default of
 * both tap handlers). All data here is made up.
 */
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PushToast, pushForegroundToast } from '../components/PushToast';

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn(async () => undefined) }));
afterEach(cleanup);

const cardOf = (title: string) => screen.getByText(title).closest('.bg-linear-to-r') as HTMLElement;

describe('forecast pushes in the foreground', () => {
    it('a severe forecast push is styled as a forecast, not as the official card', () => {
        render(React.createElement(PushToast, { onTap: vi.fn() }));
        act(() => {
            pushForegroundToast({
                title: 'Forecast: storm-force wind, Wed 16:00–19:00',
                body: '2 of 3 models agree (ECMWF, ICON) at Zzbaytown. Not an official warning.',
                data: { notification_type: 'severe_weather_alert', forecast: true },
            });
            pushForegroundToast({
                title: 'Forecast: strong wind, Wed 15:00–18:00',
                body: 'Not an official warning.',
                data: { notification_type: 'weather_alert', forecast: true },
            });
            pushForegroundToast({
                title: 'Gale Warning',
                body: 'Gale Warning issued by NWS Zzharbor (fictional)',
                data: { notification_type: 'official_warning' },
            });
        });
        const severe = cardOf('Forecast: storm-force wind, Wed 16:00–19:00');
        const forecast = cardOf('Forecast: strong wind, Wed 15:00–18:00');
        const official = cardOf('Gale Warning');
        expect(severe.className).toContain('from-sky-600/95');
        expect(severe.className).toBe(forecast.className);
        expect(severe.className).not.toBe(official.className);
        expect(severe.className).not.toMatch(/from-slate/);
        // The forecast's storm glyph, not the official card's radio mast.
        const glyph = (card: HTMLElement) => card.querySelector('span.shrink-0')?.innerHTML;
        expect(glyph(severe)).toBe(glyph(forecast));
        expect(glyph(severe)).not.toBe(glyph(official));
    });
});
