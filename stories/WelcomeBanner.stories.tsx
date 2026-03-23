import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';

// Simple standalone component for Storybook (no service deps)
const WelcomeBanner: React.FC = () => (
    <div
        style={{
            background: 'linear-gradient(135deg, #0f172a, #1e293b)',
            borderRadius: 16,
            padding: '24px 20px',
            color: '#f8fafc',
            fontFamily: 'Inter, system-ui, sans-serif',
            maxWidth: 400,
        }}
    >
        <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>🌊 Welcome Aboard!</div>
        <p style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.6, margin: 0 }}>
            Thalassa is your maritime weather companion. Ask questions about conditions, routes, and safety — the AI
            crew has your back.
        </p>
        <div
            style={{
                marginTop: 16,
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
            }}
        >
            {['💬 Ask a question', '🧭 Plan a route', '⚓ Check anchorage'].map((tip) => (
                <span
                    key={tip}
                    style={{
                        background: 'rgba(14, 165, 233, 0.15)',
                        color: '#38bdf8',
                        padding: '6px 12px',
                        borderRadius: 20,
                        fontSize: 12,
                        fontWeight: 500,
                    }}
                >
                    {tip}
                </span>
            ))}
        </div>
    </div>
);

const meta: Meta<typeof WelcomeBanner> = {
    title: 'Chat/WelcomeBanner',
    component: WelcomeBanner,
    parameters: {
        backgrounds: { default: 'dark', values: [{ name: 'dark', value: '#0a0e1a' }] },
    },
};
export default meta;
type Story = StoryObj<typeof WelcomeBanner>;

export const Default: Story = {};
