/**
 * Profile Photo Service
 * 
 * Handles sailor profile photo uploads with:
 * - Client-side image resize/compression (max 512x512, WebP)
 * - Supabase Storage upload to `chat-avatars` bucket
 * - Gemini Vision moderation (catches inappropriate content)
 * - In-memory cache for avatar URLs
 * 
 * Supports: vessel photos, fishing trophy shots, beer gut selfies,
 * and any other maritime ego boosters.
 */

import { supabase } from './supabase';
import { GoogleGenerativeAI } from '@google/generative-ai';

// --- CONFIG ---
const BUCKET_NAME = 'chat-avatars';
const MAX_SIZE_PX = 512;
const JPEG_QUALITY = 0.8;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB after compression
const PROFILES_TABLE = 'chat_profiles';

// --- AI SETUP ---
let aiInstance: GoogleGenerativeAI | null = null;

const getGeminiKey = (): string => {
    let key = '';
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_GEMINI_API_KEY) {
        key = import.meta.env.VITE_GEMINI_API_KEY as string;
    }
    if (!key) {
        try {
            if (typeof process !== 'undefined' && process.env) {
                key = process.env.API_KEY || process.env.GEMINI_API_KEY || '';
            }
        } catch { /* browser env */ }
    }
    return key;
};

const getAI = (): GoogleGenerativeAI | null => {
    if (aiInstance) return aiInstance;
    const key = getGeminiKey();
    if (!key || key.length < 10 || key.includes('YOUR_')) return null;
    try {
        aiInstance = new GoogleGenerativeAI(key);
        return aiInstance;
    } catch {
        return null;
    }
};

// --- TYPES ---

export interface ChatProfile {
    user_id: string;
    display_name: string;
    avatar_url: string | null;
    bio: string | null;
    vessel_name: string | null;
    vessel_type: string | null;
    home_port: string | null;
    looking_for_love: boolean;
    created_at: string;
    updated_at: string;
}

export type PhotoModerationVerdict = 'approved' | 'rejected' | 'review';

export interface PhotoModerationResult {
    verdict: PhotoModerationVerdict;
    reason: string;
}

// --- AVATAR CACHE ---
const avatarCache = new Map<string, string>();

/**
 * Get cached avatar URL for a user. Returns null if not cached.
 */
export const getCachedAvatar = (userId: string): string | null => {
    return avatarCache.get(userId) || null;
};


// --- IMAGE PROCESSING ---

/**
 * Resize and compress an image file to max dimensions and JPEG quality.
 * Returns a Blob ready for upload.
 */
export const compressImage = (file: File): Promise<Blob> => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const reader = new FileReader();

        reader.onload = (e) => {
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let { width, height } = img;

                // Scale down proportionally
                if (width > MAX_SIZE_PX || height > MAX_SIZE_PX) {
                    const ratio = Math.min(MAX_SIZE_PX / width, MAX_SIZE_PX / height);
                    width = Math.round(width * ratio);
                    height = Math.round(height * ratio);
                }

                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');
                if (!ctx) { reject(new Error('Canvas context failed')); return; }

                // Draw with smooth scaling
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob(
                    (blob) => {
                        if (!blob) { reject(new Error('Compression failed')); return; }
                        if (blob.size > MAX_FILE_BYTES) {
                            // Retry with lower quality
                            canvas.toBlob(
                                (blob2) => {
                                    if (!blob2) { reject(new Error('Compression failed')); return; }
                                    resolve(blob2);
                                },
                                'image/jpeg',
                                0.5
                            );
                        } else {
                            resolve(blob);
                        }
                    },
                    'image/jpeg',
                    JPEG_QUALITY
                );
            };
            img.onerror = () => reject(new Error('Image load failed'));
            img.src = e.target?.result as string;
        };
        reader.onerror = () => reject(new Error('File read failed'));
        reader.readAsDataURL(file);
    });
};


// --- PHOTO MODERATION (Gemini Vision) ---

const PHOTO_MODERATION_PROMPT = `You are moderating profile photos for a sailing community app.

APPROVE if the image is:
- A person (any appearance, clothed or beach/boat attire)
- A boat, yacht, or vessel
- A fishing catch, marine scene, pet, or hobby photo
- Any reasonable profile photo

REJECT if the image is:
- Full nudity or explicit sexual content
- Graphic violence or gore
- Illegal content
- Not a photo (spam text, advertisements, QR codes)

IMPORTANT: Shirtless photos are FINE — this is a sailing app. Swimwear is FINE.
Beer guts are FINE. Fish trophies are FINE. Sunburns are FINE.

Return JSON only: { "verdict": "approved" | "rejected", "reason": "brief explanation" }`;

/**
 * Run a profile photo through Gemini Vision moderation.
 * Returns approved/rejected/review verdict.
 */
export const moderatePhoto = async (imageBlob: Blob): Promise<PhotoModerationResult> => {
    const ai = getAI();
    if (!ai) {
        // No AI → approve by default (fail open)
        return { verdict: 'approved', reason: 'AI moderation unavailable' };
    }

    try {
        // Convert blob to base64
        const buffer = await imageBlob.arrayBuffer();
        const base64 = btoa(
            new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        );

        const model = ai.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await Promise.race([
            model.generateContent({
                contents: [{
                    role: 'user',
                    parts: [
                        { text: PHOTO_MODERATION_PROMPT },
                        { inlineData: { mimeType: 'image/jpeg', data: base64 } },
                    ],
                }],
                generationConfig: { responseMimeType: 'application/json' },
            }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Photo moderation timeout')), 10000)
            ),
        ]);

        const responseText = result.response.text();
        let parsed: { verdict?: string; reason?: string } | null = null;

        try {
            let clean = responseText.replace(/```json/g, '').replace(/```/g, '');
            const firstBrace = clean.indexOf('{');
            const lastBrace = clean.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) {
                clean = clean.substring(firstBrace, lastBrace + 1);
            }
            parsed = JSON.parse(clean);
        } catch {
            parsed = null;
        }

        if (!parsed || !parsed.verdict) {
            return { verdict: 'approved', reason: 'Failed to parse moderation response' };
        }

        return {
            verdict: parsed.verdict === 'rejected' ? 'rejected' : 'approved',
            reason: parsed.reason || '',
        };
    } catch {
        // Timeout or error → approve (fail open)
        return { verdict: 'approved', reason: 'Moderation error — approved by default' };
    }
};


// --- UPLOAD & PROFILE ---

/**
 * Upload a profile photo. Full pipeline:
 * 1. Compress image
 * 2. Moderate via Gemini Vision
 * 3. Upload to Supabase Storage
 * 4. Save URL to chat_profiles
 * 5. Update cache
 */
export const uploadProfilePhoto = async (
    file: File,
    onProgress?: (step: string) => void
): Promise<{ success: boolean; url?: string; error?: string }> => {
    if (!supabase) return { success: false, error: 'Supabase not configured' };

    try {
        // Get current user
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return { success: false, error: 'Not authenticated' };

        // Step 1: Compress
        onProgress?.('Optimizing photo...');
        const compressed = await compressImage(file);

        // Step 2: Moderate with Gemini Vision
        onProgress?.('Checking content...');
        const modResult = await moderatePhoto(compressed);

        if (modResult.verdict === 'rejected') {
            return {
                success: false,
                error: `Photo not approved: ${modResult.reason}. Try a different photo.`,
            };
        }

        // Step 3: Upload to Supabase Storage
        onProgress?.('Uploading...');
        const fileName = `${user.id}/avatar-${Date.now()}.jpg`;

        // Remove old avatar first
        const { data: existingFiles } = await supabase.storage
            .from(BUCKET_NAME)
            .list(user.id);

        if (existingFiles && existingFiles.length > 0) {
            const filesToRemove = existingFiles.map(f => `${user.id}/${f.name}`);
            await supabase.storage.from(BUCKET_NAME).remove(filesToRemove);
        }

        const { error: uploadError } = await supabase.storage
            .from(BUCKET_NAME)
            .upload(fileName, compressed, {
                contentType: 'image/jpeg',
                upsert: true,
            });

        if (uploadError) {
            return { success: false, error: `Upload failed: ${uploadError.message}` };
        }

        // Step 4: Get public URL
        const { data: urlData } = supabase.storage
            .from(BUCKET_NAME)
            .getPublicUrl(fileName);

        const publicUrl = urlData?.publicUrl;
        if (!publicUrl) return { success: false, error: 'Failed to get public URL' };

        // Step 5: Save to profile
        onProgress?.('Saving profile...');
        await supabase
            .from(PROFILES_TABLE)
            .upsert({
                user_id: user.id,
                avatar_url: publicUrl,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'user_id' });

        // Step 6: Update cache
        avatarCache.set(user.id, publicUrl);

        return { success: true, url: publicUrl };
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        return { success: false, error: msg };
    }
};

/**
 * Remove current profile photo
 */
export const removeProfilePhoto = async (): Promise<boolean> => {
    if (!supabase) return false;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;

    // Remove from storage
    const { data: files } = await supabase.storage
        .from(BUCKET_NAME)
        .list(user.id);

    if (files && files.length > 0) {
        const filesToRemove = files.map(f => `${user.id}/${f.name}`);
        await supabase.storage.from(BUCKET_NAME).remove(filesToRemove);
    }

    // Clear from profile
    await supabase
        .from(PROFILES_TABLE)
        .update({ avatar_url: null, updated_at: new Date().toISOString() })
        .eq('user_id', user.id);

    // Clear cache
    avatarCache.delete(user.id);

    return true;
};

/**
 * Get a user's profile (with avatar URL)
 */
export const getProfile = async (userId: string): Promise<ChatProfile | null> => {
    if (!supabase) return null;

    // Check cache first
    const cached = avatarCache.get(userId);

    const { data } = await supabase
        .from(PROFILES_TABLE)
        .select('*')
        .eq('user_id', userId)
        .single();

    if (data) {
        const profile = data as ChatProfile;
        if (profile.avatar_url) {
            avatarCache.set(userId, profile.avatar_url);
        }
        return profile;
    }

    // Return minimal profile with cache hit
    if (cached) {
        return {
            user_id: userId,
            display_name: '',
            avatar_url: cached,
            bio: null,
            vessel_name: null,
            vessel_type: null,
            home_port: null,
            looking_for_love: false,
            created_at: '',
            updated_at: '',
        };
    }

    return null;
};

/**
 * Update profile bio/vessel info
 */
export const updateProfile = async (updates: {
    display_name?: string;
    bio?: string;
    vessel_name?: string;
    vessel_type?: string;
    home_port?: string;
    looking_for_love?: boolean;
}): Promise<boolean> => {
    if (!supabase) return false;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;

    const { error } = await supabase
        .from(PROFILES_TABLE)
        .upsert({
            user_id: user.id,
            ...updates,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });

    return !error;
};

/**
 * Batch-fetch avatar URLs for a list of user IDs.
 * Populates the cache and returns a map.
 */
export const batchFetchAvatars = async (userIds: string[]): Promise<Map<string, string>> => {
    const result = new Map<string, string>();
    if (!supabase || userIds.length === 0) return result;

    // Filter out already cached
    const uncached = userIds.filter(id => !avatarCache.has(id));

    if (uncached.length > 0) {
        const { data } = await supabase
            .from(PROFILES_TABLE)
            .select('user_id, avatar_url')
            .in('user_id', uncached)
            .not('avatar_url', 'is', null);

        if (data) {
            for (const row of data) {
                if (row.avatar_url) {
                    avatarCache.set(row.user_id, row.avatar_url);
                }
            }
        }
    }

    // Build return map from cache
    for (const id of userIds) {
        const url = avatarCache.get(id);
        if (url) result.set(id, url);
    }

    return result;
};
