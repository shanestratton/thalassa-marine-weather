import { describe, expect, it } from 'vitest';
import {
    formatGpsAccessoryName,
    resolveGpsReceiverStatus,
    type GpsReceiverStatusInput,
} from '../services/GpsReceiverStatusService';

const NOW = 1_750_000_000_000;

function input(overrides: Partial<GpsReceiverStatusInput> = {}): GpsReceiverStatusInput {
    return {
        now: NOW,
        nmea: {
            connection: {
                status: 'disconnected',
                enabled: false,
                host: '192.168.1.151',
                port: 1456,
                deviceId: 'ydwg02',
                deviceLabel: 'Yacht Devices YDWG-02',
                transport: 'tcp',
            },
            feedStatus: 'unavailable',
            fixAgeMs: null,
            satellites: null,
            hdop: null,
            qualityLabel: 'GPS',
        },
        native: {
            source: {
                hasLocation: false,
                timestampMs: null,
                externalAccessory: false,
                simulated: false,
            },
            accessories: [],
        },
        precision: { active: false, avgAccuracy: null },
        ...overrides,
    };
}

describe('GpsReceiverStatusService resolver', () => {
    it('names a verified Bad Elf and confirms it is supplying the current position', () => {
        const status = resolveGpsReceiverStatus(
            input({
                native: {
                    source: {
                        hasLocation: true,
                        timestampMs: NOW - 2_000,
                        externalAccessory: true,
                        simulated: false,
                    },
                    accessories: [
                        {
                            manufacturer: 'Bad Elf',
                            name: 'GPS Pro',
                            modelNumber: 'BE-GPS-2200',
                            firmwareRevision: null,
                            hardwareRevision: null,
                        },
                    ],
                },
            }),
        );

        expect(status).toMatchObject({
            active: true,
            kind: 'ios-accessory',
            label: 'Bad Elf GPS Pro',
            deviceName: 'Bad Elf GPS Pro',
        });
        expect(status.detail).toContain('Connected to iPhone');
        expect(status.detail).toContain('Supplying position');
    });

    it('does not pretend a paired Bad Elf is currently supplying location', () => {
        const status = resolveGpsReceiverStatus(
            input({
                native: {
                    source: {
                        hasLocation: true,
                        timestampMs: NOW - 2_000,
                        externalAccessory: false,
                        simulated: false,
                    },
                    accessories: [
                        {
                            manufacturer: 'Bad Elf',
                            name: 'GPS Pro',
                            modelNumber: 'BE-GPS-2200',
                            firmwareRevision: null,
                            hardwareRevision: null,
                        },
                    ],
                },
            }),
        );

        expect(status.label).toBe('Bad Elf GPS Pro');
        expect(status.detail).toBe('Connected to iPhone · iPhone GPS currently in use');
    });

    it('keeps a 5-second NMEA source active through its visual stale window', () => {
        const status = resolveGpsReceiverStatus(
            input({
                nmea: {
                    connection: {
                        status: 'connected',
                        enabled: true,
                        host: '192.168.50.150',
                        port: 10110,
                        deviceId: 'signalk',
                        deviceLabel: 'Signal K Server',
                        transport: 'tcp',
                    },
                    feedStatus: 'stale',
                    fixAgeMs: 6_000,
                    satellites: 12,
                    hdop: 0.8,
                    qualityLabel: 'DGPS',
                },
            }),
        );

        expect(status).toMatchObject({
            active: true,
            kind: 'vessel-nmea',
            label: 'On-board GPS',
            deviceName: 'Signal K Server',
            satellites: 12,
            hdop: 0.8,
        });
        expect(status.detail).toBe('Last GPS sentence 6s ago via Signal K Server · DGPS · 12 sats · HDOP 0.8');
    });

    it('shows a connected vessel gateway honestly when no GPS sentence has arrived', () => {
        const status = resolveGpsReceiverStatus(
            input({
                nmea: {
                    ...input().nmea,
                    connection: {
                        ...input().nmea.connection,
                        status: 'connected',
                        enabled: true,
                        deviceLabel: 'Yacht Devices YDWG-02',
                    },
                },
            }),
        );

        expect(status).toMatchObject({ active: true, kind: 'vessel-nmea', label: 'On-board GPS' });
        expect(status.detail).toBe('Yacht Devices YDWG-02 connected · Waiting for GPS position');
    });

    it('labels precision-only location as unnamed rather than calling it an external device', () => {
        const status = resolveGpsReceiverStatus(input({ precision: { active: true, avgAccuracy: 2.1 } }));

        expect(status).toMatchObject({
            active: true,
            kind: 'precision-location',
            label: 'High-precision location',
        });
        expect(status.detail).toBe('±2.1m · Device identity unavailable');
    });

    it('does not attach an arbitrary name when multiple accessories are connected', () => {
        const status = resolveGpsReceiverStatus(
            input({
                native: {
                    source: {
                        hasLocation: true,
                        timestampMs: NOW - 1_000,
                        externalAccessory: true,
                        simulated: false,
                    },
                    accessories: [
                        {
                            manufacturer: 'Unknown',
                            name: 'Bridge Display',
                            modelNumber: null,
                            firmwareRevision: null,
                            hardwareRevision: null,
                        },
                        {
                            manufacturer: 'Unknown',
                            name: 'Cabin Audio',
                            modelNumber: null,
                            firmwareRevision: null,
                            hardwareRevision: null,
                        },
                    ],
                },
            }),
        );

        expect(status.label).toBe('External GPS');
        expect(status.deviceName).toBeNull();
        expect(status.detail).toContain('Multiple accessories connected');
    });

    it('formats manufacturer + short name without exposing a serial number', () => {
        expect(
            formatGpsAccessoryName({
                manufacturer: 'Bad Elf',
                name: 'GPS Pro',
                modelNumber: 'BE-GPS-2200',
                firmwareRevision: '2.0',
                hardwareRevision: '1.0',
            }),
        ).toBe('Bad Elf GPS Pro');
    });
});
