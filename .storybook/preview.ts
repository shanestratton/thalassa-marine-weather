import type { Preview } from '@storybook/react';
import '../index.css';

const preview: Preview = {
    parameters: {
        backgrounds: {
            default: 'thalassa-dark',
            values: [
                { name: 'thalassa-dark', value: '#0f172a' },
                { name: 'thalassa-light', value: '#f8fafc' },
                { name: 'thalassa-night', value: '#1a0505' },
            ],
        },
        controls: {
            matchers: {
                color: /(background|color)$/i,
                date: /Date$/i,
            },
        },
    },
};

export default preview;
