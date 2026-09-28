import { describe, expect, it } from 'vitest';
import {
    DAY_PLAN_TIME_ZONE,
    dayPlanDateTime,
    dayPlanInputTime,
    dayPlanLocalDate,
    dayPlanTime,
    dayPlanTimeZoneLabel,
    isDayPlanTimeZone,
    nextLocalMorning,
    parseDayPlanInput,
} from '../services/dayPlanner/presentation';

const HOUR = 3_600_000;

describe('regional civil-time presentation', () => {
    it('keeps the legacy Brisbane default and explicit AEST identity', () => {
        const instant = Date.parse('2026-11-01T05:30:00Z');
        expect(DAY_PLAN_TIME_ZONE).toBe('Australia/Brisbane');
        expect(dayPlanInputTime(instant)).toBe('2026-11-01T15:30');
        expect(parseDayPlanInput('2026-11-01T15:30')).toBe(instant);
        expect(dayPlanTime(instant)).toMatch(/3:30\s*pm/i);
        expect(dayPlanDateTime(instant)).toContain('Australia/Brisbane');
        expect(dayPlanDateTime(instant)).toContain('AEST');
        expect(dayPlanDateTime(instant)).toContain('UTC+10:00');
    });

    it.each([
        ['Pacific/Auckland', '2026-09-28T01:30', 'UTC+13:00'],
        ['Pacific/Noumea', '2026-09-27T23:30', 'UTC+11:00'],
        ['Pacific/Fiji', '2026-09-28T00:30', 'UTC+12:00'],
        ['Pacific/Kiritimati', '2026-09-28T02:30', 'UTC+14:00'],
        ['Pacific/Honolulu', '2026-09-27T02:30', 'UTC-10:00'],
        ['Australia/Adelaide', '2026-09-27T22:00', 'UTC+09:30'],
        ['Asia/Kathmandu', '2026-09-27T18:15', 'UTC+05:45'],
        ['Australia/Eucla', '2026-09-27T21:15', 'UTC+08:45'],
        ['Pacific/Chatham', '2026-09-28T02:15', 'UTC+13:45'],
    ])('formats and parses %s with its actual calendar day and offset', (zone, local, offset) => {
        const instant = Date.parse('2026-09-27T12:30:00Z');
        expect(dayPlanInputTime(instant, zone)).toBe(local);
        expect(parseDayPlanInput(local, zone)).toBe(instant);
        expect(dayPlanLocalDate(instant, zone)).toBe(local.slice(0, 10));
        expect(dayPlanTimeZoneLabel(instant, zone)).toContain(zone);
        expect(dayPlanTimeZoneLabel(instant, zone)).toContain(offset);
    });

    it('uses the midnight calendar date without an artificial 24:00 hour', () => {
        const instant = Date.parse('2026-01-01T00:00:00Z');
        expect(dayPlanInputTime(instant, 'UTC')).toBe('2026-01-01T00:00');
        expect(parseDayPlanInput('2026-01-01T00:00', 'UTC')).toBe(instant);
    });

    it.each(['Mars/Olympus', '', ' Australia/Brisbane', '+10:00'])(
        'rejects invalid IANA zone %j without using a fallback',
        (zone) => {
            expect(isDayPlanTimeZone(zone)).toBe(false);
            expect(Number.isNaN(parseDayPlanInput('2026-09-27T12:30', zone))).toBe(true);
            expect(Number.isNaN(nextLocalMorning(Date.now(), zone))).toBe(true);
            expect(dayPlanInputTime(Date.now(), zone)).toBe('');
            expect(dayPlanTimeZoneLabel(Date.now(), zone)).toBe('');
            expect(dayPlanDateTime(Date.now(), zone)).toBe('');
        },
    );

    it.each([
        '2026-02-30T09:00',
        '2026-13-01T09:00',
        '2026-01-01T24:00',
        '2026-01-01T09:60',
        '2026-1-1T09:00',
        '0000-01-01T09:00',
    ])('rejects malformed civil date %s', (value) => {
        expect(Number.isNaN(parseDayPlanInput(value, 'Europe/Paris'))).toBe(true);
    });
});

describe('daylight-saving gaps and folds', () => {
    it.each([
        ['America/New_York', '2026-03-08T02:30', '2026-11-01T01:30'],
        ['Europe/London', '2026-03-29T01:30', '2026-10-25T01:30'],
        ['Europe/Paris', '2026-03-29T02:30', '2026-10-25T02:30'],
        ['Australia/Sydney', '2026-10-04T02:30', '2026-04-05T02:30'],
        ['Pacific/Auckland', '2026-09-27T02:30', '2026-04-05T02:30'],
        ['Australia/Lord_Howe', '2026-10-04T02:15', '2026-04-05T01:45'],
    ])('rejects both a nonexistent and an ambiguous local time in %s', (zone, gap, fold) => {
        expect(Number.isNaN(parseDayPlanInput(gap, zone))).toBe(true);
        expect(Number.isNaN(parseDayPlanInput(fold, zone))).toBe(true);
    });

    it('does not choose either occurrence of a repeated local time', () => {
        const earlier = Date.parse('2026-11-01T05:30:00Z');
        const later = Date.parse('2026-11-01T06:30:00Z');
        expect(dayPlanInputTime(earlier, 'America/New_York')).toBe('2026-11-01T01:30');
        expect(dayPlanInputTime(later, 'America/New_York')).toBe('2026-11-01T01:30');
        expect(dayPlanTimeZoneLabel(earlier, 'America/New_York')).toContain('UTC-04:00');
        expect(dayPlanTimeZoneLabel(later, 'America/New_York')).toContain('UTC-05:00');
        expect(Number.isNaN(parseDayPlanInput('2026-11-01T01:30', 'America/New_York'))).toBe(true);
    });

    it('accepts an ordinary time immediately after a forward transition', () => {
        expect(parseDayPlanInput('2026-03-08T03:30', 'America/New_York')).toBe(Date.parse('2026-03-08T07:30:00Z'));
        expect(parseDayPlanInput('2026-10-04T03:30', 'Australia/Sydney')).toBe(Date.parse('2026-10-03T16:30:00Z'));
    });

    it('rejects the entire skipped local date at a dateline change', () => {
        expect(Number.isNaN(parseDayPlanInput('2011-12-30T09:00', 'Pacific/Apia'))).toBe(true);
    });
});

describe('next local morning', () => {
    it.each([
        ['America/New_York', '2026-03-08T04:00:00Z', '2026-03-08T13:00:00Z', 9],
        ['America/New_York', '2026-11-01T03:00:00Z', '2026-11-01T14:00:00Z', 11],
        ['Australia/Sydney', '2026-10-03T13:00:00Z', '2026-10-03T22:00:00Z', 9],
        ['Pacific/Auckland', '2026-09-26T11:00:00Z', '2026-09-26T20:00:00Z', 9],
        ['Australia/Lord_Howe', '2026-10-03T12:30:00Z', '2026-10-03T22:00:00Z', 9.5],
    ] as const)('uses the next calendar morning across %s changes', (zone, from, expected, elapsedHours) => {
        const actual = nextLocalMorning(Date.parse(from), zone);
        expect(actual).toBe(Date.parse(expected));
        expect(actual - Date.parse(from)).toBe(elapsedHours * HOUR);
        expect(dayPlanInputTime(actual, zone)).toMatch(/T09:00$/);
    });

    it('advances the local date even when the current local time is before 9am', () => {
        const start = parseDayPlanInput('2026-12-31T08:00', 'Pacific/Noumea');
        expect(dayPlanInputTime(nextLocalMorning(start, 'Pacific/Noumea'), 'Pacific/Noumea')).toBe('2027-01-01T09:00');
    });

    it('fails closed if a chosen morning hour falls in a transition or skipped day', () => {
        expect(Number.isNaN(nextLocalMorning(Date.parse('2026-03-07T17:00:00Z'), 'America/New_York', 2))).toBe(true);
        expect(Number.isNaN(nextLocalMorning(Date.parse('2011-12-29T20:00:00Z'), 'Pacific/Apia'))).toBe(true);
    });
});
