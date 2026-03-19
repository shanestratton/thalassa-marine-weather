/**
 * MaritimeIntelCard — One-line scrolling news ticker.
 *
 * Displays maritime headlines in a horizontal marquee strip:
 *   HEADLINE: short snippet  |  HEADLINE: short snippet  |  …
 *
 * No interaction — purely informational ambient strip.
 * Placed below Guardian alerts, above channel list in ChatPage.
 */
import React, { useState, useEffect, useRef } from 'react';
import { MaritimeIntelService, type MaritimeArticle } from '../../services/MaritimeIntelService';

export const MaritimeIntelCard: React.FC = React.memo(() => {
    const [articles, setArticles] = useState<MaritimeArticle[]>([]);
    const tickerRef = useRef<HTMLDivElement>(null);

    // Fetch articles
    useEffect(() => {
        const cached = MaritimeIntelService.getArticles();
        if (cached.length > 0) setArticles(cached);

        const unsub = MaritimeIntelService.subscribe((fresh) => setArticles(fresh));

        if (cached.length === 0) MaritimeIntelService.fetchArticles();

        return unsub;
    }, []);

    if (articles.length === 0) return null;

    // Build ticker string: "HEADLINE: snippet  |  HEADLINE: snippet  |  …"
    const tickerItems = articles.map((a) => {
        const snippet = a.snippet ? (a.snippet.length > 80 ? a.snippet.slice(0, 80).trim() + '…' : a.snippet) : '';
        return snippet ? `${a.title}: ${snippet}` : a.title;
    });

    // Duplicate for seamless loop
    const tickerText = tickerItems.join('  │  ');
    const fullTicker = `${tickerText}  │  ${tickerText}`;

    // Estimate animation duration: ~60px/sec reading speed
    const charWidth = 7.5; // approx px per char at 11px font
    const totalWidth = fullTicker.length * charWidth;
    const duration = Math.max(30, totalWidth / 60); // at least 30s

    return (
        <div className="mx-4 mt-2 mb-1">
            <div
                className="relative overflow-hidden rounded-xl"
                style={{
                    background: 'linear-gradient(90deg, rgba(14,165,233,0.06), rgba(6,182,212,0.04))',
                    border: '1px solid rgba(14,165,233,0.1)',
                }}
            >
                <div className="flex items-center h-8 px-3 gap-2">
                    {/* Label */}
                    <span
                        className="shrink-0 text-[9px] font-black text-sky-500/70 uppercase tracking-[0.15em]"
                        style={{ letterSpacing: '0.15em' }}
                    >
                        INTEL
                    </span>
                    <div className="w-px h-3.5 bg-sky-500/15 shrink-0" />

                    {/* Ticker scroll area */}
                    <div className="flex-1 overflow-hidden relative">
                        {/* Fade edges */}
                        <div
                            className="absolute left-0 top-0 bottom-0 w-6 z-10 pointer-events-none"
                            style={{
                                background: 'linear-gradient(to right, rgba(15,23,42,0.9), transparent)',
                            }}
                        />
                        <div
                            className="absolute right-0 top-0 bottom-0 w-6 z-10 pointer-events-none"
                            style={{
                                background: 'linear-gradient(to left, rgba(15,23,42,0.9), transparent)',
                            }}
                        />

                        <div
                            ref={tickerRef}
                            className="whitespace-nowrap inline-block"
                            style={{
                                animation: `ticker-scroll ${duration}s linear infinite`,
                                willChange: 'transform',
                            }}
                        >
                            <span className="text-[11px] text-gray-400 font-medium">
                                {tickerItems.map((item, i) => (
                                    <React.Fragment key={i}>
                                        {i > 0 && <span className="text-sky-500/30 mx-3">│</span>}
                                        <span className="text-gray-300 font-bold">{item.split(':')[0]}</span>
                                        {item.includes(':') && (
                                            <span className="text-gray-500">:{item.split(':').slice(1).join(':')}</span>
                                        )}
                                    </React.Fragment>
                                ))}
                                <span className="text-sky-500/30 mx-3">│</span>
                                {/* Duplicate for seamless loop */}
                                {tickerItems.map((item, i) => (
                                    <React.Fragment key={`dup-${i}`}>
                                        {i > 0 && <span className="text-sky-500/30 mx-3">│</span>}
                                        <span className="text-gray-300 font-bold">{item.split(':')[0]}</span>
                                        {item.includes(':') && (
                                            <span className="text-gray-500">:{item.split(':').slice(1).join(':')}</span>
                                        )}
                                    </React.Fragment>
                                ))}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
});

MaritimeIntelCard.displayName = 'MaritimeIntelCard';
