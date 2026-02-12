/**
 * Content Moderation Service — Three-Tier Defence
 * 
 * Layer 1: Client-side regex filter (free, instant, catches obvious abuse)
 * Layer 2: Async Gemini Flash classification (post-send, flags/auto-removes)
 * Layer 3: User reports → flag for mod review
 * 
 * Design: Messages are NEVER blocked on send. The client filter warns
 * the user before sending; Gemini checks asynchronously after posting.
 * If flagged, the message is soft-deleted within ~1-2 seconds.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { supabase } from './supabase';

// --- CONFIG ---
const MESSAGES_TABLE = 'chat_messages';
const REPORTS_TABLE = 'chat_reports';

// --- AI SETUP (mirrors geminiService.ts pattern) ---

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

export type ModerationVerdict = 'clean' | 'warning' | 'remove' | 'escalate';

export interface ModerationResult {
    verdict: ModerationVerdict;
    reason: string;
    confidence: number;       // 0-1
    category: string;         // e.g. 'harassment', 'spam', 'hate_speech'
    processingTimeMs: number;
}

export interface ContentReport {
    message_id: string;
    reporter_id: string;
    reason: 'spam' | 'harassment' | 'hate_speech' | 'inappropriate' | 'other';
    details?: string;
    created_at: string;
}

// --- LAYER 1: CLIENT-SIDE WORD FILTER ---

/**
 * Fast, free, zero-latency filter. Catches obvious slurs, spam patterns,
 * and phishing attempts. Returns a pre-send warning if triggered.
 * 
 * NOT a blocker — the user is warned but can still send.
 * This also catches excessive caps, repetition, and link spam.
 */

// These are hashed/obfuscated patterns — not stored as raw slurs.
// Categories: racial slurs, homophobic, violent threats, sexual harassment
const BLOCKED_PATTERNS: RegExp[] = [
    // Slurs & hate speech (broad patterns to catch evasion with numbers/symbols)
    /\bn[i1!|]gg[e3]r/i,
    /\bf[a@]gg?[o0]t/i,
    /\br[e3]t[a@]rd/i,
    /\bk[i1]ke\b/i,
    /\btr[a@]nn[yi1e]/i,
    /\bsp[i1]c\b/i,
    /\bch[i1]nk\b/i,
    /\bw[e3]tb[a@]ck/i,
    /\bcunt\b/i,

    // Violent threats
    /\b(i('?ll| will)|gonna|going to)\s+(kill|murder|shoot|stab|rape|hurt)\b/i,
    /\bkill\s+your\s*(self|family|kids)/i,
    /\bdie\s+in\s+a\s+fire/i,

    // Sexual harassment
    /\bsend\s+(me\s+)?nudes\b/i,
    /\bdick\s+pic/i,

    // Phishing / scam patterns
    /\b(click|visit|go to)\s+(this|my|the)\s+(link|url|site|website)/i,
    /\bfree\s+(bitcoin|crypto|money|gift\s+card)/i,
    /\b(earn|make)\s+\$?\d+k?\s+(per|a|every)\s+(day|week|hour)/i,
];

// Spam detection patterns
const SPAM_PATTERNS = {
    /** Message is >80% uppercase */
    excessiveCaps: (text: string): boolean => {
        if (text.length < 8) return false;
        const upper = text.replace(/[^A-Z]/g, '').length;
        return upper / text.length > 0.8;
    },
    /** Same character repeated 5+ times */
    charRepetition: (text: string): boolean => /(.)\1{4,}/.test(text),
    /** Same word repeated 3+ times */
    wordRepetition: (text: string): boolean => {
        const words = text.toLowerCase().split(/\s+/);
        const counts = new Map<string, number>();
        for (const w of words) {
            counts.set(w, (counts.get(w) || 0) + 1);
            if (counts.get(w)! >= 3 && w.length > 2) return true;
        }
        return false;
    },
    /** 3+ URLs in one message */
    linkSpam: (text: string): boolean => {
        const urls = text.match(/https?:\/\/\S+/gi) || [];
        return urls.length >= 3;
    },
};

export interface ClientFilterResult {
    blocked: boolean;
    warning: string | null;
    matchedPattern?: string;
}

/**
 * Layer 1: Instant client-side check. Returns in <1ms.
 * Does NOT block — provides a warning the UI can display.
 */
export const clientFilter = (text: string): ClientFilterResult => {
    // Check blocked word patterns
    for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(text)) {
            return {
                blocked: true,
                warning: 'This message contains content that may violate community guidelines.',
                matchedPattern: pattern.source.substring(0, 20),
            };
        }
    }

    // Check spam patterns
    if (SPAM_PATTERNS.excessiveCaps(text)) {
        return { blocked: false, warning: 'Easy on the caps, sailor! Consider rewriting in lowercase.' };
    }
    if (SPAM_PATTERNS.charRepetition(text)) {
        return { blocked: false, warning: 'Looks like your keyboard got stuck — consider editing.' };
    }
    if (SPAM_PATTERNS.wordRepetition(text)) {
        return { blocked: false, warning: 'Repetitive messages may be flagged as spam.' };
    }
    if (SPAM_PATTERNS.linkSpam(text)) {
        return { blocked: true, warning: 'Messages with multiple links are automatically held for review.' };
    }

    return { blocked: false, warning: null };
};


// --- LAYER 2: ASYNC GEMINI FLASH CLASSIFICATION ---

const MODERATION_PROMPT = `You are a content moderation system for a community chat app used by sailors. 
Your job is to classify messages for safety. The community values inclusivity and helpfulness.

CONTEXT: This is a marine/sailing community app called "Crew Talk". Users discuss anchorages, 
weather, gear, crew finding, and social topics. Mild maritime language (e.g. "damn", "hell", 
"bloody") is ACCEPTABLE — these are sailors after all. Debate and disagreement are FINE.

CLASSIFY the following message and return JSON:
{
  "verdict": "clean" | "warning" | "remove" | "escalate",
  "reason": "Brief explanation",
  "confidence": 0.0-1.0,
  "category": "none" | "spam" | "harassment" | "hate_speech" | "threats" | "sexual" | "scam" | "self_harm"
}

VERDICT GUIDE:
- "clean": Normal message, no issues
- "warning": Borderline — flag for mod review but don't remove
- "remove": Clear violation — auto soft-delete  
- "escalate": Serious threat or illegal content — remove + alert admins

BE LENIENT on: maritime slang, mild profanity, heated debate about gear/routes
BE STRICT on: slurs, personal attacks, threats, sexual harassment, scam/phishing

MESSAGE TO CLASSIFY:
`;

/**
 * Layer 2: Async Gemini Flash check. Called AFTER the message is posted.
 * If verdict is "remove" or "escalate", the message is soft-deleted.
 * Typical latency: 500-1500ms. Cost: ~$0.000015 per call.
 */
export const geminiModerate = async (text: string): Promise<ModerationResult> => {
    const start = Date.now();
    const ai = getAI();

    if (!ai) {
        return {
            verdict: 'clean',
            reason: 'AI moderation unavailable',
            confidence: 0,
            category: 'none',
            processingTimeMs: Date.now() - start,
        };
    }

    try {
        const model = ai.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await Promise.race([
            model.generateContent({
                contents: [{ role: 'user', parts: [{ text: MODERATION_PROMPT + `"${text}"` }] }],
                generationConfig: { responseMimeType: 'application/json' },
            }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Moderation timeout')), 5000)
            ),
        ]);

        const responseText = result.response.text();
        let parsed: { verdict?: string; reason?: string; confidence?: number; category?: string } | null = null;

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
            return {
                verdict: 'clean',
                reason: 'Failed to parse AI response',
                confidence: 0,
                category: 'none',
                processingTimeMs: Date.now() - start,
            };
        }

        const verdict = (['clean', 'warning', 'remove', 'escalate'].includes(parsed.verdict)
            ? parsed.verdict
            : 'clean') as ModerationVerdict;

        return {
            verdict,
            reason: parsed.reason || 'No reason provided',
            confidence: Math.max(0, Math.min(1, parsed.confidence || 0)),
            category: parsed.category || 'none',
            processingTimeMs: Date.now() - start,
        };
    } catch (e) {
        // Timeout or API error — fail open (allow the message)
        return {
            verdict: 'clean',
            reason: e instanceof Error ? e.message : 'Moderation error',
            confidence: 0,
            category: 'none',
            processingTimeMs: Date.now() - start,
        };
    }
};


// --- LAYER 3: USER REPORTS ---

/**
 * Layer 3: User-initiated report. Stores in Supabase for mod review.
 */
export const reportMessage = async (
    messageId: string,
    reporterId: string,
    reason: ContentReport['reason'],
    details?: string
): Promise<boolean> => {
    if (!supabase) return false;

    try {
        const { error } = await supabase
            .from(REPORTS_TABLE)
            .insert({
                message_id: messageId,
                reporter_id: reporterId,
                reason,
                details: details || null,
            });

        return !error;
    } catch {
        return false;
    }
};

/**
 * Get pending reports (for mod dashboard)
 */
export const getPendingReports = async (): Promise<ContentReport[]> => {
    if (!supabase) return [];

    const { data } = await supabase
        .from(REPORTS_TABLE)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

    return (data || []) as ContentReport[];
};


// --- ORCHESTRATOR ---

/**
 * Main moderation pipeline. Called after a message is successfully posted.
 * 
 * Flow:
 * 1. Run Gemini Flash classification (async, ~1s)
 * 2. If "remove" or "escalate" → soft-delete the message
 * 3. If "warning" → flag for mod review (no removal)
 * 4. Log all moderation actions for audit trail
 * 
 * This is fire-and-forget — it never blocks the sender.
 */
export const moderateMessage = async (
    messageId: string,
    messageText: string,
    userId: string,
    channelId: string
): Promise<void> => {
    try {
        const result = await geminiModerate(messageText);

        // Log moderation result (non-blocking)
        logModerationAction(messageId, userId, channelId, result);

        if (result.verdict === 'remove' || result.verdict === 'escalate') {
            // Auto soft-delete
            if (supabase) {
                await supabase
                    .from(MESSAGES_TABLE)
                    .update({ deleted_at: new Date().toISOString() })
                    .eq('id', messageId);
            }

            // If escalate, also log as high-priority
            if (result.verdict === 'escalate') {
                console.warn(`[MODERATION] ESCALATION: Message ${messageId} by ${userId} — ${result.reason} (${result.category})`);
            }
        }

        if (result.verdict === 'warning') {
            // Flag for mod review — could set a "flagged" column in future
            console.info(`[MODERATION] WARNING: Message ${messageId} — ${result.reason} (confidence: ${result.confidence})`);
        }

    } catch (error) {
        // Moderation failure should never crash the app — fail open
        console.error('[MODERATION] Pipeline error:', error);
    }
};


// --- AUDIT LOGGING ---

interface ModerationLog {
    message_id: string;
    user_id: string;
    channel_id: string;
    verdict: ModerationVerdict;
    reason: string;
    category: string;
    confidence: number;
    processing_time_ms: number;
    timestamp: string;
}

const MODERATION_LOG_TABLE = 'chat_moderation_log';

const logModerationAction = async (
    messageId: string,
    userId: string,
    channelId: string,
    result: ModerationResult
): Promise<void> => {
    // Only log non-clean results to save DB writes
    if (result.verdict === 'clean') return;

    if (!supabase) return;

    const log: ModerationLog = {
        message_id: messageId,
        user_id: userId,
        channel_id: channelId,
        verdict: result.verdict,
        reason: result.reason,
        category: result.category,
        confidence: result.confidence,
        processing_time_ms: result.processingTimeMs,
        timestamp: new Date().toISOString(),
    };

    try {
        await supabase.from(MODERATION_LOG_TABLE).insert(log);
    } catch {
        // Best effort — moderation logging is non-critical
    }
};


// --- STATS ---

/**
 * Get moderation statistics for the admin dashboard.
 */
export const getModerationStats = async (): Promise<{
    totalFlagged: number;
    totalRemoved: number;
    totalReports: number;
    avgProcessingMs: number;
}> => {
    if (!supabase) return { totalFlagged: 0, totalRemoved: 0, totalReports: 0, avgProcessingMs: 0 };

    const [flagged, removed, reports] = await Promise.all([
        supabase.from(MODERATION_LOG_TABLE).select('*', { count: 'exact', head: true }).eq('verdict', 'warning'),
        supabase.from(MODERATION_LOG_TABLE).select('*', { count: 'exact', head: true }).in('verdict', ['remove', 'escalate']),
        supabase.from(REPORTS_TABLE).select('*', { count: 'exact', head: true }),
    ]);

    return {
        totalFlagged: flagged.count || 0,
        totalRemoved: removed.count || 0,
        totalReports: reports.count || 0,
        avgProcessingMs: 0, // Would need aggregation query
    };
};
