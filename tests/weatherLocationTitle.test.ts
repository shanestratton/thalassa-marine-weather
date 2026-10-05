import { describe, expect, it } from 'vitest';
import { weatherLocationTitle } from '../utils/weatherLocationTitle';

describe('vessel location display labels', () => {
    it.each([
        ['Serene Summer', 'Serene Summer'],
        ['', 'Vessel location'],
        [undefined, 'Vessel location'],
    ])(
        'uses %s instead of the Current Location sentinel before acquisition and before geocoding',
        (vesselName, expected) => {
            for (const status of [undefined, 'resolving', 'live', 'last-known'] as const) {
                expect(
                    weatherLocationTitle({
                        locationName: 'Current Location',
                        fallback: 'Current Location',
                        target: 'boat',
                        status,
                        vesselName,
                    }).title,
                ).toBe(expected);
            }
        },
    );
    it('keeps actual resolved placenames and coordinate labels', () => {
        for (const locationName of ['Lady Musgrave', '23.9070°S, 152.4040°E']) {
            expect(
                weatherLocationTitle({
                    locationName,
                    fallback: 'Current Location',
                    target: 'boat',
                    status: 'live',
                    vesselName: 'Serene Summer',
                }).title,
            ).toBe(locationName);
        }
    });
    it('does not revive a previous search label while the vessel report is still missing', () => {
        expect(
            weatherLocationTitle({
                fallback: 'Previous port',
                target: 'boat',
                status: 'live',
                vesselName: 'Serene Summer',
            }).title,
        ).toBe('Serene Summer');
        expect(weatherLocationTitle({ fallback: 'Select Location', target: 'boat' }).title).toBe('Vessel location');
    });
    it('keeps pending status explicit and never labels an unavailable vessel as acquired', () => {
        expect(
            weatherLocationTitle({
                fallback: 'Current Location',
                target: 'boat',
                status: 'resolving',
                vesselName: 'Serene Summer',
            }),
        ).toEqual({ title: 'Serene Summer', resolvingLabel: 'Finding Serene Summer’s location…' });
        expect(
            weatherLocationTitle({
                fallback: 'Current Location',
                target: 'boat',
                status: 'unavailable',
                vesselName: 'Serene Summer',
            }).title,
        ).toBe('Boat GPS unavailable');
    });
    it('retains phone pending and named-port behavior', () => {
        expect(weatherLocationTitle({ fallback: 'Current Location', target: 'phone', status: 'resolving' }).title).toBe(
            'Finding phone location…',
        );
        expect(
            weatherLocationTitle({
                locationName: 'Lady Musgrave',
                fallback: 'Current Location',
                target: null,
                vesselName: 'Serene Summer',
            }).title,
        ).toBe('Lady Musgrave');
    });
    it('names the boat being crewed on when the weather follows her (2026-10-05)', () => {
        // App passes the crewed boat's name as vesselName while the target is 'crew'.
        for (const status of [undefined, 'live', 'last-known'] as const) {
            expect(
                weatherLocationTitle({
                    locationName: 'Current Location',
                    fallback: 'Current Location',
                    target: 'crew',
                    status,
                    vesselName: 'Wind Dancer',
                }).title,
            ).toBe('Wind Dancer');
        }
        expect(
            weatherLocationTitle({
                fallback: 'Current Location',
                target: 'crew',
                status: 'resolving',
                vesselName: 'Wind Dancer',
            }),
        ).toEqual({ title: 'Wind Dancer', resolvingLabel: 'Finding Wind Dancer’s location…' });
        expect(
            weatherLocationTitle({
                fallback: 'Current Location',
                target: 'crew',
                status: 'unavailable',
                vesselName: 'Wind Dancer',
            }).title,
        ).toBe('Boat GPS unavailable');
        expect(
            weatherLocationTitle({
                locationName: 'Magnetic Island',
                fallback: 'Current Location',
                target: 'crew',
                status: 'live',
                vesselName: 'Wind Dancer',
            }).title,
        ).toBe('Magnetic Island');
    });
    it('a crewed boat with no name known is titled for her skipper, and found plainly', () => {
        // Not "Finding Your skipper's boat’s location…".
        expect(
            weatherLocationTitle({
                fallback: 'Current Location',
                target: 'crew',
                status: 'resolving',
                vesselName: null,
                unnamedVesselLabel: "Your skipper's boat",
            }),
        ).toEqual({ title: "Your skipper's boat", resolvingLabel: 'Finding vessel location…' });
        expect(
            weatherLocationTitle({
                locationName: 'Current Location',
                fallback: 'Current Location',
                target: 'crew',
                status: 'live',
                vesselName: '',
                unnamedVesselLabel: "Your skipper's boat",
            }).title,
        ).toBe("Your skipper's boat");
        // A known name always wins.
        expect(
            weatherLocationTitle({
                fallback: 'Current Location',
                target: 'crew',
                status: 'resolving',
                vesselName: 'Wind Dancer',
                unnamedVesselLabel: "Your skipper's boat",
            }).title,
        ).toBe('Wind Dancer');
    });
});
