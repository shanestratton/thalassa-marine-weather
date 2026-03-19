/**
 * MaritimeIntelCard — Maritime News Carousel
 *
 * Premium glassmorphism card with swipe gestures:
 *   - Swipe left: Next headline
 *   - Swipe right: Reveal deep dive (snippet + Read More)
 *   - Swipe up: Dismiss for session
 *   - Auto-rotates every 8s
 *   - Pagination dots
 *
 * Placed below Guardian alerts, above channel list in ChatPage.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MaritimeIntelService, type MaritimeArticle } from '../../services/MaritimeIntelService';
import { triggerHaptic } from '../../utils/system';

const DISMISS_KEY = 'maritime_intel_dismissed';
const AUTO_ROTATE_MS = 8000;

export const MaritimeIntelCard: React.FC = React.memo(() => {
    const [articles, setArticles] = useState<MaritimeArticle[]>([]);
    const [activeIndex, setActiveIndex] = useState(0);
    const [isDismissed, setIsDismissed] = useState(false);
    const [showDeepDive, setShowDeepDive] = useState(false);
    const [dismissProgress, setDismissProgress] = useState(0); // 0-1 for swipe-up

    // Touch tracking
    const touchStart = useRef<{ x: number; y: number; time: number } | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const autoRotateRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Check session dismiss
    useEffect(() => {
        if (sessionStorage.getItem(DISMISS_KEY)) {
            setIsDismissed(true);
        }
    }, []);

    // Fetch articles
    useEffect(() => {
        const cached = MaritimeIntelService.getArticles();
        if (cached.length > 0) {
            setArticles(cached);
        }

        // Subscribe for updates
        const unsub = MaritimeIntelService.subscribe((fresh) => {
            setArticles(fresh);
        });

        // Trigger fetch if not cached
        if (cached.length === 0) {
            MaritimeIntelService.fetchArticles();
        }

        return unsub;
    }, []);

    // Auto-rotate
    useEffect(() => {
        if (showDeepDive || articles.length <= 1) return;

        autoRotateRef.current = setInterval(() => {
            setActiveIndex((i) => (i + 1) % articles.length);
        }, AUTO_ROTATE_MS);

        return () => {
            if (autoRotateRef.current) clearInterval(autoRotateRef.current);
        };
    }, [articles.length, showDeepDive]);

    const resetAutoRotate = useCallback(() => {
        if (autoRotateRef.current) clearInterval(autoRotateRef.current);
        autoRotateRef.current = setInterval(() => {
            setActiveIndex((i) => (i + 1) % Math.max(articles.length, 1));
        }, AUTO_ROTATE_MS);
    }, [articles.length]);

    // Touch handlers
    const handleTouchStart = useCallback((e: React.TouchEvent) => {
        touchStart.current = {
            x: e.touches[0].clientX,
            y: e.touches[0].clientY,
            time: Date.now(),
        };
        setDismissProgress(0);
    }, []);

    const handleTouchMove = useCallback((e: React.TouchEvent) => {
        if (!touchStart.current) return;
        const dy = touchStart.current.y - e.touches[0].clientY;
        // Track upward swipe for dismiss
        if (dy > 10) {
            const progress = Math.min(dy / 100, 1);
            setDismissProgress(progress);
        }
    }, []);

    const handleTouchEnd = useCallback(
        (e: React.TouchEvent) => {
            if (!touchStart.current) return;

            const dx = e.changedTouches[0].clientX - touchStart.current.x;
            const dy = touchStart.current.y - e.changedTouches[0].clientY;
            const elapsed = Date.now() - touchStart.current.time;
            const isQuick = elapsed < 300;

            touchStart.current = null;
            setDismissProgress(0);

            // Swipe up = dismiss (>60px upward)
            if (dy > 60) {
                triggerHaptic('light');
                setIsDismissed(true);
                sessionStorage.setItem(DISMISS_KEY, '1');
                return;
            }

            // Horizontal swipes need minimum 40px
            if (Math.abs(dx) < 40) return;

            if (dx < -40) {
                // Swipe LEFT = next headline
                if (showDeepDive) {
                    setShowDeepDive(false);
                } else {
                    triggerHaptic('light');
                    setActiveIndex((i) => (i + 1) % articles.length);
                    resetAutoRotate();
                }
            } else if (dx > 40 && (isQuick || dx > 60)) {
                // Swipe RIGHT = deep dive or previous
                if (showDeepDive) {
                    setShowDeepDive(false);
                    triggerHaptic('light');
                } else {
                    triggerHaptic('medium');
                    setShowDeepDive(true);
                    // Pause auto-rotate during deep dive
                    if (autoRotateRef.current) clearInterval(autoRotateRef.current);
                }
            }
        },
        [articles.length, showDeepDive, resetAutoRotate],
    );

    const [isReading, setIsReading] = useState(false);

    const openArticle = useCallback(async (url: string, source?: string) => {
        triggerHaptic('medium');
        setIsReading(true);

        try {
            const { Browser } = await import('@capacitor/browser');

            // Listen for browser close — user tapped "Done" in SFSafariViewController
            const finishListener = await Browser.addListener('browserFinished', () => {
                setIsReading(false);
                setShowDeepDive(false); // Return to headline carousel
                finishListener.remove();
                triggerHaptic('light');
            });

            // Open in SFSafariViewController (iOS) / Chrome Custom Tabs (Android)
            // This is IN-APP — it's a modal sheet within Thalassa, not Safari
            await Browser.open({
                url,
                presentationStyle: 'fullscreen', // Full modal overlay
                toolbarColor: '#0f172a', // Thalassa dark slate
                windowName: '_blank',
            });
        } catch {
            // Web fallback — opens in new tab
            setIsReading(false);
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    }, []);

    const timeAgo = (dateStr: string): string => {
        const diff = Date.now() - new Date(dateStr).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'now';
        if (mins < 60) return `${mins}m`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h`;
        const days = Math.floor(hrs / 24);
        return `${days}d`;
    };

    // Don't render if dismissed or no articles
    if (isDismissed || articles.length === 0) return null;

    const article = articles[activeIndex];
    if (!article) return null;

    return (
        <div
            ref={containerRef}
            className="mx-4 mt-3 fade-slide-down"
            style={{
                opacity: 1 - dismissProgress * 0.6,
                transform: `translateY(${-dismissProgress * 30}px) scale(${1 - dismissProgress * 0.05})`,
                transition: dismissProgress > 0 ? 'none' : 'all 0.3s ease-out',
                touchAction: 'pan-y',
            }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
        >
            <div
                className="relative overflow-hidden rounded-2xl border"
                style={{
                    background:
                        'linear-gradient(135deg, rgba(14,165,233,0.06), rgba(139,92,246,0.04), rgba(6,182,212,0.05))',
                    borderColor: 'rgba(14,165,233,0.12)',
                    backdropFilter: 'blur(12px)',
                    WebkitBackdropFilter: 'blur(12px)',
                }}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-4 pt-3 pb-1">
                    <div className="flex items-center gap-2">
                        <div className="w-1 h-4 rounded-full bg-sky-500" />
                        <span className="text-[10px] font-black text-sky-400 uppercase tracking-[0.2em]">
                            Maritime Intel
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-[9px] text-gray-500">{article.source}</span>
                        <button
                            onClick={() => {
                                triggerHaptic('light');
                                setIsDismissed(true);
                                sessionStorage.setItem(DISMISS_KEY, '1');
                            }}
                            className="w-6 h-6 flex items-center justify-center rounded-lg bg-white/[0.04] text-gray-500 text-[10px] hover:bg-white/[0.08] transition-colors"
                            aria-label="Dismiss maritime intel"
                        >
                            ✕
                        </button>
                    </div>
                </div>

                {/* Content area with transition */}
                <div className="relative px-4 pb-3 min-h-[72px]">
                    {!showDeepDive ? (
                        /* ═══ HEADLINE MODE ═══ */
                        <div
                            key={`headline-${activeIndex}`}
                            className="animate-in fade-in slide-in-from-right-2 duration-300"
                        >
                            <div className="flex gap-3 items-start">
                                {article.image && (
                                    <div className="w-16 h-16 rounded-xl overflow-hidden shrink-0 border border-white/[0.06]">
                                        <img
                                            src={article.image}
                                            alt=""
                                            className="w-full h-full object-cover"
                                            loading="lazy"
                                        />
                                    </div>
                                )}
                                <div className="flex-1 min-w-0">
                                    <h3 className="text-[13px] font-bold text-white leading-tight line-clamp-2 mb-1">
                                        {article.title}
                                    </h3>
                                    <div className="flex items-center gap-2 text-[10px] text-gray-500">
                                        <span>
                                            {article.icon} {article.source}
                                        </span>
                                        <span>•</span>
                                        <span>{timeAgo(article.publishedAt)}</span>
                                    </div>
                                </div>
                            </div>

                            {/* Swipe hint */}
                            <div className="flex items-center justify-center gap-3 mt-2 text-[9px] text-gray-600">
                                <span>← swipe for details</span>
                                <span>•</span>
                                <span>swipe →</span>
                            </div>
                        </div>
                    ) : (
                        /* ═══ DEEP DIVE MODE ═══ */
                        <div
                            key={`dive-${activeIndex}`}
                            className="animate-in fade-in slide-in-from-left-2 duration-300"
                        >
                            <h3 className="text-[13px] font-bold text-white leading-tight mb-2">{article.title}</h3>
                            <p className="text-[11px] text-gray-300 leading-relaxed mb-3 line-clamp-4">
                                {article.snippet}
                            </p>
                            <button
                                onClick={() => openArticle(article.url, article.source)}
                                disabled={isReading}
                                className="w-full py-2.5 rounded-xl text-[11px] font-bold text-sky-400 uppercase tracking-wider transition-all active:scale-[0.98] disabled:opacity-50"
                                style={{
                                    background: 'linear-gradient(135deg, rgba(14,165,233,0.1), rgba(139,92,246,0.08))',
                                    border: '1px solid rgba(14,165,233,0.2)',
                                }}
                            >
                                {isReading ? (
                                    <span className="flex items-center justify-center gap-2">
                                        <span className="w-3 h-3 border-2 border-sky-400/30 border-t-sky-400 rounded-full animate-spin" />
                                        Opening…
                                    </span>
                                ) : (
                                    `Read Full Article › ${article.source}`
                                )}
                            </button>
                            <div className="flex items-center justify-center gap-3 mt-1.5">
                                <span className="text-[9px] text-gray-600">← swipe to close</span>
                                <span className="text-[9px] text-gray-600">•</span>
                                <span className="text-[9px] text-gray-600">Opens in-app reader</span>
                            </div>
                        </div>
                    )}
                </div>

                {/* Pagination dots */}
                {articles.length > 1 && !showDeepDive && (
                    <div className="flex items-center justify-center gap-1.5 pb-3">
                        {articles.slice(0, 8).map((_, i) => (
                            <button
                                key={i}
                                onClick={() => {
                                    setActiveIndex(i);
                                    resetAutoRotate();
                                }}
                                className="transition-all duration-300"
                                style={{
                                    width: i === activeIndex ? 16 : 5,
                                    height: 5,
                                    borderRadius: 3,
                                    background: i === activeIndex ? 'rgba(56,189,248,0.8)' : 'rgba(255,255,255,0.1)',
                                }}
                                aria-label={`Go to article ${i + 1}`}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
});

MaritimeIntelCard.displayName = 'MaritimeIntelCard';
