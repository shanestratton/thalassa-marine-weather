import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';

/**
 * A standalone version of the DefaultErrorFallback for Storybook,
 * since the original is a non-exported inner component of ErrorBoundary.
 */
const DefaultErrorFallback: React.FC<{
    error?: Error | null;
    onRetry?: () => void;
    boundaryName?: string;
}> = ({ error, onRetry, boundaryName }) => (
    <div className="flex flex-col items-center justify-center p-8 bg-slate-900/80 rounded-2xl border border-red-500/30 shadow-[0_0_30px_rgba(239,68,68,0.1)] text-center min-h-[200px]">
        <div className="p-4 bg-red-500/20 rounded-full mb-4">
            <svg className="w-8 h-8 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
        </div>
        <h3 className="text-lg font-bold text-white mb-2">Something went wrong</h3>
        <p className="text-sm text-gray-400 mb-4 max-w-md">
            {boundaryName ? `Error in ${boundaryName}` : 'An unexpected error occurred'}
            {error?.message && (
                <span className="block mt-2 text-sm text-red-400/70 font-mono">{error.message.slice(0, 100)}</span>
            )}
        </p>
        {onRetry && (
            <button
                onClick={onRetry}
                className="px-4 py-2 bg-sky-500 hover:bg-sky-400 text-white text-sm font-bold rounded-lg transition-colors shadow-lg shadow-sky-500/30"
            >
                Try Again
            </button>
        )}
    </div>
);

const meta: Meta<typeof DefaultErrorFallback> = {
    title: 'Feedback/DefaultErrorFallback',
    component: DefaultErrorFallback,
    tags: ['autodocs'],
    parameters: {
        layout: 'centered',
    },
};

export default meta;
type Story = StoryObj<typeof DefaultErrorFallback>;

export const Default: Story = {
    args: {
        error: new Error('Cannot read properties of undefined'),
        boundaryName: 'WeatherWidget',
        onRetry: () => alert('Retrying...'),
    },
};

export const WithoutRetry: Story = {
    args: {
        error: new Error('Network timeout'),
        boundaryName: 'MapView',
    },
};

export const UnnamedBoundary: Story = {
    args: {
        error: new Error('Something broke'),
        onRetry: () => alert('Retrying...'),
    },
};

export const NoError: Story = {
    args: {
        boundaryName: 'Dashboard',
        onRetry: () => alert('Retrying...'),
    },
};
