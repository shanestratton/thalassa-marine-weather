/**
 * Channel names and glyphs for Scuttlebutt, shared by the channel list and the
 * header.
 *
 * The seeded channels carry emoji in the database (🛡️ 🌊 🐟 🔧 …), which drew
 * full-colour emoji beside the app's line icons (UX scorecard run 6). Known
 * channels now draw a stroke icon from components/icons. A channel a sailor
 * proposed keeps the emoji they picked — that is their content, not chrome.
 */
import React from 'react';
import {
    AnchorIcon,
    ChatIcon,
    EyeIcon,
    LifeBuoyIcon,
    LockIcon,
    PartlyCloudyIcon,
    UsersIcon,
    WaveIcon,
    WrenchIcon,
} from '../Icons';

type StrokeIcon = React.FC<{ className?: string }>;

/** Keyed on the channel's stored name, before any display rename. */
const CHANNEL_GLYPHS: Record<string, StrokeIcon> = {
    'Neighbourhood Watch': EyeIcon,
    'Find Crew': UsersIcon,
    General: ChatIcon,
    Anchorages: AnchorIcon,
    // The icon set has no fish; the sea is the closest honest glyph.
    Fishing: WaveIcon,
    'Repairs & Gear': WrenchIcon,
    'Weather Talk': PartlyCloudyIcon,
    SOLAS: LifeBuoyIcon,
    Safety: LifeBuoyIcon,
};

const NAME_OVERRIDES: Record<string, string> = {
    'Find Crew': 'The Crew List',
};

export const getChannelName = (ch: { name: string }) => NAME_OVERRIDES[ch.name] ?? ch.name;

/**
 * The glyph for a channel, always decorative (the channel name is the label).
 * Private channels show a lock; unknown channels show their own emoji.
 */
export const ChannelGlyph: React.FC<{
    channel: { name: string; icon: string; is_private?: boolean };
    className?: string;
}> = ({ channel, className = 'h-5 w-5' }) => {
    if (channel.is_private) return <LockIcon className={className} />;
    const Glyph = CHANNEL_GLYPHS[channel.name];
    if (Glyph) return <Glyph className={className} />;
    return <span aria-hidden="true">{channel.icon}</span>;
};
