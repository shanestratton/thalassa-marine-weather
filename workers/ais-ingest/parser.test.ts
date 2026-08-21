/**
 * Worker parser tests — validates AISStream.io message parsing.
 *
 * Tests PositionReport, ShipStaticData, and StandardClassBPositionReport
 * message types from the AISStream.io WebSocket format.
 */
import { describe, it, expect } from 'vitest';
import { MAX_AIS_MESSAGE_CHARS, parseAisStreamMessage } from './parser';

describe('parseAisStreamMessage — PositionReport', () => {
    it('should parse a valid PositionReport', () => {
        const msg = JSON.stringify({
            MessageType: 'PositionReport',
            Message: {
                PositionReport: {
                    Valid: true,
                    UserID: 123456789,
                    Latitude: -27.4698,
                    Longitude: 153.0251,
                    Cog: 124.5,
                    Sog: 8.3,
                    TrueHeading: 120,
                    NavigationalStatus: 0,
                },
            },
        });

        const result = parseAisStreamMessage(msg);
        expect(result).not.toBeNull();
        expect(result!.mmsi).toBe(123456789);
        expect(result!.lat).toBe(-27.4698);
        expect(result!.lon).toBe(153.0251);
        expect(result!.cog).toBe(124.5);
        expect(result!.sog).toBe(8.3);
        expect(result!.heading).toBe(120);
        expect(result!.nav_status).toBe(0);
    });

    it('should reject PositionReport with invalid position (91/181)', () => {
        const msg = JSON.stringify({
            MessageType: 'PositionReport',
            Message: {
                PositionReport: {
                    Valid: true,
                    UserID: 111222333,
                    Latitude: 91,
                    Longitude: 181,
                    Cog: 0,
                    Sog: 0,
                },
            },
        });

        expect(parseAisStreamMessage(msg)).toBeNull();
    });

    it('should reject PositionReport with out-of-range latitude', () => {
        const msg = JSON.stringify({
            MessageType: 'PositionReport',
            Message: {
                PositionReport: {
                    Valid: true,
                    UserID: 111222333,
                    Latitude: -91.5,
                    Longitude: 153.0,
                    Cog: 0,
                    Sog: 0,
                },
            },
        });

        expect(parseAisStreamMessage(msg)).toBeNull();
    });

    it('should reject invalid PositionReport (Valid=false)', () => {
        const msg = JSON.stringify({
            MessageType: 'PositionReport',
            Message: {
                PositionReport: {
                    Valid: false,
                    UserID: 123456789,
                    Latitude: -27.4698,
                    Longitude: 153.0251,
                },
            },
        });

        expect(parseAisStreamMessage(msg)).toBeNull();
    });

    it('should reject PositionReport with zero MMSI', () => {
        const msg = JSON.stringify({
            MessageType: 'PositionReport',
            Message: {
                PositionReport: {
                    Valid: true,
                    UserID: 0,
                    Latitude: -27.4698,
                    Longitude: 153.0251,
                },
            },
        });

        expect(parseAisStreamMessage(msg)).toBeNull();
    });

    it.each([
        ['short', 12345678],
        ['long', 1234567890],
        ['fractional', 123456789.5],
        ['string', '123456789'],
    ])('rejects a %s MMSI instead of coercing it', (_label, UserID) => {
        const msg = JSON.stringify({
            MessageType: 'PositionReport',
            Message: {
                PositionReport: {
                    Valid: true,
                    UserID,
                    Latitude: -27.4698,
                    Longitude: 153.0251,
                },
            },
        });

        expect(parseAisStreamMessage(msg)).toBeNull();
    });

    it('omits AIS movement sentinel and malformed optional values', () => {
        const msg = JSON.stringify({
            MessageType: 'PositionReport',
            Message: {
                PositionReport: {
                    Valid: true,
                    UserID: 123456789,
                    Latitude: -27.4698,
                    Longitude: 153.0251,
                    Cog: 360,
                    Sog: 102.3,
                    TrueHeading: 511,
                    NavigationalStatus: 99,
                },
            },
        });

        expect(parseAisStreamMessage(msg)).toEqual({
            mmsi: 123456789,
            lat: -27.4698,
            lon: 153.0251,
            cog: undefined,
            sog: undefined,
            heading: undefined,
            nav_status: undefined,
        });
    });
});

describe('parseAisStreamMessage — ShipStaticData', () => {
    it('should parse valid ShipStaticData (type 5)', () => {
        const msg = JSON.stringify({
            MessageType: 'ShipStaticData',
            Message: {
                ShipStaticData: {
                    Valid: true,
                    UserID: 987654321,
                    Name: 'SPIRIT OF BRISBANE@@@@',
                    CallSign: 'VH1234',
                    Type: 70,
                    Destination: 'MORETON BAY@@@@@@',
                    ImoNumber: 9876543,
                    Dimension: { A: 50, B: 150, C: 15, D: 15 },
                },
            },
        });

        const result = parseAisStreamMessage(msg);
        expect(result).not.toBeNull();
        expect(result!.mmsi).toBe(987654321);
        expect(result!.name).toBe('SPIRIT OF BRISBANE'); // Trailing @ stripped
        expect(result!.call_sign).toBe('VH1234');
        expect(result!.ship_type).toBe(70);
        expect(result!.destination).toBe('MORETON BAY'); // Trailing @ stripped
        expect(result!.imo_number).toBe(9876543);
        expect(result!.dimension_a).toBe(50);
        expect(result!.dimension_b).toBe(150);
    });

    it('should handle name with only @ characters', () => {
        const msg = JSON.stringify({
            MessageType: 'ShipStaticData',
            Message: {
                ShipStaticData: {
                    Valid: true,
                    UserID: 555666777,
                    Name: '@@@@@@@@@@@@@@@@@@@@',
                    CallSign: '',
                    Type: 30,
                },
            },
        });

        const result = parseAisStreamMessage(msg);
        expect(result).not.toBeNull();
        // Name should be undefined after stripping all @s
        expect(result!.name).toBeUndefined();
    });

    it('should reject invalid ShipStaticData', () => {
        const msg = JSON.stringify({
            MessageType: 'ShipStaticData',
            Message: {
                ShipStaticData: {
                    Valid: false,
                    UserID: 987654321,
                },
            },
        });

        expect(parseAisStreamMessage(msg)).toBeNull();
    });

    it('bounds and strips static text and drops out-of-range numeric fields', () => {
        const msg = JSON.stringify({
            MessageType: 'ShipStaticData',
            Message: {
                ShipStaticData: {
                    Valid: true,
                    UserID: 987654321,
                    Name: `VESSEL\u0000${'X'.repeat(40)}@@@@`,
                    CallSign: 'TOO-LONG-CALLSIGN',
                    Type: 120,
                    Destination: `PORT\u0007${'Y'.repeat(40)}`,
                    ImoNumber: 12,
                    Dimension: { A: 900, B: -1, C: 64, D: '12' },
                },
            },
        });

        const result = parseAisStreamMessage(msg);
        expect(result).not.toBeNull();
        expect(result?.name).toHaveLength(20);
        expect(result?.name).not.toContain('\u0000');
        expect(result?.call_sign).toBe('TOO-LON');
        expect(result?.destination).toHaveLength(20);
        expect(result?.destination).not.toContain('\u0007');
        expect(result).toMatchObject({ mmsi: 987654321 });
        expect(result?.ship_type).toBeUndefined();
        expect(result?.imo_number).toBeUndefined();
        expect(result?.dimension_a).toBeUndefined();
        expect(result?.dimension_b).toBeUndefined();
        expect(result?.dimension_c).toBeUndefined();
        expect(result?.dimension_d).toBeUndefined();
    });
});

describe('parseAisStreamMessage — StandardClassBPositionReport', () => {
    it('should parse a valid Class B position report', () => {
        const msg = JSON.stringify({
            MessageType: 'StandardClassBPositionReport',
            Message: {
                StandardClassBPositionReport: {
                    Valid: true,
                    UserID: 444555666,
                    Latitude: -33.8688,
                    Longitude: 151.2093,
                    Cog: 270.0,
                    Sog: 5.5,
                    TrueHeading: 265,
                },
            },
        });

        const result = parseAisStreamMessage(msg);
        expect(result).not.toBeNull();
        expect(result!.mmsi).toBe(444555666);
        expect(result!.lat).toBe(-33.8688);
        expect(result!.lon).toBe(151.2093);
        expect(result!.nav_status).toBe(15); // Class B always 15
    });

    it('should reject Class B with unavailable position', () => {
        const msg = JSON.stringify({
            MessageType: 'StandardClassBPositionReport',
            Message: {
                StandardClassBPositionReport: {
                    Valid: true,
                    UserID: 444555666,
                    Latitude: 91,
                    Longitude: 181,
                },
            },
        });

        expect(parseAisStreamMessage(msg)).toBeNull();
    });

    it.each([
        [90.0001, 153],
        [-90.0001, 153],
        [-27, 180.0001],
        [-27, -180.0001],
        ['-27', 153],
        [-27, null],
    ])('rejects malformed or out-of-range Class B coordinates (%j, %j)', (Latitude, Longitude) => {
        const msg = JSON.stringify({
            MessageType: 'StandardClassBPositionReport',
            Message: {
                StandardClassBPositionReport: {
                    Valid: true,
                    UserID: 444555666,
                    Latitude,
                    Longitude,
                },
            },
        });

        expect(parseAisStreamMessage(msg)).toBeNull();
    });
});

describe('parseAisStreamMessage — edge cases', () => {
    it('should return null for invalid JSON', () => {
        expect(parseAisStreamMessage('not json at all')).toBeNull();
        expect(parseAisStreamMessage('{')).toBeNull();
        expect(parseAisStreamMessage('')).toBeNull();
    });

    it('rejects non-object JSON and oversized frames before traversal', () => {
        expect(parseAisStreamMessage('null')).toBeNull();
        expect(parseAisStreamMessage('[]')).toBeNull();
        expect(parseAisStreamMessage('"PositionReport"')).toBeNull();
        expect(parseAisStreamMessage('x'.repeat(MAX_AIS_MESSAGE_CHARS + 1))).toBeNull();
    });

    it('requires a literal boolean Valid flag', () => {
        const msg = JSON.stringify({
            MessageType: 'PositionReport',
            Message: {
                PositionReport: {
                    Valid: 'false',
                    UserID: 123456789,
                    Latitude: -27.4698,
                    Longitude: 153.0251,
                },
            },
        });
        expect(parseAisStreamMessage(msg)).toBeNull();
    });

    it('should return null for unknown message types', () => {
        const msg = JSON.stringify({
            MessageType: 'AidToNavigationReport',
            Message: { AidToNavigationReport: { Valid: true, UserID: 123 } },
        });
        expect(parseAisStreamMessage(msg)).toBeNull();
    });

    it('should return null for missing MessageType', () => {
        const msg = JSON.stringify({ Message: { Something: {} } });
        expect(parseAisStreamMessage(msg)).toBeNull();
    });

    it('should return null for missing Message body', () => {
        const msg = JSON.stringify({ MessageType: 'PositionReport' });
        expect(parseAisStreamMessage(msg)).toBeNull();
    });

    it('should handle missing optional fields gracefully', () => {
        const msg = JSON.stringify({
            MessageType: 'PositionReport',
            Message: {
                PositionReport: {
                    Valid: true,
                    UserID: 123456789,
                    Latitude: -27.4698,
                    Longitude: 153.0251,
                    // No Cog, Sog, TrueHeading, NavigationalStatus
                },
            },
        });

        const result = parseAisStreamMessage(msg);
        expect(result).not.toBeNull();
        expect(result!.mmsi).toBe(123456789);
        expect(result!.cog).toBeUndefined();
        expect(result!.sog).toBeUndefined();
        expect(result!.heading).toBeUndefined();
    });
});

describe('StaticDataReport (message 24 — Class B static)', () => {
    // Class B vessels — every yacht with a Class B transponder — send their
    // name here, NOT in ShipStaticData (msg 5, Class A only). Dropping msg 24
    // filled the table with nameless positions no name-search could find.
    const frame = (payload: Record<string, unknown>) =>
        JSON.stringify({ MessageType: 'StaticDataReport', Message: { StaticDataReport: payload } });

    it('takes the name from a valid Part A', () => {
        const rec = parseAisStreamMessage(
            frame({ Valid: true, UserID: 503101240, ReportA: { Valid: true, Name: 'WHISKERS@@@' } }),
        );
        expect(rec).toEqual({ mmsi: 503101240, name: 'WHISKERS' });
    });

    it('takes call sign, type and dimensions from a valid Part B', () => {
        const rec = parseAisStreamMessage(
            frame({
                Valid: true,
                UserID: 503101240,
                ReportB: {
                    Valid: true,
                    CallSign: 'VJN4567',
                    ShipType: 36,
                    Dimension: { A: 8, B: 4, C: 2, D: 2 },
                },
            }),
        );
        expect(rec).toMatchObject({
            mmsi: 503101240,
            call_sign: 'VJN4567',
            ship_type: 36,
            dimension_a: 8,
            dimension_b: 4,
            dimension_c: 2,
            dimension_d: 2,
        });
        expect(rec?.name).toBeUndefined();
    });

    it('rejects a report whose parts are both invalid', () => {
        expect(
            parseAisStreamMessage(
                frame({ Valid: true, UserID: 503101240, ReportA: { Valid: false }, ReportB: { Valid: false } }),
            ),
        ).toBeNull();
    });

    it('rejects a valid part that carried nothing usable', () => {
        // Part A valid but the name is all padding — an empty record would
        // only refresh updated_at, which the change detector exists to stop.
        expect(
            parseAisStreamMessage(frame({ Valid: true, UserID: 503101240, ReportA: { Valid: true, Name: '@@@' } })),
        ).toBeNull();
    });

    it('rejects a bad MMSI', () => {
        expect(
            parseAisStreamMessage(frame({ Valid: true, UserID: 42, ReportA: { Valid: true, Name: 'GHOST' } })),
        ).toBeNull();
    });
});

describe('MetaData.ShipName fallback', () => {
    it('a position report carries the envelope name so search works from frame one', () => {
        const rec = parseAisStreamMessage(
            JSON.stringify({
                MessageType: 'StandardClassBPositionReport',
                MetaData: { ShipName: 'WHISKERS   ' },
                Message: {
                    StandardClassBPositionReport: {
                        Valid: true,
                        UserID: 503101240,
                        Latitude: -27.2,
                        Longitude: 153.09,
                    },
                },
            }),
        );
        expect(rec?.name).toBe('WHISKERS');
    });

    it('padding artefacts are rejected, not stored', () => {
        const rec = parseAisStreamMessage(
            JSON.stringify({
                MessageType: 'PositionReport',
                MetaData: { ShipName: 'COASTGUARD@@@@@@@@H' },
                Message: {
                    PositionReport: { Valid: true, UserID: 123456789, Latitude: -27.2, Longitude: 153.09 },
                },
            }),
        );
        expect(rec).not.toBeNull();
        expect(rec?.name).toBeUndefined();
    });
});
