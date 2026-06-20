import { describe, it, expect } from 'vitest';
import {
    scoreWeatherWindow,
    QUESTIONS,
    GO_THRESHOLD,
    type Answers,
} from '../services/weatherWindow/weatherWindowScore';

const PERFECT: Answers = {
    tropical_system: 'no',
    bailout: 'yes',
    closing_window: 'holds',
    crew_rested: 'yes',
    window_margin: 'over2',
    sustained_wind: 'within',
    gusts: 'ok',
    sea_state: 'low_long',
    sea_direction: 'astern',
    system_trend: 'easing',
    model_confidence: 'agree',
    wind_over_tide: 'none',
    visibility_night: 'good',
    crew_experience: 'strong',
};

describe('weatherWindowScore', () => {
    it('a flawless day clears the bar', () => {
        const r = scoreWeatherWindow(PERFECT);
        expect(r.score).toBe(100);
        expect(r.band).toBe('GO');
        expect(r.vetoes).toHaveLength(0);
        expect(r.complete).toBe(true);
        expect(r.score).toBeGreaterThanOrEqual(GO_THRESHOLD);
    });

    it('a cyclone in the track vetoes a perfect score', () => {
        const r = scoreWeatherWindow({ ...PERFECT, tropical_system: 'yes' });
        expect(r.score).toBe(100); // the number is still high…
        expect(r.band).toBe('NO-GO'); // …but the gate overrides it
        expect(r.vetoes.length).toBe(1);
    });

    it('a closing window is an automatic no-go', () => {
        const r = scoreWeatherWindow({ ...PERFECT, closing_window: 'closing' });
        expect(r.band).toBe('NO-GO');
        expect(r.vetoes[0]).toMatch(/closing/i);
    });

    it('no bail-out vetoes', () => {
        const r = scoreWeatherWindow({ ...PERFECT, bailout: 'no' });
        expect(r.band).toBe('NO-GO');
    });

    it('a middling forecast lands MARGINAL and names the weak points', () => {
        const r = scoreWeatherWindow({
            tropical_system: 'no',
            bailout: 'yes',
            closing_window: 'holds',
            crew_rested: 'yes',
            window_margin: 'm15_2',
            sustained_wind: 'near',
            gusts: 'reef',
            sea_state: 'moderate',
            sea_direction: 'beam',
            system_trend: 'steady',
            model_confidence: 'minor',
            wind_over_tide: 'some',
            visibility_night: 'some_night',
            crew_experience: 'adequate',
        });
        expect(r.band).toBe('MARGINAL');
        expect(r.score).toBeGreaterThanOrEqual(60);
        expect(r.score).toBeLessThan(GO_THRESHOLD);
        expect(r.weakest.length).toBeGreaterThan(0);
    });

    it('is provisional until every question is answered', () => {
        const r = scoreWeatherWindow({ tropical_system: 'no', window_margin: 'over2' });
        expect(r.complete).toBe(false);
        expect(r.verdict).toMatch(/answer all/i);
    });

    it('has 4 gates and 10 scored questions', () => {
        expect(QUESTIONS.filter((q) => q.kind === 'gate')).toHaveLength(4);
        expect(QUESTIONS.filter((q) => q.kind === 'scored')).toHaveLength(10);
    });
});
