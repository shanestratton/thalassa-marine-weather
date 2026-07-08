import { describe, expect, it } from 'vitest';
import { parseCoordinateString } from './coordParse';

describe('parseCoordinateString', () => {
    // ── signed decimal pairs ──
    it('parses signed decimal with comma', () => {
        expect(parseCoordinateString('-27.4698, 153.0251')).toEqual({ lat: -27.4698, lon: 153.0251 });
    });
    it('parses signed decimal with space only', () => {
        expect(parseCoordinateString('-27.4698 153.0251')).toEqual({ lat: -27.4698, lon: 153.0251 });
    });
    it('parses without spaces around the comma', () => {
        expect(parseCoordinateString('-27.4698,153.0251')).toEqual({ lat: -27.4698, lon: 153.0251 });
    });
    it('parses a unicode minus (copied from a web page)', () => {
        expect(parseCoordinateString('−27.4698, 153.0251')).toEqual({ lat: -27.4698, lon: 153.0251 });
    });

    // ── hemisphere-lettered decimal ──
    it('parses hemisphere-suffixed decimal', () => {
        expect(parseCoordinateString('27.4698S 153.0251E')).toEqual({ lat: -27.4698, lon: 153.0251 });
    });
    it('parses hemisphere-suffixed decimal with comma', () => {
        expect(parseCoordinateString('27.4698S, 153.0251E')).toEqual({ lat: -27.4698, lon: 153.0251 });
    });
    it('parses hemisphere-prefixed decimal', () => {
        expect(parseCoordinateString('S27.4698 E153.0251')).toEqual({ lat: -27.4698, lon: 153.0251 });
    });
    it('is case-insensitive (formatLocationInput lower-cases hemisphere letters)', () => {
        expect(parseCoordinateString('27.4698s, 153.0251e')).toEqual({ lat: -27.4698, lon: 153.0251 });
    });
    it('accepts lon-first order when the letters disambiguate', () => {
        expect(parseCoordinateString('153.0251E 27.4698S')).toEqual({ lat: -27.4698, lon: 153.0251 });
    });
    it('handles western/northern hemispheres', () => {
        expect(parseCoordinateString('41.35N 71.96W')).toEqual({ lat: 41.35, lon: -71.96 });
    });

    // ── degrees + decimal minutes (DMM) ──
    it('parses DMM with symbols', () => {
        const r = parseCoordinateString("27°28.2'S 153°01.5'E");
        expect(r).not.toBeNull();
        expect(r!.lat).toBeCloseTo(-(27 + 28.2 / 60), 6);
        expect(r!.lon).toBeCloseTo(153 + 1.5 / 60, 6);
    });
    it('parses DMM without symbols', () => {
        const r = parseCoordinateString('27 28.2 S 153 01.5 E');
        expect(r).not.toBeNull();
        expect(r!.lat).toBeCloseTo(-(27 + 28.2 / 60), 6);
        expect(r!.lon).toBeCloseTo(153 + 1.5 / 60, 6);
    });
    it('parses DMM with unicode prime and ordinal-masquerading degree signs', () => {
        const r = parseCoordinateString('27º28.2′S 153º01.5′E');
        expect(r).not.toBeNull();
        expect(r!.lat).toBeCloseTo(-(27 + 28.2 / 60), 6);
    });

    // ── degrees minutes seconds (DMS) ──
    it('parses DMS with symbols', () => {
        const r = parseCoordinateString(`27°28'12"S 153°01'30"E`);
        expect(r).not.toBeNull();
        expect(r!.lat).toBeCloseTo(-(27 + 28 / 60 + 12 / 3600), 6);
        expect(r!.lon).toBeCloseTo(153 + 1 / 60 + 30 / 3600, 6);
    });
    it('parses DMS without symbols', () => {
        const r = parseCoordinateString('27 28 12 S 153 01 30 E');
        expect(r).not.toBeNull();
        expect(r!.lat).toBeCloseTo(-(27 + 28 / 60 + 12 / 3600), 6);
    });

    // ── rejections: the anchored parser must NOT invent positions ──
    it('rejects a berth name containing two numbers (old regex false-positive)', () => {
        expect(parseCoordinateString('Berth 2, 153 Marina')).toBeNull();
    });
    it('rejects plain place names', () => {
        expect(parseCoordinateString('Mooloolaba, QLD')).toBeNull();
        expect(parseCoordinateString('Newport')).toBeNull();
    });
    it('rejects the planner "Name (lat, lon)" string — savedLocations owns that', () => {
        expect(parseCoordinateString('Newport (-27.2050, 153.0917)')).toBeNull();
    });
    it('rejects empty and non-numeric input', () => {
        expect(parseCoordinateString('')).toBeNull();
        expect(parseCoordinateString('   ')).toBeNull();
        expect(parseCoordinateString('north south')).toBeNull();
    });
    it('rejects a single axis', () => {
        expect(parseCoordinateString('27.4698S')).toBeNull();
        expect(parseCoordinateString('-27.4698')).toBeNull();
    });
    it('rejects out-of-range latitude and longitude', () => {
        expect(parseCoordinateString('95.0, 153.0')).toBeNull();
        expect(parseCoordinateString('-27.0, 190.0')).toBeNull();
        expect(parseCoordinateString('95.0S 153.0E')).toBeNull();
    });
    it('rejects minutes or seconds ≥ 60', () => {
        expect(parseCoordinateString("27°75'S 153°01'E")).toBeNull();
        expect(parseCoordinateString(`27°28'75"S 153°01'30"E`)).toBeNull();
    });
    it('rejects two letters naming the same axis', () => {
        expect(parseCoordinateString('27.4N 153.0N')).toBeNull();
        expect(parseCoordinateString('27.4S 153.0S')).toBeNull();
    });
    it('rejects fractional degrees followed by minutes', () => {
        expect(parseCoordinateString('27.5 30 S 153.1 15 E')).toBeNull();
    });
});
