import type { BrowserContextOptions } from '@playwright/test';

type InlineStorageState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>;

const ORIGIN = 'http://localhost:3000';

export const DISCLAIMER_STORAGE: InlineStorageState = {
    cookies: [],
    origins: [
        {
            origin: ORIGIN,
            localStorage: [{ name: 'thalassa_disclaimer_v1.0', value: 'accepted' }],
        },
    ],
};

export const ONBOARDED_STORAGE: InlineStorageState = {
    cookies: [],
    origins: [
        {
            origin: ORIGIN,
            localStorage: [
                { name: 'thalassa_disclaimer_v1.0', value: 'accepted' },
                { name: 'thalassa_v3_onboarded::anonymous', value: 'true' },
                { name: 'thalassa_install_dismissed', value: 'true' },
                { name: 'thalassa_chart_key_seen_v1', value: 'e2e' },
                ...settingsFixtureStorage(),
                ...weatherFixtureStorage(),
            ],
        },
    ],
};

function settingsFixtureStorage(): { name: string; value: string }[] {
    const settings = {
        defaultLocation: 'Sydney, NSW',
        units: {
            speed: 'kts',
            temp: 'C',
            distance: 'nm',
            length: 'm',
            tideHeight: 'm',
            waveHeight: 'm',
            visibility: 'nm',
            volume: 'l',
        },
        vessel: {
            name: 'Test Vessel',
            type: 'sail',
            length: 35,
            beam: 11,
            draft: 6,
            displacement: 12000,
        },
        savedLocations: ['Sydney, NSW'],
    };
    const value = JSON.stringify({ version: 2, owner_user_id: null, settings });

    // The mirror provides the synchronous first render; the Preferences key
    // keeps the async hydration path deterministic in the browser harness.
    return [
        { name: 'thalassa_settings_mirror::anonymous', value },
        { name: 'CapacitorStorage.thalassa_settings::anonymous', value },
    ];
}

function weatherFixtureStorage(): { name: string; value: string }[] {
    // A fresh, scoped cache keeps browser tests deterministic and prevents a
    // parallel test run from hammering the live weather providers. It models a
    // normal warm launch, which is the state these post-onboarding journeys
    // are meant to exercise.
    const weather = {
        locationName: 'Sydney, NSW',
        coordinates: { lat: -33.8688, lon: 151.2093 },
        locationType: 'coastal',
        generatedAt: new Date().toISOString(),
        timeZone: 'Australia/Sydney',
        utcOffset: 600,
        current: {
            windSpeed: 12,
            windGust: 16,
            windDirection: 'SE',
            windDegree: 135,
            waveHeight: 1.1,
            swellPeriod: 8,
            airTemperature: 22,
            waterTemperature: 20,
            condition: 'Partly Cloudy',
            description: 'Partly cloudy',
            humidity: 68,
            pressure: 1015,
            precipitation: 0,
            visibility: 10,
            uvIndex: 4,
        },
        alerts: [],
        hourly: [],
        forecast: [],
        tides: [],
        tideHourly: [],
        boatingAdvice: 'Conditions are suitable for a coastal passage.',
        modelUsed: 'e2e-fixture',
    };

    return [
        { name: 'thalassa_weather_cache_schema::anonymous', value: JSON.stringify('v19.2-WEATHERKIT-FIX') },
        { name: 'thalassa_weather_cache_v9::anonymous', value: JSON.stringify(weather) },
        {
            name: 'thalassa_rain_rainbow_-33.87_151.21',
            value: JSON.stringify({
                ts: Date.now(),
                data: [{ time: new Date().toISOString(), intensity: 0 }],
                summary: 'No rain expected in the next hour.',
                source: 'rainbow',
            }),
        },
    ];
}
