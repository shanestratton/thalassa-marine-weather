/**
 * VesselSearch — Search for vessels by name or MMSI, fly map to location.
 *
 * Queries both:
 *   1. `vessels` table (live AIS positions) — for MMSI + name match
 *   2. `vessel_metadata` table (enriched data) — for enriched vessel names
 *
 * Debounced input, max 10 results, tap to fly-to.
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { supabase } from '../../services/supabase';
import { getMmsiFlag } from '../../utils/MmsiDecoder';
import { triggerHaptic } from '../../utils/system';

import { createLogger } from '../../utils/createLogger';

const log = createLogger('VesselSearch');

interface VesselSearchResult {
    mmsi: number;
    name: string | null;
    flag: string;
    lat: number;
    lon: number;
    sog: number;
    shipType: number;
    source: 'live' | 'metadata';
}

interface VesselSearchProps {
    onSelect: (lat: number, lon: number, mmsi: number, name: string) => void;
    visible: boolean;
    onClose: () => void;
}

export const VesselSearch: React.FC<VesselSearchProps> = ({ onSelect, visible, onClose }) => {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<VesselSearchResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [searched, setSearched] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Auto-focus on open
    useEffect(() => {
        if (visible) {
            setTimeout(() => inputRef.current?.focus(), 200);
            setQuery('');
            setResults([]);
            setSearched(false);
        }
    }, [visible]);

    const searchVessels = useCallback(async (q: string) => {
        if (q.length < 2) {
            setResults([]);
            setSearched(false);
            return;
        }

        setLoading(true);
        setSearched(true);

        if (!supabase) {
            setResults([]);
            setLoading(false);
            return;
        }

        try {
            // Try RPC function first (uses PostGIS ST_X/ST_Y for lat/lon)
            const { data, error } = await supabase.rpc('search_vessels', {
                search_query: q.trim(),
                max_results: 10,
            });

            let rows = data;

            if (error) {
                log.warn('[VesselSearch] RPC not available, falling back to direct query:', error.message);
                // Fallback: direct query on vessels table (no PostGIS dependency)
                const isMMSI = /^\d{5,9}$/.test(q.trim());
                let query = supabase.from('vessels').select('mmsi, name, call_sign, ship_type, sog, lat, lon');

                if (isMMSI) {
                    query = query.eq('mmsi', parseInt(q.trim()));
                } else {
                    query = query.ilike('name', `%${q.trim()}%`);
                }

                const { data: fallbackData, error: fallbackError } = await query.limit(10);
                if (fallbackError) {
                    log.warn('[VesselSearch] Fallback query error:', fallbackError.message);
                    setResults([]);
                    return;
                }
                rows = fallbackData;
            }

            const merged: VesselSearchResult[] = (rows || [])
                .filter((v: { lat: number; lon: number }) => v.lat !== 0 || v.lon !== 0)
                .map(
                    (v: {
                        mmsi: number;
                        name: string | null;
                        call_sign: string | null;
                        ship_type: number;
                        sog: number;
                        lat: number;
                        lon: number;
                    }) => ({
                        mmsi: v.mmsi,
                        name: v.name || null,
                        flag: getMmsiFlag(v.mmsi),
                        lat: v.lat,
                        lon: v.lon,
                        sog: v.sog ?? 0,
                        shipType: v.ship_type ?? 0,
                        source: 'live' as const,
                    }),
                );

            setResults(merged);
        } catch (err) {
            log.warn('[VesselSearch] Error:', err);
            setResults([]);
        } finally {
            setLoading(false);
        }
    }, []);

    const handleInput = (val: string) => {
        setQuery(val);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => searchVessels(val), 400);
    };

    const handleSelect = (result: VesselSearchResult) => {
        triggerHaptic('medium');
        const displayName = result.name || `MMSI ${result.mmsi}`;
        onSelect(result.lat, result.lon, result.mmsi, displayName);
        onClose();
    };

    if (!visible) return null;

    return (
        <div
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 800,
                background: 'rgba(0,0,0,0.5)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                animation: 'fadeIn 0.2s ease-out',
                display: 'flex',
                flexDirection: 'column',
                padding: '56px 12px 20px',
            }}
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            {/* Search bar */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: 'rgba(15,23,42,0.95)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 14,
                    padding: '6px 12px',
                    marginBottom: 8,
                }}
            >
                <span style={{ fontSize: 18, flexShrink: 0 }}>🔍</span>
                <input
                    ref={inputRef}
                    type="text"
                    placeholder="Search vessel name or MMSI..."
                    value={query}
                    onChange={(e) => handleInput(e.target.value)}
                    style={{
                        flex: 1,
                        background: 'transparent',
                        border: 'none',
                        outline: 'none',
                        color: '#e2e8f0',
                        fontSize: 15,
                        fontWeight: 600,
                        fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
                    }}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="search"
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') onClose();
                        if (e.key === 'Enter') searchVessels(query);
                    }}
                />
                <button
                    onClick={onClose}
                    style={{
                        width: 32,
                        height: 32,
                        borderRadius: 10,
                        background: 'rgba(255,255,255,0.06)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        color: '#94a3b8',
                        fontSize: 14,
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                    }}
                    aria-label="Close search"
                >
                    ✕
                </button>
            </div>

            {/* Results */}
            <div
                style={{
                    flex: 1,
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                }}
            >
                {loading && (
                    <div style={{ textAlign: 'center', padding: 32, color: '#64748b', fontSize: 13 }}>
                        <div
                            style={{
                                width: 16,
                                height: 16,
                                border: '2px solid #38bdf8',
                                borderTopColor: 'transparent',
                                borderRadius: '50%',
                                animation: 'spin 0.8s linear infinite',
                                margin: '0 auto 8px',
                            }}
                        />
                        Searching...
                    </div>
                )}

                {!loading && searched && results.length === 0 && (
                    <div style={{ textAlign: 'center', padding: 32, color: '#64748b', fontSize: 13 }}>
                        No vessels found for <span style={{ color: '#e2e8f0', fontWeight: 700 }}>"{query}"</span>
                    </div>
                )}

                {!loading &&
                    results.map((r) => (
                        <button
                            aria-label="Select"
                            key={r.mmsi}
                            onClick={() => handleSelect(r)}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 10,
                                padding: '10px 12px',
                                background: 'rgba(15,23,42,0.9)',
                                border: '1px solid rgba(255,255,255,0.08)',
                                borderRadius: 12,
                                cursor: 'pointer',
                                textAlign: 'left',
                                color: '#e2e8f0',
                                transition: 'background 0.15s',
                                fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
                            }}
                        >
                            <span style={{ fontSize: 24, flexShrink: 0 }}>{r.flag}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                    style={{
                                        fontWeight: 800,
                                        fontSize: 13,
                                        letterSpacing: 0.3,
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    {r.name || `MMSI ${r.mmsi}`}
                                </div>
                                <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>
                                    MMSI {r.mmsi} • {r.sog > 0 ? `${r.sog.toFixed(1)} kn` : 'Stationary'}
                                </div>
                            </div>
                            <span
                                style={{
                                    fontSize: 10,
                                    color: '#64748b',
                                    flexShrink: 0,
                                    padding: '2px 6px',
                                    background: 'rgba(255,255,255,0.04)',
                                    borderRadius: 6,
                                    fontWeight: 600,
                                }}
                            >
                                {r.lat.toFixed(1)}°, {r.lon.toFixed(1)}°
                            </span>
                        </button>
                    ))}

                {!loading && !searched && (
                    <div style={{ textAlign: 'center', padding: 32, color: '#475569', fontSize: 12 }}>
                        Search by vessel name, call sign, or 9-digit MMSI
                    </div>
                )}
            </div>
        </div>
    );
};
