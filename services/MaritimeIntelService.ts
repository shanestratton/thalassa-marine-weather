/**
 * MaritimeIntelService — Fetches maritime news from RSS feeds
 *
 * Uses the maritime-intel Edge Function to proxy RSS feeds from
 * gCaptain and The Maritime Executive. Cached in localStorage for 30 min.
 */
import { supabaseUrl, supabaseAnonKey } from './supabase';
import { createLogger } from '../utils/createLogger';

const log = createLogger('MaritimeIntel');

export interface MaritimeArticle {
    title: string;
    snippet: string;
    url: string;
    source: string;
    icon: string;
    image: string | null;
    publishedAt: string;
}

const CACHE_KEY = 'maritime_intel_cache';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CachedData {
    articles: MaritimeArticle[];
    fetchedAt: number;
}

class MaritimeIntelServiceClass {
    private articles: MaritimeArticle[] = [];
    private loading = false;
    private listeners: Set<(articles: MaritimeArticle[]) => void> = new Set();

    /**
     * Get cached articles (sync) or fetch fresh ones (async).
     * Returns immediately with cached data if available.
     */
    getArticles(): MaritimeArticle[] {
        if (this.articles.length > 0) return this.articles;

        // Check localStorage cache
        try {
            const cached = localStorage.getItem(CACHE_KEY);
            if (cached) {
                const data: CachedData = JSON.parse(cached);
                if (Date.now() - data.fetchedAt < CACHE_TTL_MS) {
                    this.articles = data.articles;
                    return this.articles;
                }
            }
        } catch {
            // Ignore parse errors
        }

        // No cache — trigger background fetch
        this.fetchArticles();
        return [];
    }

    /**
     * Fetch fresh articles from the Edge Function.
     */
    async fetchArticles(): Promise<MaritimeArticle[]> {
        if (this.loading) return this.articles;
        if (!supabaseUrl || !supabaseAnonKey) return [];

        this.loading = true;
        try {
            const resp = await fetch(`${supabaseUrl}/functions/v1/maritime-intel`, {
                headers: {
                    Authorization: `Bearer ${supabaseAnonKey}`,
                    apikey: supabaseAnonKey,
                },
                signal: AbortSignal.timeout(12000),
            });

            if (!resp.ok) {
                log.warn(`Fetch failed: HTTP ${resp.status}`);
                return this.articles;
            }

            const data = await resp.json();
            this.articles = data.articles || [];

            // Cache to localStorage
            try {
                localStorage.setItem(
                    CACHE_KEY,
                    JSON.stringify({
                        articles: this.articles,
                        fetchedAt: Date.now(),
                    } as CachedData),
                );
            } catch {
                // Storage full — ignore
            }

            // Notify listeners
            this.listeners.forEach((fn) => fn(this.articles));

            log.info(`Fetched ${this.articles.length} articles`);
            return this.articles;
        } catch (e) {
            log.warn('Fetch error:', e);
            return this.articles;
        } finally {
            this.loading = false;
        }
    }

    /**
     * Subscribe to article updates.
     */
    subscribe(fn: (articles: MaritimeArticle[]) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /**
     * Force refresh.
     */
    async refresh(): Promise<MaritimeArticle[]> {
        localStorage.removeItem(CACHE_KEY);
        this.articles = [];
        return this.fetchArticles();
    }
}

export const MaritimeIntelService = new MaritimeIntelServiceClass();
