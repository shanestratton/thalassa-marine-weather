/**
 * The far end of the Glass day carousel.
 *
 * Shane 2026-08-28: "when i scroll up to a different day, and then i click the
 * chevron to go to the essential page. it does not show the rain radar. it
 * shows the same as the normal glass page. now this only happens when you are
 * about 5 days forward of today???"
 *
 * Five days is not a coincidence — it is a horizon. weatherkit.ts requests
 * hourly out to +120 h; Hero.tsx builds ELEVEN day rows off the daily
 * forecast, which runs far past that. buildSlides used to require a first
 * hour before it would emit a day-overview, so every row past the hourly
 * horizon produced NO slides at all and the day rendered as bare chrome —
 * which is exactly what "the same as the normal glass page" looks like.
 *
 * Two things are asserted here: a forecast day past the horizon still has a
 * card, and the essential slot is reachable on forecast days at all.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSlides } from '../components/dashboard/hero/heroSlideHelpers';
import { HourlyForecast, SourcedWeatherMetrics } from '../types';

const heroSlide = readFileSync('components/dashboard/HeroSlide.tsx', 'utf8');

const dayTen = {
    isoDate: '2026-09-07',
    date: '2026-09-07',
    airTemperature: 24,
    highTemp: 27,
    lowTemp: 18,
    windSpeed: 15,
    windGust: 22,
    waveHeight: 1.2,
    condition: 'Partly Cloudy',
    sunrise: '06:12',
    sunset: '17:40',
    precipChance: 20,
} as unknown as SourcedWeatherMetrics;

const dailyForecasts = [
    {
        isoDate: '2026-09-07',
        date: '2026-09-07',
        highTemp: 27,
        lowTemp: 18,
        condition: 'Partly Cloudy',
        windSpeed: 15,
        waveHeight: 1.2,
    },
];

describe('forecast days past the hourly horizon', () => {
    it('still produces a day-overview card when no hourly exists', () => {
        // The regression, stated plainly: this used to be [].
        const slides = buildSlides(dayTen, 10, [], dailyForecasts, 'Australia/Brisbane');
        expect(slides).toHaveLength(1);
        expect(slides[0].type).toBe('daily');
    });

    it('carries the real daily numbers, not placeholders', () => {
        // A card that exists but says "--" everywhere is not a fix. We hold
        // genuine daily data for these days; only the hourly is missing.
        const [overview] = buildSlides(dayTen, 10, [], dailyForecasts, 'Australia/Brisbane');
        expect(overview.daily).toMatchObject({ highTemp: 27, lowTemp: 18, windSpeed: 15 });
    });

    it('times the overview at local midday off its own date', () => {
        // No hourly frame to borrow a timestamp from. Midday is the least
        // wrong hour to stand for a whole day, and it MUST land on the row's
        // own date or the card would be labelled as a different day.
        const [overview] = buildSlides(dayTen, 10, [], dailyForecasts, 'Australia/Brisbane');
        const d = new Date(overview.time as number);
        expect(d.getFullYear()).toBe(2026);
        expect(d.getMonth()).toBe(8); // September
        expect(d.getDate()).toBe(7);
        expect(d.getHours()).toBe(12);
    });

    it('does not invent a wind direction it cannot know', () => {
        // The day's arrow is the circular mean of the day's hourly bearings.
        // With no hours there is no mean, and a confident arrow pointing
        // nowhere is worse than no arrow.
        const [overview] = buildSlides(dayTen, 10, [], dailyForecasts, 'Australia/Brisbane');
        expect(overview.daily?.windDegree).toBeUndefined();
    });

    it('leaves days inside the horizon exactly as they were', () => {
        const hour: HourlyForecast = {
            time: '2026-09-07T09:00:00+10:00',
            temperature: 22,
            windSpeed: 14,
            windDegree: 135,
            windGust: 20,
            waveHeight: 1.1,
            condition: 'Partly Cloudy',
        } as unknown as HourlyForecast;
        const slides = buildSlides(dayTen, 1, [hour], dailyForecasts, 'Australia/Brisbane');
        expect(slides).toHaveLength(2);
        expect(slides[0].type).toBe('daily');
        expect(slides[0].time).toBe(new Date(hour.time).getTime());
        expect(slides[1].type).toBe('hourly');
    });

    it('still returns nothing when there is no row data at all', () => {
        expect(buildSlides(null as unknown as SourcedWeatherMetrics, 3, [], dailyForecasts)).toEqual([]);
    });

    it('leaves today alone — row 0 leads with the live card, never an overview', () => {
        const slides = buildSlides(dayTen, 0, [], dailyForecasts, 'Australia/Brisbane');
        expect(slides).toHaveLength(1);
        expect(slides[0].type).toBe('current');
    });
});

describe('the essential slot on forecast days', () => {
    it('does not let the day-overview swallow the essential map slide', () => {
        // Essential mode collapses the carousel to its first slide. On a
        // forecast day that first slide IS the overview, so the early return
        // meant the radar card the mode exists to show was unreachable.
        expect(heroSlide).toContain("if (slide.type === 'daily' && slide.daily && !showMapInstead) {");
    });

    it('keeps the anchor watch on today, where "right now" means something', () => {
        // Every day row has a slideIdx 0, so the old `slideIdx === 0` guard
        // put an anchor watch on Thursday's card.
        expect(heroSlide).toContain('index === 0 && slideIdx === 0 ? (');
    });
});
