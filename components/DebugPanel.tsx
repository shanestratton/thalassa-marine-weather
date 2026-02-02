import React, { useState, useEffect } from 'react';

export const DebugPanel: React.FC = () => {
    const [debug, setDebug] = useState<any>(null);
    const [expanded, setExpanded] = useState(false); // Start collapsed

    useEffect(() => {
        const interval = setInterval(() => {
            const d = (window as any).THALASSA_DEBUG;
            if (d) {
                setDebug({ ...d });
            }
        }, 500);
        return () => clearInterval(interval);
    }, []);

    if (!debug) return null;

    return (
        <>
            {/* Small Bug Icon - Bottom Right Corner */}
            {!expanded && (
                <button
                    onClick={() => setExpanded(true)}
                    style={{
                        position: 'fixed',
                        bottom: '20px',
                        right: '20px',
                        width: '44px',
                        height: '44px',
                        borderRadius: '50%',
                        backgroundColor: 'rgba(0, 0, 0, 0.6)',
                        border: '2px solid rgba(255, 255, 255, 0.2)',
                        color: '#00ffff',
                        fontSize: '24px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        zIndex: 9998,
                        backdropFilter: 'blur(10px)',
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)'
                    }}
                >
                    🐛
                </button>
            )}

            {/* Expanded Debug Panel */}
            {expanded && (
                <div
                    style={{
                        position: 'fixed',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        backgroundColor: 'rgba(0, 0, 0, 0.95)',
                        color: '#fff',
                        padding: '16px',
                        fontSize: '12px',
                        fontFamily: 'monospace',
                        borderTop: '2px solid #00ffff',
                        zIndex: 9999,
                        maxHeight: '400px',
                        overflowY: 'auto',
                        backdropFilter: 'blur(10px)'
                    }}
                >
                    {/* Close Button */}
                    <button
                        onClick={() => setExpanded(false)}
                        style={{
                            position: 'absolute',
                            top: '8px',
                            right: '8px',
                            background: 'transparent',
                            border: '1px solid rgba(255, 255, 255, 0.3)',
                            color: '#fff',
                            borderRadius: '4px',
                            padding: '4px 12px',
                            cursor: 'pointer',
                            fontSize: '12px'
                        }}
                    >
                        ✕ Close
                    </button>

                    <div style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', color: '#00ffff' }}>
                        🐛 DATA SOURCES DEBUG
                    </div>

                    {/* Beacon */}
                    <div style={{ marginBottom: '8px' }}>
                        <span style={{ color: '#4ade80' }}>🟢 BEACON:</span> {debug.beacon || 'Loading...'}
                    </div>

                    {/* Airport */}
                    <div style={{ marginBottom: '8px' }}>
                        <span style={{ color: '#fbbf24' }}>🟠 AIRPORT:</span> {debug.airport || 'Loading...'}
                    </div>

                    {/* Merge Input */}
                    {debug.mergeInput && (
                        <div style={{ marginBottom: '12px', fontSize: '11px', opacity: 0.8 }}>
                            Merge: Beacon={debug.mergeInput.hasBeacon ? '✓' : '✗'}
                            Airport={debug.mergeInput.hasAirport ? '✓' : '✗'}
                            SG={debug.mergeInput.hasStormGlass ? '✓' : '✗'}
                        </div>
                    )}

                    {/* Metric Sources */}
                    {debug.sources && (
                        <div>
                            <div style={{ fontWeight: 'bold', marginBottom: '8px', color: '#00ffff' }}>
                                📊 METRIC SOURCES:
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '4px' }}>
                                {Object.entries(debug.sources).map(([key, value]: [string, any]) => {
                                    const color = value?.sourceColor === 'green' ? '#4ade80'
                                        : value?.sourceColor === 'amber' ? '#fbbf24'
                                            : '#ef4444';
                                    return (
                                        <div key={key} style={{ fontSize: '11px' }}>
                                            <span style={{ color }}>●</span> {key}: {value?.sourceName}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Error */}
                    {debug.error && (
                        <div style={{ marginTop: '12px', color: '#ef4444' }}>
                            ❌ ERROR: {debug.error}
                        </div>
                    )}

                    {/* Last Update */}
                    {debug.lastUpdate && (
                        <div style={{ marginTop: '12px', fontSize: '10px', opacity: 0.6 }}>
                            Last update: {debug.lastUpdate}
                        </div>
                    )}
                </div>
            )}
        </>
    );
};
