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
                {
                    name: 'thalassa_v3_settings',
                    value: JSON.stringify({
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
                    }),
                },
            ],
        },
    ],
};
