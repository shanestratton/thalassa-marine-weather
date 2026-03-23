import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';

/**
 * MaritimeMetric — Instrument-style metric display
 * Used in dashboards, anchor watch, and voyage results.
 */
const MaritimeMetric: React.FC<{
    label: string;
    value: string | number;
    unit?: string;
    trend?: 'up' | 'down' | 'stable';
    size?: 'sm' | 'md' | 'lg';
}> = ({ label, value, unit, trend, size = 'md' }) => {
    const trendIcon = {
        up: '↑',
        down: '↓',
        stable: '→',
    };

    const trendColor = {
        up: 'text-emerald-400',
        down: 'text-red-400',
        stable: 'text-gray-400',
    };

    const sizeStyles = {
        sm: { value: 'text-lg', label: 'text-xs', pad: 'p-2' },
        md: { value: 'text-2xl', label: 'text-xs', pad: 'p-3' },
        lg: { value: 'text-4xl', label: 'text-sm', pad: 'p-4' },
    };

    const s = sizeStyles[size];

    return (
        <div className={`bg-slate-800/60 rounded-xl border border-white/5 ${s.pad} backdrop-blur-sm`}>
            <div className={`${s.label} text-gray-400 uppercase tracking-wider mb-1`}>{label}</div>
            <div className="flex items-baseline gap-1">
                <span className={`${s.value} font-bold text-white font-mono tabular-nums`}>{value}</span>
                {unit && <span className={`${s.label} text-gray-500`}>{unit}</span>}
                {trend && <span className={`${s.label} ${trendColor[trend]} ml-1`}>{trendIcon[trend]}</span>}
            </div>
        </div>
    );
};

const meta: Meta<typeof MaritimeMetric> = {
    title: 'Data Display/MaritimeMetric',
    component: MaritimeMetric,
    tags: ['autodocs'],
    parameters: {
        layout: 'centered',
    },
};

export default meta;
type Story = StoryObj<typeof MaritimeMetric>;

export const WindSpeed: Story = {
    args: { label: 'Wind Speed', value: '18.5', unit: 'kts', trend: 'up', size: 'md' },
};

export const SOG: Story = {
    args: { label: 'SOG', value: '6.2', unit: 'kts', trend: 'stable' },
};

export const Heading: Story = {
    args: { label: 'HDG', value: '247', unit: '°T' },
};

export const Depth: Story = {
    args: { label: 'Depth', value: '12.4', unit: 'm', trend: 'down', size: 'lg' },
};

export const Small: Story = {
    args: { label: 'BARO', value: '1013', unit: 'hPa', size: 'sm' },
};

export const DashboardRow: Story = {
    render: () => (
        <div className="flex gap-3">
            <MaritimeMetric label="SOG" value="6.2" unit="kts" trend="stable" />
            <MaritimeMetric label="COG" value="247" unit="°T" />
            <MaritimeMetric label="Wind" value="18.5" unit="kts" trend="up" />
            <MaritimeMetric label="Depth" value="12.4" unit="m" trend="down" />
        </div>
    ),
};
