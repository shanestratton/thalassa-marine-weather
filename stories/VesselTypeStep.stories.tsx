import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';

// Standalone VesselTypeStep for Storybook
const vessels = [
    { type: 'sailboat', emoji: '⛵', label: 'Sailboat', desc: 'Wind-powered vessel' },
    { type: 'powerboat', emoji: '🚤', label: 'Powerboat', desc: 'Motor-powered vessel' },
    { type: 'observer', emoji: '🔭', label: 'Observer', desc: 'Shore-based weather watcher' },
];

const VesselTypeStep: React.FC<{ selected?: string }> = ({ selected = 'sailboat' }) => (
    <div
        style={{
            fontFamily: 'Inter, system-ui, sans-serif',
            color: '#f8fafc',
            maxWidth: 360,
            padding: 24,
        }}
    >
        <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Your Vessel</h2>
        <p style={{ color: '#94a3b8', fontSize: 13, marginBottom: 20 }}>
            This helps us tailor weather forecasts and recommendations.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {vessels.map(({ type, emoji, label, desc }) => (
                <button
                    key={type}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 14,
                        padding: '14px 16px',
                        borderRadius: 12,
                        border: type === selected ? '2px solid #0ea5e9' : '1px solid #334155',
                        background: type === selected ? 'rgba(14, 165, 233, 0.1)' : '#1e293b',
                        color: '#f8fafc',
                        cursor: 'pointer',
                        textAlign: 'left',
                    }}
                >
                    <span style={{ fontSize: 28 }}>{emoji}</span>
                    <div>
                        <div style={{ fontSize: 15, fontWeight: 600 }}>{label}</div>
                        <div style={{ fontSize: 12, color: '#94a3b8' }}>{desc}</div>
                    </div>
                </button>
            ))}
        </div>
    </div>
);

const meta: Meta<typeof VesselTypeStep> = {
    title: 'Onboarding/VesselTypeStep',
    component: VesselTypeStep,
    parameters: {
        backgrounds: { default: 'dark', values: [{ name: 'dark', value: '#0a0e1a' }] },
    },
};
export default meta;
type Story = StoryObj<typeof VesselTypeStep>;

export const Sailboat: Story = { args: { selected: 'sailboat' } };
export const Powerboat: Story = { args: { selected: 'powerboat' } };
export const Observer: Story = { args: { selected: 'observer' } };
