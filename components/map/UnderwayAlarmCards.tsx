/**
 * The under-way alarms' cards and strip (build 126, 126-02a), drawn by the
 * app-wide alarm stack (./AisGuardAlert.tsx) under the collision cards, and
 * loaded only once there is something to draw.
 *
 * Shoal water first, then off route. Each card says the number and what it
 * is measured from, with one deliberate 44 pt button: shoal water is
 * acknowledged (silent until the water deepens, then it re-arms; never a
 * timed mute, the danger is now); off route is muted for 30 minutes and then
 * says until when. Not a toast: a card goes only when its alarm is answered
 * or over. The strip under them says when the watch cannot see.
 */
import React from 'react';
import { UnderwayAlarmStore, type UnderwayAlarmCard } from '../../services/underway/underwayAlarmStore';

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const CARD: React.CSSProperties = {
    background: 'var(--day-ui-danger-surface, rgba(127, 29, 29, 0.92))',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(239, 68, 68, 0.4)',
    borderRadius: 14,
    padding: '12px 16px',
    color: 'var(--day-ui-danger, #fecaca)',
    fontFamily: FONT,
    boxShadow: '0 8px 32px rgba(239, 68, 68, 0.3)',
    animation: 'guardAlertIn 400ms cubic-bezier(0.16, 1, 0.3, 1) both',
};

/** 44 pt, full width under the words: easy to hit on a moving boat, never an accident. */
const BUTTON: React.CSSProperties = {
    minWidth: 44,
    minHeight: 44,
    width: '100%',
    marginTop: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    border: '1px solid rgba(254, 202, 202, 0.35)',
    background: 'rgba(0, 0, 0, 0.18)',
    color: 'var(--day-ui-danger, #fecaca)',
    fontSize: 13,
    fontWeight: 800,
    cursor: 'pointer',
};

/** A number keeps its unit on its line ('0.25 NM', '2.4 m'): the stack wraps at 320 pt in wide fonts. */
function keepUnits(text: string): string {
    return text.replace(/(\d) (NM|m|kn|s|min)\b/g, '$1 $2');
}

/** 'your sounder reads…' → 'Your sounder reads….' */
function sentence(text: string): string {
    if (!text) return '';
    const upper = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
    return /[.!?]$/.test(upper) ? upper : `${upper}.`;
}

function clock(ms: number): string {
    const at = new Date(ms);
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

function Glyph({ kind }: { kind: UnderwayAlarmCard['kind'] }) {
    return (
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" style={{ flexShrink: 0, marginTop: 1 }}>
            {kind === 'shoal' ? (
                // A hull and her keel, over a rising bottom.
                <path
                    d="M2 5h16c-1.5 3.5-4.5 4.5-8 4.5S3.5 8.5 2 5zM10 9.5v3.5M2 18c3-3 13-3 16 0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                />
            ) : (
                // The route line, and her off it.
                <>
                    <path d="M2 16L18 4" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3 3" />
                    <circle cx="14" cy="15" r="3" fill="currentColor" />
                </>
            )}
        </svg>
    );
}

function AlarmCard({ card }: { card: UnderwayAlarmCard }) {
    const muted = card.kind === 'off-route' && !card.sounding && card.mutedUntil !== null;
    return (
        <div role="alert" data-underway={card.kind} style={{ ...CARD, opacity: muted ? 0.85 : 1 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <Glyph kind={card.kind} />
                <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                    <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.5 }}>{card.title}</div>
                    <div style={{ fontSize: 15, fontWeight: 800, marginTop: 2 }}>{keepUnits(card.value)}</div>
                    <div style={{ fontSize: 13, opacity: 0.9, marginTop: 2 }}>{keepUnits(sentence(card.detail))}</div>
                    {card.note && <div style={{ fontSize: 13, opacity: 0.9 }}>{keepUnits(card.note)}</div>}
                    {muted && (
                        <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4 }}>
                            Muted until {clock(card.mutedUntil!)}
                        </div>
                    )}
                </div>
            </div>
            {card.kind === 'shoal' ? (
                <button
                    type="button"
                    style={BUTTON}
                    aria-label="Acknowledge the shoal alarm"
                    onClick={() => UnderwayAlarmStore.acknowledge('shoal')}
                >
                    Acknowledge
                </button>
            ) : (
                !muted && (
                    <button
                        type="button"
                        style={BUTTON}
                        aria-label="Mute the off-route alarm for 30 minutes"
                        onClick={() => UnderwayAlarmStore.mute('off-route')}
                    >
                        Mute 30 min
                    </button>
                )
            )}
        </div>
    );
}

export function UnderwayAlarmCards({ cards, notices }: { cards: UnderwayAlarmCard[]; notices: string[] }) {
    return (
        <>
            {cards.map((card) => (
                <AlarmCard key={card.kind} card={card} />
            ))}
            {notices.map((text) => (
                <div
                    key={text}
                    role="status"
                    style={{
                        ...CARD,
                        padding: '8px 12px',
                        background: 'var(--day-ui-surface, rgba(15, 23, 42, 0.94))',
                        border: '1px solid rgba(245, 158, 11, 0.5)',
                        color: 'var(--day-ui-warning, #fcd34d)',
                        boxShadow: 'none',
                        fontSize: 13,
                        fontWeight: 700,
                        overflowWrap: 'anywhere',
                    }}
                >
                    {keepUnits(text)}
                </div>
            ))}
        </>
    );
}
