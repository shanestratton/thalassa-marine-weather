import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';

// Standalone icon grid for Storybook
const iconData = {
    Weather: [
        '🌬️ Wind',
        '🌊 Wave',
        '☀️ Sun',
        '🌙 Moon',
        '☁️ Cloud',
        '🌧️ Rain',
        '💧 Droplet',
        '🌡️ Thermometer',
        '🌅 Sunrise',
        '🌇 Sunset',
        '💦 Water',
        '🌊 TideCurve',
    ],
    Navigation: [
        '🧭 Compass',
        '📍 MapPin',
        '🗺️ Route',
        '🗺️ Map',
        '↔️ Arrows',
        '◀️ ChevronLeft',
        '⊕ Crosshair',
        '🚩 Flag',
    ],
    UI: [
        '🔍 Search',
        '👁️ Eye',
        '🔔 Bell',
        '✕ X',
        '✓ Check',
        '⚙️ Gear',
        '⭐ Star',
        '🕐 Clock',
        '🗑️ Trash',
        '➖ Minus',
        '➕ PlusSquare',
        '⚠️ AlertTriangle',
        '💬 Quote',
        '🔒 Lock',
        '💎 Diamond',
        '↗️ Share',
        '🐛 Bug',
        '📱 Phone',
        '☰ Grip',
    ],
    Maritime: [
        '⛵ Boat',
        '⛵ SailBoat',
        '🚤 PowerBoat',
        '⚓ Anchor',
        '☸️ ShipWheel',
        '📡 RadioTower',
        '🖥️ Server',
        '📅 Calendar',
        '📊 Gauge',
        '▶️ Play',
        '⏹️ Stop',
        '🔊 SpeakerWave',
        '⛽ Fuel',
        '🍽️ Food',
        '💬 Chat',
    ],
};

const IconGrid: React.FC = () => (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: '#f8fafc', padding: 20 }}>
        {Object.entries(iconData).map(([category, icons]) => (
            <div key={category} style={{ marginBottom: 24 }}>
                <h3
                    style={{
                        color: '#38bdf8',
                        fontSize: 14,
                        fontWeight: 600,
                        marginBottom: 12,
                        textTransform: 'uppercase',
                        letterSpacing: 1,
                    }}
                >
                    {category} ({icons.length})
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
                    {icons.map((icon) => (
                        <div
                            key={icon}
                            style={{
                                background: '#1e293b',
                                borderRadius: 8,
                                padding: '10px 12px',
                                fontSize: 13,
                                textAlign: 'center',
                                border: '1px solid #334155',
                            }}
                        >
                            {icon}
                        </div>
                    ))}
                </div>
            </div>
        ))}
    </div>
);

const meta: Meta<typeof IconGrid> = {
    title: 'Design System/Icon Grid',
    component: IconGrid,
    parameters: {
        backgrounds: { default: 'dark', values: [{ name: 'dark', value: '#0a0e1a' }] },
    },
};
export default meta;
type Story = StoryObj<typeof IconGrid>;

export const AllIcons: Story = {};
