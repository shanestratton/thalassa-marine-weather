import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';

/**
 * StatusBadge — Crew status indicator
 * Used in crew cards and user profiles.
 */
const StatusBadge: React.FC<{
    status: 'online' | 'offline' | 'away' | 'busy';
    label?: string;
    size?: 'sm' | 'md' | 'lg';
}> = ({ status, label, size = 'md' }) => {
    const colorMap = {
        online: 'bg-emerald-500',
        offline: 'bg-gray-500',
        away: 'bg-amber-500',
        busy: 'bg-red-500',
    };

    const sizeMap = {
        sm: 'w-2 h-2',
        md: 'w-3 h-3',
        lg: 'w-4 h-4',
    };

    const labelMap = {
        online: 'Online',
        offline: 'Offline',
        away: 'Away',
        busy: 'Do not disturb',
    };

    return (
        <div className="inline-flex items-center gap-2">
            <span className={`${colorMap[status]} ${sizeMap[size]} rounded-full ring-2 ring-slate-900`} />
            {label !== undefined ? (
                <span className="text-sm text-gray-300">{label}</span>
            ) : (
                <span className="text-sm text-gray-300">{labelMap[status]}</span>
            )}
        </div>
    );
};

const meta: Meta<typeof StatusBadge> = {
    title: 'Data Display/StatusBadge',
    component: StatusBadge,
    tags: ['autodocs'],
    parameters: {
        layout: 'centered',
    },
};

export default meta;
type Story = StoryObj<typeof StatusBadge>;

export const Online: Story = { args: { status: 'online' } };
export const Offline: Story = { args: { status: 'offline' } };
export const Away: Story = { args: { status: 'away' } };
export const Busy: Story = { args: { status: 'busy' } };

export const Small: Story = { args: { status: 'online', size: 'sm' } };
export const Large: Story = { args: { status: 'online', size: 'lg' } };

export const CustomLabel: Story = {
    args: { status: 'online', label: 'Captain Shane' },
};
