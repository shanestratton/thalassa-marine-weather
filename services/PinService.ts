/**
 * PinService — Saved pins with Supabase persistence
 * 
 * Personal pin history: every pin you drop (in chat or log page) is
 * saved here so you can quickly re-share favourite spots.
 * 
 * Table: saved_pins
 */

import { supabase } from './supabase';

// --- TYPES ---

export interface SavedPin {
    id: string;
    user_id: string;
    latitude: number;
    longitude: number;
    caption: string;
    category: string;      // e.g. 'pin_scenic', 'pin_food', 'pin_repairs', 'general'
    region?: string;
    created_at: string;
}

const TABLE = 'saved_pins';

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

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return null;

        const { data, error } = await supabase
            .from(TABLE)
            .insert({
                user_id: user.id,
                latitude: pin.latitude,
                longitude: pin.longitude,
                caption: pin.caption,
                category: pin.category || 'general',
                region: pin.region || null,
            })
            .select()
            .single();

        if (error) {
            console.warn('[PinService] Failed to save pin:', error.message);
            return null;
        }
        return data as SavedPin;
    }

    /**
     * Get the user's saved pins, most recent first.
     */
    async getMyPins(limit = 20): Promise<SavedPin[]> {
        if (!supabase) return [];

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return [];

        const { data, error } = await supabase
            .from(TABLE)
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.warn('[PinService] Failed to fetch pins:', error.message);
            return [];
        }
        return (data || []) as SavedPin[];
    }

    /**
     * Delete a saved pin.
     */
    async deletePin(pinId: string): Promise<boolean> {
        if (!supabase) return false;

        const { error } = await supabase
            .from(TABLE)
            .delete()
            .eq('id', pinId);

        return !error;
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
