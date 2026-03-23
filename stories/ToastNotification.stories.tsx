import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';

/**
 * Toast — Notification toast component stories
 * Demonstrates the various toast states used throughout the app.
 */
const ToastNotification: React.FC<{
    message: string;
    type?: 'success' | 'error' | 'info' | 'warning';
    onDismiss?: () => void;
}> = ({ message, type = 'info', onDismiss }) => {
    const colorMap = {
        success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
        error: 'border-red-500/30 bg-red-500/10 text-red-300',
        info: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
        warning: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    };

    const iconMap = {
        success: '✓',
        error: '✕',
        info: 'ℹ',
        warning: '⚠',
    };

    return (
        <div
            className={`flex items-center gap-3 px-4 py-3 rounded-xl border backdrop-blur-xl shadow-2xl ${colorMap[type]}`}
            style={{ minWidth: 280, maxWidth: 400 }}
        >
            <span className="text-lg">{iconMap[type]}</span>
            <span className="text-sm font-medium flex-1">{message}</span>
            {onDismiss && (
                <button onClick={onDismiss} className="text-white/50 hover:text-white/80 text-sm">
                    ✕
                </button>
            )}
        </div>
    );
};

const meta: Meta<typeof ToastNotification> = {
    title: 'Feedback/ToastNotification',
    component: ToastNotification,
    tags: ['autodocs'],
    parameters: {
        layout: 'centered',
    },
};

export default meta;
type Story = StoryObj<typeof ToastNotification>;

export const Success: Story = {
    args: {
        message: 'Voyage plan saved successfully',
        type: 'success',
        onDismiss: () => {},
    },
};

export const Error: Story = {
    args: {
        message: 'Failed to fetch weather data',
        type: 'error',
        onDismiss: () => {},
    },
};

export const Info: Story = {
    args: {
        message: 'Anchor watch activated — monitoring position',
        type: 'info',
    },
};

export const Warning: Story = {
    args: {
        message: 'GPS signal lost — using last known position',
        type: 'warning',
        onDismiss: () => {},
    },
};
