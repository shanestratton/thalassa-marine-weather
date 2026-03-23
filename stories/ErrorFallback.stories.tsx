import type { Meta, StoryObj } from '@storybook/react';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React from 'react';
import { CompactErrorFallback } from '../components/ErrorBoundary';

const meta: Meta<typeof CompactErrorFallback> = {
    title: 'Feedback/CompactErrorFallback',
    component: CompactErrorFallback,
    tags: ['autodocs'],
    parameters: {
        layout: 'padded',
    },
};

export default meta;
type Story = StoryObj<typeof CompactErrorFallback>;

export const Default: Story = {};

export const CustomMessage: Story = {
    args: {
        message: 'Weather data temporarily unavailable',
    },
};

export const LongMessage: Story = {
    args: {
        message: 'Unable to connect to Stormglass API — check your internet and try again',
    },
};
