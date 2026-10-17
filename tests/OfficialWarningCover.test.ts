/**
 * For 129-07 (alerts ahead): a forecast alert is not raised where an official
 * warning of the same type, at least as strong, is already in force at the
 * same place (129-06 leaves the predicate; 129-07 calls it). The official
 * warning says it in the issuer's words; a "Forecast:" line beside it would
 * only repeat it less reliably. A weaker official warning never hides a
 * stronger forecast: a Small Craft Advisory does not cover "Forecast:
 * gale-force".
 */
import { describe, expect, it } from 'vitest';
import { forecastAlertCoveredByOfficial } from '../utils/officialWarningCover';

const nws = (event: string, code?: string) => ({
    provider: 'nws',
    infos: [{ event, eventCodes: code ? [{ valueName: 'NationalWeatherService', value: code }] : [] }],
});
const eccc = (event: string, code: string) => ({
    provider: 'eccc',
    infos: [{ event, eventCodes: [{ valueName: 'profile:CAP-CP:Event:0.4', value: code }] }],
});

describe('forecastAlertCoveredByOfficial', () => {
    it('a gale warning covers forecast gale-force and strong wind, not storm-force', () => {
        const official = [nws('Gale Warning', 'GLW')];
        expect(forecastAlertCoveredByOfficial('Forecast: gale-force wind, 34 kt+', official)).toBe(true);
        expect(forecastAlertCoveredByOfficial('Forecast: strong wind, 22 kt+', official)).toBe(true);
        expect(forecastAlertCoveredByOfficial('Forecast: storm-force wind, 48 kt+', official)).toBe(false);
    });

    it('a Small Craft Advisory covers strong wind and rough seas, never gale-force or dangerous seas', () => {
        const official = [nws('Small Craft Advisory', 'SCY')];
        expect(forecastAlertCoveredByOfficial('Forecast: strong wind, 22 kt+', official)).toBe(true);
        expect(forecastAlertCoveredByOfficial('Forecast: rough seas, 8 ft+ (2.4 m)', official)).toBe(true);
        expect(forecastAlertCoveredByOfficial('Forecast: gale-force wind, 34 kt+', official)).toBe(false);
        expect(forecastAlertCoveredByOfficial('Forecast: dangerous seas, 12 ft+ (3.7 m)', official)).toBe(false);
    });

    it('matches by type, in any issuer’s vocabulary', () => {
        expect(
            forecastAlertCoveredByOfficial('Forecast: gale-force wind, 34 kt+', [eccc('coup de vent', 'gale')]),
        ).toBe(true);
        expect(
            forecastAlertCoveredByOfficial('Forecast: dense fog, visibility under 1 nm', [
                nws('Dense Fog Advisory', 'MFY'),
            ]),
        ).toBe(true);
        expect(
            forecastAlertCoveredByOfficial('Forecast: dense fog, visibility under 1 nm', [nws('Gale Warning', 'GLW')]),
        ).toBe(false);
        expect(
            forecastAlertCoveredByOfficial('Forecast: freezing spray', [nws('Heavy Freezing Spray Warning', 'UPW')]),
        ).toBe(true);
    });

    it('covers nothing without an official warning, or for a legacy text or a type no warning has', () => {
        expect(forecastAlertCoveredByOfficial('Forecast: gale-force wind, 34 kt+', [])).toBe(false);
        expect(
            forecastAlertCoveredByOfficial('GALE WARNING: Winds exceeding 34kts', [nws('Gale Warning', 'GLW')]),
        ).toBe(false);
        expect(
            forecastAlertCoveredByOfficial('Forecast: very high UV, protection needed', [nws('Gale Warning', 'GLW')]),
        ).toBe(false);
        expect(forecastAlertCoveredByOfficial('Forecast: strong wind, 22 kt+', [nws('Zz Fictional Notice')])).toBe(
            false,
        );
    });
});
