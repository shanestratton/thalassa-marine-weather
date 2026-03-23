import type { Meta, StoryObj } from '@storybook/react';
import React, { useState } from 'react';

// Standalone SlideToAction for Storybook
const SlideToAction: React.FC<{ label?: string; onComplete?: () => void }> = ({
    label = 'Slide to confirm',
    onComplete,
}) => {
    const [completed, setCompleted] = useState(false);

    return (
        <div
            style={{
                position: 'relative',
                width: 300,
                height: 56,
                borderRadius: 28,
                background: completed ? 'rgba(34, 197, 94, 0.2)' : '#1e293b',
                border: `1px solid ${completed ? '#22c55e' : '#334155'}`,
                overflow: 'hidden',
                fontFamily: 'Inter, system-ui, sans-serif',
            }}
        >
            <div
                style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: completed ? '#22c55e' : '#64748b',
                    fontSize: 14,
                    fontWeight: 500,
                }}
            >
                {completed ? '✓ Confirmed' : label}
            </div>
            {!completed && (
                <div
                    style={{
                        width: 48,
                        height: 48,
                        borderRadius: 24,
                        background: 'linear-gradient(135deg, #0ea5e9, #38bdf8)',
                        margin: 4,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        fontSize: 20,
                    }}
                    onClick={() => {
                        setCompleted(true);
                        onComplete?.();
                    }}
                >
                    →
                </div>
            )}
        </div>
    );
};

const meta: Meta<typeof SlideToAction> = {
    title: 'Components/SlideToAction',
    component: SlideToAction,
    parameters: {
        backgrounds: { default: 'dark', values: [{ name: 'dark', value: '#0a0e1a' }] },
    },
};
export default meta;
type Story = StoryObj<typeof SlideToAction>;

export const Default: Story = { args: { label: 'Slide to anchor' } };
export const CustomLabel: Story = { args: { label: 'Slide to start tracking' } };
