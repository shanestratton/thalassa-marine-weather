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
import { EmptyState } from '../ui/EmptyState';
import { ShimmerBlock } from '../ui/ShimmerBlock';
import { OverlayPortal } from '../ui/OverlayPortal';
import { useFocusTrap } from '../../hooks/useFocusTrap';

import { createLogger } from '../../utils/createLogger';

const log = createLogger('VesselSearch');

interface VesselSearchResult {
    mmsi: number;
    name: string | null;
    flag: string;
    /**
     * Null when the vessel is known but has not yet reported a position. AIS
     * sends static data (name) and position as separate messages, so a ship
     * can be in the table by name before its first fix. Such a hit is still a
     * hit — it is shown, marked, and simply cannot be flown to.
     */
    lat: number | null;
    lon: number | null;
    sog: number;
    shipType: number;
    /** When the row was last written — so the user can judge freshness. */
    updatedAt: string | null;
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
    /** A search-time failure or a no-position tap; shown inline, never a toast. */
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const requestVersionRef = useRef(0);
    const dialogRef = useFocusTrap<HTMLDivElement>(visible, {
        initialFocusRef: inputRef,
        onEscape: onClose,
    });

    // Reset transient results on each open; the shared dialog lifecycle moves
    // focus into the search field and restores the map trigger on close.
    useEffect(() => {
        requestVersionRef.current += 1;
        if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
        }
        if (visible) {
            setQuery('');
            setResults([]);
            setSearched(false);
            setLoading(false);
            setError(null);
        }

        return () => {
            requestVersionRef.current += 1;
            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
                debounceRef.current = null;
            }
        };
    }, [visible]);

    const searchVessels = useCallback(async (q: string, requestVersion: number) => {
        if (q.length < 2) {
            if (requestVersion === requestVersionRef.current) {
                setResults([]);
                setSearched(false);
                setLoading(false);
            }
            return;
        }

        if (requestVersion === requestVersionRef.current) {
            setLoading(true);
            setSearched(true);
        }

        if (!supabase) {
            if (requestVersion === requestVersionRef.current) {
                setResults([]);
                setLoading(false);
            }
            return;
        }

        try {
            // One path. There used to be a "fallback" that queried the table
            // directly for `lat, lon` columns — columns the table does not have
            // (it stores a PostGIS `location`). So if the RPC ever errored, the
            // fallback errored too, silently, and the user saw an empty list
            // that looked like "no such ship". Resilience that cannot work is
            // worse than none: it hides the real failure. Now an RPC error is
            // logged AND surfaced as an error state rather than an empty list.
            const { data, error } = await supabase.rpc('search_vessels', {
                search_query: q.trim(),
                max_results: 10,
            });

            if (requestVersion !== requestVersionRef.current) return;

            if (error) {
                log.warn('[VesselSearch] search_vessels failed:', error.message);
                setResults([]);
                setError('Search is unavailable right now');
                return;
            }
            setError(null);

            const merged: VesselSearchResult[] = (data || []).map(
                (v: {
                    mmsi: number;
                    name: string | null;
                    call_sign: string | null;
                    ship_type: number | null;
                    sog: number | null;
                    lat: number | null;
                    lon: number | null;
                    has_position: boolean;
                    updated_at: string | null;
                }) => ({
                    mmsi: v.mmsi,
                    name: v.name || null,
                    flag: getMmsiFlag(v.mmsi),
                    // has_position is authoritative. A vessel with no fix comes
                    // back with null lat/lon and is KEPT — the old client
                    // filtered on `lat !== 0 || lon !== 0`, which dropped nothing
                    // useful (nulls are not 0) but signalled the wrong intent.
                    lat: v.has_position ? v.lat : null,
                    lon: v.has_position ? v.lon : null,
                    sog: v.sog ?? 0,
                    shipType: v.ship_type ?? 0,
                    updatedAt: v.updated_at ?? null,
                    source: 'live' as const,
                }),
            );

            if (requestVersion === requestVersionRef.current) setResults(merged);
        } catch (err) {
            log.warn('[VesselSearch] Error:', err);
            if (requestVersion === requestVersionRef.current) setResults([]);
        } finally {
            if (requestVersion === requestVersionRef.current) setLoading(false);
        }
    }, []);

    const handleInput = (val: string) => {
        setQuery(val);
        setError(null);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        const requestVersion = ++requestVersionRef.current;
        if (val.length < 2) {
            setResults([]);
            setSearched(false);
            setLoading(false);
            debounceRef.current = null;
            return;
        }
        debounceRef.current = setTimeout(() => {
            debounceRef.current = null;
            void searchVessels(val, requestVersion);
        }, 400);
    };

    const handleSubmit = () => {
        if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
        }
        const requestVersion = ++requestVersionRef.current;
        void searchVessels(query, requestVersion);
    };

    const handleSelect = (result: VesselSearchResult) => {
        const displayName = result.name || `MMSI ${result.mmsi}`;
        if (result.lat === null || result.lon === null) {
            // Known ship, no fix yet — nothing to centre the chart on. Say so
            // rather than flying to (0, 0) off the coast of Africa.
            triggerHaptic('light');
            setError(`${displayName} hasn't reported a position yet`);
            return;
        }
        triggerHaptic('medium');
        onSelect(result.lat, result.lon, result.mmsi, displayName);
        onClose();
    };

    if (!visible) return null;

    return (
        <OverlayPortal
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Search vessels"
            style={{
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
                        if (e.key === 'Enter') handleSubmit();
                    }}
                    aria-label="Vessel name or MMSI"
                />
                <button
                    onClick={onClose}
                    style={{
                        width: 44,
                        height: 44,
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
                    <div style={{ padding: '16px 8px' }}>
                        <ShimmerBlock variant="list" rows={3} />
                    </div>
                )}

                {/* "No vessels found" is a claim about the DATA and must never be
                    shown when the SEARCH failed — during an outage the two look
                    identical from here, and telling the user "no such ship" is
                    the exact lie the old fake fallback used to tell. */}
                {!loading && searched && !error && results.length === 0 && (
                    <EmptyState icon="🚢" title="No Vessels Found" description={`No vessels matching "${query}"`} />
                )}

                {!loading &&
                    results.map((r) => (
                        <button
                            aria-label="Select this vessel from search results"
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
                                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 1 }}>
                                    MMSI {r.mmsi} • {r.sog > 0 ? `${r.sog.toFixed(1)} kts` : 'Stationary'}
                                </div>
                            </div>
                            <span
                                style={{
                                    fontSize: 12,
                                    color: '#64748b',
                                    flexShrink: 0,
                                    padding: '2px 6px',
                                    background: 'rgba(255,255,255,0.04)',
                                    borderRadius: 6,
                                    fontWeight: 600,
                                }}
                            >
                                {r.lat !== null && r.lon !== null
                                    ? `${r.lat.toFixed(1)}°, ${r.lon.toFixed(1)}°`
                                    : 'no position yet'}
                            </span>
                        </button>
                    ))}

                {error && (
                    <div
                        role="alert"
                        style={{ textAlign: 'center', padding: '10px 16px', color: '#fbbf24', fontSize: 12 }}
                    >
                        {error}
                    </div>
                )}

                {!loading && !searched && (
                    <div style={{ textAlign: 'center', padding: 32, color: '#475569', fontSize: 12 }}>
                        Search by vessel name, call sign, or 9-digit MMSI
                    </div>
                )}
            </div>
        </OverlayPortal>
    );
};
