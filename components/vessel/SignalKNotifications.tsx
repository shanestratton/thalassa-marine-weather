import React from 'react';
import type { SignalKNotice } from '../../pi-cache/src/signalkProtocol';

export function SignalKNotifications({
    notices,
    source,
}: {
    notices: SignalKNotice[];
    source: 'Direct Signal K' | 'Paired Pi';
}) {
    if (!notices.length) return null;
    return (
        <div className="space-y-2 border-t border-white/10 pt-3" aria-label="Signal K notifications">
            <p className="text-xs text-gray-300">{source} · server notifications · source-dated</p>
            {notices.map((n) => (
                <div
                    key={`${n.source}|${n.path}`}
                    className="break-words rounded-lg bg-white/5 p-3 text-xs text-gray-200"
                >
                    <strong>{n.state.toUpperCase()}</strong> · {n.message}
                    <div className="mt-1 text-gray-400">
                        {n.source} · {new Date(n.at).toISOString().slice(0, 19).replace('T', ' ')} UTC ·{' '}
                        {Math.max(0, Math.floor((Date.now() - n.at) / 1000))} s old
                    </div>
                    <div className="mt-1 text-gray-400">{n.path}</div>
                </div>
            ))}
        </div>
    );
}
