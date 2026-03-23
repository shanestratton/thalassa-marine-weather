import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
    stories: ['../stories/**/*.stories.@(ts|tsx)'],
    addons: ['@storybook/addon-essentials'],
    framework: {
        name: '@storybook/react-vite',
        options: {},
    },
    viteFinal: async (config) => {
        // Reuse Vite config from the project
        return config;
    },
};

export default config;
