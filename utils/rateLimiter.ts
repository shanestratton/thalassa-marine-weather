/**
 * RateLimiter — Client-side token-bucket rate limiter
 * ────────────────────────────────────────────────────
 * Prevents excessive API calls from a single client session.
 *
 * Usage:
 *   import { rateLimiter } from '../utils/rateLimiter';
 *
 *   if (!rateLimiter.acquire('stormglass')) {
 *       console.warn('Rate limit exceeded for Stormglass');
 *       return null;
 *   }
 *   const result = await fetch('https://api.stormglass.io/...');
 *
 * Limits are persisted in localStorage so they survive page refresh.
 * Each bucket refills at a configurable rate.
 */

import { createLogger } from './createLogger';

const log = createLogger('RateLimiter');

interface BucketConfig {
    /** Maximum tokens in the bucket */
    maxTokens: number;
    /** Tokens added per refill interval */
    refillAmount: number;
    /** Refill interval in milliseconds */
    refillIntervalMs: number;
}

interface BucketState {
    tokens: number;
    lastRefill: number;
}

const STORAGE_KEY = 'thalassa_rate_limits';

/**
 * Default rate limits per API.
 * Conservative defaults — external APIs have strict daily quotas.
 */
const DEFAULT_CONFIGS: Record<string, BucketConfig> = {
    stormglass: {
        maxTokens: 10, // 10 requests max
        refillAmount: 10, // Full refill
        refillIntervalMs: 24 * 60 * 60 * 1000, // Every 24 hours (free tier: 10/day)
    },
    'open-meteo': {
        maxTokens: 60, // 60 requests max
        refillAmount: 60, // Full refill
        refillIntervalMs: 60 * 60 * 1000, // Every hour
    },
    'open-meteo-commercial': {
        maxTokens: 600, // Commercial tier: 600/min
        refillAmount: 600,
        refillIntervalMs: 60 * 1000, // Every minute
    },
    mapbox: {
        maxTokens: 100, // 100 requests max
        refillAmount: 100, // Full refill
        refillIntervalMs: 60 * 1000, // Every minute
    },
    gemini: {
        maxTokens: 15, // 15 requests max
        refillAmount: 15, // Full refill
        refillIntervalMs: 60 * 1000, // Every minute (free tier: 15 RPM)
    },
    worldtides: {
        maxTokens: 50, // 50 requests max
        refillAmount: 50,
        refillIntervalMs: 24 * 60 * 60 * 1000, // Every 24 hours
    },
    default: {
        maxTokens: 30,
        refillAmount: 30,
        refillIntervalMs: 60 * 1000, // 30 per minute
    },
};

class RateLimiterService {
    private buckets: Map<string, BucketState> = new Map();
    private configs: Map<string, BucketConfig> = new Map();

    constructor() {
        // Load default configs
        for (const [key, config] of Object.entries(DEFAULT_CONFIGS)) {
            this.configs.set(key, config);
        }
        // Restore state from localStorage
        this.loadState();
    }

    /**
     * Try to acquire a token for the given API.
     * Returns true if the request is allowed, false if rate limited.
     */
    acquire(api: string): boolean {
        this.refill(api);

        const state = this.getOrCreateBucket(api);

        if (state.tokens <= 0) {
            log.warn(`Rate limit exceeded for "${api}" — request blocked`);
            return false;
        }

        state.tokens--;
        this.saveState();
        return true;
    }

    /**
     * Check remaining tokens without consuming one.
     */
    remaining(api: string): number {
        this.refill(api);
        return this.getOrCreateBucket(api).tokens;
    }

    /**
     * Register a custom rate limit config for an API.
     */
    configure(api: string, config: BucketConfig): void {
        this.configs.set(api, config);
    }

    /**
     * Reset all rate limits (useful for testing).
     */
    reset(): void {
        this.buckets.clear();
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch {
            // localStorage unavailable
        }
    }

    /**
     * Get stats for all active buckets.
     */
    getStats(): Record<string, { remaining: number; max: number; nextRefill: number }> {
        const stats: Record<string, { remaining: number; max: number; nextRefill: number }> = {};
        for (const [api] of this.buckets) {
            this.refill(api);
            const state = this.getOrCreateBucket(api);
            const config = this.getConfig(api);
            stats[api] = {
                remaining: state.tokens,
                max: config.maxTokens,
                nextRefill: state.lastRefill + config.refillIntervalMs - Date.now(),
            };
        }
        return stats;
    }

    // ── Private ──────────────────────────────────

    private getConfig(api: string): BucketConfig {
        return this.configs.get(api) || this.configs.get('default')!;
    }

    private getOrCreateBucket(api: string): BucketState {
        let state = this.buckets.get(api);
        if (!state) {
            const config = this.getConfig(api);
            state = { tokens: config.maxTokens, lastRefill: Date.now() };
            this.buckets.set(api, state);
        }
        return state;
    }

    private refill(api: string): void {
        const state = this.getOrCreateBucket(api);
        const config = this.getConfig(api);
        const now = Date.now();
        const elapsed = now - state.lastRefill;

        if (elapsed >= config.refillIntervalMs) {
            const intervals = Math.floor(elapsed / config.refillIntervalMs);
            state.tokens = Math.min(config.maxTokens, state.tokens + intervals * config.refillAmount);
            state.lastRefill = now;
        }
    }

    private loadState(): void {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const data: Record<string, BucketState> = JSON.parse(raw);
            for (const [api, state] of Object.entries(data)) {
                this.buckets.set(api, state);
            }
        } catch {
            // Corrupted data — start fresh
        }
    }

    private saveState(): void {
        try {
            const data: Record<string, BucketState> = {};
            for (const [api, state] of this.buckets) {
                data[api] = state;
            }
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch {
            // localStorage unavailable
        }
    }
}

/** Singleton rate limiter instance */
export const rateLimiter = new RateLimiterService();
