/**
 * Chat Service — Constants (table names, pre-seeded channels, config).
 */

import type { ChatChannel } from './types';

// --- TABLE NAMES ---
export const CHANNELS_TABLE = 'chat_channels';
export const MESSAGES_TABLE = 'chat_messages';
export const DM_TABLE = 'chat_direct_messages';
export const ROLES_TABLE = 'chat_roles';
export const DM_BLOCKS_TABLE = 'dm_blocks';

// --- CONFIG ---
export const PLATFORM_OWNER_EMAIL = 'shane.stratton@gmail.com';
export const CHANNELS_CACHE_KEY = 'thalassa_chat_channels_v1';
export const OFFLINE_QUEUE_KEY = 'chat_offline_queue';

// --- PIN DROP ---
export const PIN_DROP_PREFIX = '📍PIN|';

/**
 * Parse a pin drop from a DM message.
 * Returns null if the message is not a pin drop.
 */
export function parsePinDrop(message: string): { lat: number; lon: number; label: string } | null {
    if (!message.startsWith(PIN_DROP_PREFIX)) return null;
    const parts = message.slice(PIN_DROP_PREFIX.length).split('|');
    if (parts.length < 3) return null;
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    const label = parts.slice(2).join('|');
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return { lat, lon, label };
}

// --- PRE-SEEDED CHANNELS ---
export const DEFAULT_CHANNELS: Omit<ChatChannel, 'id' | 'created_at'>[] = [
    {
        name: 'Neighbourhood Watch',
        description: 'Maritime safety alerts, suspicious activity, and community watch',
        region: null,
        icon: '🛡️',
        is_global: true,
        is_private: false,
        owner_id: null,
        parent_id: null,
    },
    {
        name: 'Chandlery',
        description: 'Buy, sell, and trade new & used gear, boats, and services',
        region: null,
        icon: '⚓',
        is_global: true,
        is_private: false,
        owner_id: null,
        parent_id: null,
    },
    {
        name: 'Find Crew',
        description: 'Looking for crew or a berth? Connect here',
        region: null,
        icon: '👥',
        is_global: true,
        is_private: false,
        owner_id: null,
        parent_id: null,
    },
    {
        name: 'General',
        description: 'Open chat for all sailors',
        region: null,
        icon: '🌊',
        is_global: true,
        is_private: false,
        owner_id: null,
        parent_id: null,
    },
    {
        name: 'Anchorages',
        description: 'Share and discover anchorage spots',
        region: null,
        icon: '⚓',
        is_global: true,
        is_private: false,
        owner_id: null,
        parent_id: null,
    },
    {
        name: 'Fishing',
        description: 'Catches, spots, and techniques',
        region: null,
        icon: '🐟',
        is_global: true,
        is_private: false,
        owner_id: null,
        parent_id: null,
    },
    {
        name: 'Repairs & Gear',
        description: 'Maintenance tips, gear reviews, workshop recs',
        region: null,
        icon: '🔧',
        is_global: true,
        is_private: false,
        owner_id: null,
        parent_id: null,
    },
    {
        name: 'Weather Talk',
        description: 'Conditions, forecasts, and sea state discussion',
        region: null,
        icon: '🌤',
        is_global: true,
        is_private: false,
        owner_id: null,
        parent_id: null,
    },
];
