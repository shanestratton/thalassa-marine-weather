import type { Meta, StoryObj } from '@storybook/react';
import React, { useState } from 'react';

// Standalone AuthBanner for Storybook (no haptics dep)
const AuthBanner: React.FC<{ onDismiss?: () => void }> = ({ onDismiss }) => (
    <div
        style={{
            background: 'linear-gradient(135deg, rgba(14, 165, 233, 0.1), rgba(14, 165, 233, 0.05))',
            border: '1px solid rgba(14, 165, 233, 0.2)',
            borderRadius: 12,
            padding: '14px 16px',
            color: '#f8fafc',
            fontFamily: 'Inter, system-ui, sans-serif',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            maxWidth: 400,
        }}
    >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>🔐</span>
            <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Sign in to join the crew</div>
                <div style={{ fontSize: 12, color: '#94a3b8' }}>Save messages, earn badges, and more</div>
            </div>
        </div>
        <button
            onClick={onDismiss}
            style={{
                background: 'none',
                border: 'none',
                color: '#64748b',
                fontSize: 18,
                cursor: 'pointer',
                padding: 4,
            }}
        >
            ✕
        </button>
    </div>
);

const meta: Meta<typeof AuthBanner> = {
    title: 'Chat/AuthBanner',
    component: AuthBanner,
    parameters: {
        backgrounds: { default: 'dark', values: [{ name: 'dark', value: '#0a0e1a' }] },
    },
};
export default meta;
type Story = StoryObj<typeof AuthBanner>;

export const Default: Story = {};

const DismissableExample = () => {
    const [visible, setVisible] = useState(true);
    return visible ? (
        <AuthBanner onDismiss={() => setVisible(false)} />
    ) : (
        <div style={{ color: '#64748b' }}>Dismissed</div>
    );
};

export const WithDismiss: Story = {
    render: () => <DismissableExample />,
};
