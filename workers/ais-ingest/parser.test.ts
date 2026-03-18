/**
 * Worker parser tests — validates AISStream.io message parsing.
 *
 * Tests PositionReport, ShipStaticData, and StandardClassBPositionReport
 * message types from the AISStream.io WebSocket format.
 */
import { describe, it, expect } from 'vitest';
import { parseAisStreamMessage, _VesselRecord } from './parser';

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
});

describe('parseAisStreamMessage — edge cases', () => {
    it('should return null for invalid JSON', () => {
        expect(parseAisStreamMessage('not json at all')).toBeNull();
        expect(parseAisStreamMessage('{')).toBeNull();
        expect(parseAisStreamMessage('')).toBeNull();
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
