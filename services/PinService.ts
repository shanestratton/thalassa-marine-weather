/**
 * PinService — Saved pins with Supabase persistence
 *
 * Personal pin history: every pin you drop (in chat or log page) is
 * saved here so you can quickly re-share favourite spots.
 *
 * Table: saved_pins
 */

import { supabase } from './supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';

// --- TYPES ---

export interface SavedPin {
    id: string;
    user_id: string;
    latitude: number;
    longitude: number;
    caption: string;
    category: string; // e.g. 'pin_scenic', 'pin_food', 'pin_repairs', 'general'
    region?: string;
    created_at: string;
}

const TABLE = 'saved_pins';

async function verifyAuthenticatedOwner(identity: AuthIdentityScope): Promise<string | null> {
    if (!supabase || !identity.userId || !isAuthIdentityScopeCurrent(identity)) return null;
    const {
        data: { user },
        error,
    } = await supabase.auth.getUser();
    if (error || user?.id !== identity.userId || !isAuthIdentityScopeCurrent(identity)) return null;
    return identity.userId;
}

// --- SERVICE ---

class PinServiceClass {
    /**
     * Save a pin to the user's personal history.
     */
    async savePin(pin: {
        latitude: number;
        longitude: number;
        caption: string;
        category?: string;
        region?: string;
    }): Promise<SavedPin | null> {
        if (!supabase) return null;

        const identity = getAuthIdentityScope();
        const ownerId = await verifyAuthenticatedOwner(identity);
        if (!ownerId) return null;

        const { data, error } = await supabase
            .from(TABLE)
            .insert({
                user_id: ownerId,
                latitude: pin.latitude,
                longitude: pin.longitude,
                caption: pin.caption,
                category: pin.category || 'general',
                region: pin.region || null,
            })
            .select()
            .single();

        if (error || !isAuthIdentityScopeCurrent(identity)) {
            return null;
        }
        return data as SavedPin;
    }

    /**
     * Get the user's saved pins, most recent first.
     */
    async getMyPins(limit = 20): Promise<SavedPin[]> {
        if (!supabase) return [];

        const identity = getAuthIdentityScope();
        const ownerId = await verifyAuthenticatedOwner(identity);
        if (!ownerId) return [];

        const { data, error } = await supabase
            .from(TABLE)
            .select('*')
            .eq('user_id', ownerId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error || !isAuthIdentityScopeCurrent(identity)) {
            return [];
        }
        return (data || []) as SavedPin[];
    }

    /**
     * Delete a saved pin.
     */
    async deletePin(pinId: string): Promise<boolean> {
        if (!supabase) return false;

        const identity = getAuthIdentityScope();
        const ownerId = await verifyAuthenticatedOwner(identity);
        if (!ownerId) return false;

        const { error } = await supabase.from(TABLE).delete().eq('id', pinId).eq('user_id', ownerId);

        return !error && isAuthIdentityScopeCurrent(identity);
    }

    /**
     * Format a pin's coordinates for display.
     */
    formatCoords(lat: number, lng: number): string {
        return `${Math.abs(lat).toFixed(4)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lng).toFixed(4)}°${lng < 0 ? 'W' : 'E'}`;
    }
}

// Export singleton
export const PinService = new PinServiceClass();
