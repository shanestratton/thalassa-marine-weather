/**
 * RadioConsolePage — "Report Position" high-contrast screen.
 *
 * Designed for 0300 VHF position reports:
 *  - Navy dark background with amber/gold text (night-vision safe)
 *  - Live GPS position in nautical degrees-minutes format
 *  - Vessel identity (name, call sign, MMSI, rego)
 *  - SOG/COG from GPS
 *  - TTS readback button (native speech synthesis)
 *  - Copy-to-clipboard for sat-phone SMS
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { GpsService, type GpsPosition } from '../../services/GpsService';
import { useSettings } from '../../context/SettingsContext';
import { triggerHaptic } from '../../utils/system';
import './RadioConsolePage.css';

interface RadioConsolePageProps {
    onBack: () => void;
    onNavigate?: (page: string) => void;
}

// ── Coordinate formatting ─────────────────────────────────────────────────
/** Convert decimal degrees to degrees°minutes.decimal′ N/S/E/W format */
function formatLat(dec: number): string {
    const abs = Math.abs(dec);
    const deg = Math.floor(abs);
    const min = (abs - deg) * 60;
    const dir = dec >= 0 ? 'N' : 'S';
    return `${deg}°${min.toFixed(3)}′${dir}`;
}

function formatLon(dec: number): string {
    const abs = Math.abs(dec);
    const deg = Math.floor(abs);
    const min = (abs - deg) * 60;
    const dir = dec >= 0 ? 'E' : 'W';
    return `${String(deg).padStart(3, '0')}°${min.toFixed(3)}′${dir}`;
}

/** Build a phonetic readback string for the TTS engine */
function buildPhoneticReadback(
    vesselName: string,
    phoneticName: string | undefined,
    callSign: string | undefined,
    mmsi: string | undefined,
    lat: number,
    lon: number,
    sogKts: number,
    cogDeg: number,
): string {
    const name = phoneticName || vesselName || 'vessel';
    const absLat = Math.abs(lat);
    const latDeg = Math.floor(absLat);
    const latMin = ((absLat - latDeg) * 60).toFixed(1);
    const latDir = lat >= 0 ? 'North' : 'South';

    const absLon = Math.abs(lon);
    const lonDeg = Math.floor(absLon);
    const lonMin = ((absLon - lonDeg) * 60).toFixed(1);
    const lonDir = lon >= 0 ? 'East' : 'West';

    let report = `This is sailing vessel ${name}. `;
    if (callSign) report += `Call sign ${callSign.split('').join(' ')}. `;
    if (mmsi) report += `MMSI ${mmsi.split('').join(' ')}. `;
    report += `Position: ${latDeg} degrees ${latMin} minutes ${latDir}, `;
    report += `${lonDeg} degrees ${lonMin} minutes ${lonDir}. `;
    report += `Speed over ground ${sogKts.toFixed(1)} knots. `;
    report += `Course ${Math.round(cogDeg)} degrees true.`;
    return report;
}

/** Build a compact clipboard-friendly position string */
function buildClipboardText(
    vesselName: string,
    callSign: string | undefined,
    mmsi: string | undefined,
    rego: string | undefined,
    lat: number,
    lon: number,
    sogKts: number,
    cogDeg: number,
): string {
    const lines = [vesselName];
    if (callSign) lines.push(`CS: ${callSign}`);
    if (mmsi) lines.push(`MMSI: ${mmsi}`);
    if (rego) lines.push(`Rego: ${rego}`);
    lines.push(`Pos: ${formatLat(lat)} ${formatLon(lon)}`);
    lines.push(`SOG: ${sogKts.toFixed(1)}kts  COG: ${Math.round(cogDeg)}°T`);
    lines.push(`UTC: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
    return lines.join('\n');
}

export const RadioConsolePage: React.FC<RadioConsolePageProps> = ({ onBack, onNavigate }) => {
    const { settings } = useSettings();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vessel = (settings as any)?.vessel;

    // ── GPS state ──
    const [position, setPosition] = useState<GpsPosition | null>(null);
    const [gpsAge, setGpsAge] = useState<string>('—');
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [copied, setCopied] = useState(false);
    const [gpsError, setGpsError] = useState(false);
    const tickRef = useRef<ReturnType<typeof setInterval>>();

    // Poll GPS every 3 seconds
    useEffect(() => {
        let active = true;
        const poll = () => {
            GpsService.getCurrentPosition({ staleLimitMs: 10_000, timeoutSec: 8 })
                .then((pos) => {
                    if (active) {
                        setPosition(pos);
                        setGpsError(false);
                    }
                })
                .catch(() => {
                    if (active) setGpsError(true);
                });
        };

        poll(); // initial
        const id = setInterval(poll, 3000);
        return () => {
            active = false;
            clearInterval(id);
        };
    }, []);

    // Update GPS age ticker every second
    useEffect(() => {
        tickRef.current = setInterval(() => {
            if (position) {
                const ageSec = Math.floor((Date.now() - position.timestamp) / 1000);
                setGpsAge(ageSec < 5 ? 'LIVE' : `${ageSec}s ago`);
            }
        }, 1000);
        return () => clearInterval(tickRef.current);
    }, [position]);

    // ── SOG/COG from GPS ──
    const sogKts = position ? position.speed * 1.94384 : 0; // m/s to knots
    const cogDeg = position?.heading ?? 0;

    // ── Vessel identity ──
    const vesselName = vessel?.name || 'Not Set';
    const callSign = vessel?.callSign || undefined;
    const mmsi = vessel?.mmsi || undefined;
    const rego = vessel?.registration || undefined;
    const phoneticName = vessel?.phoneticName || undefined;

    // ── TTS readback ──
    const handleSpeak = useCallback(() => {
        if (!position || isSpeaking) return;
        triggerHaptic('medium');

        const text = buildPhoneticReadback(
            vesselName,
            phoneticName,
            callSign,
            mmsi,
            position.latitude,
            position.longitude,
            sogKts,
            cogDeg,
        );

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.85; // Slow enough for VHF
        utterance.pitch = 0.9;
        utterance.onstart = () => setIsSpeaking(true);
        utterance.onend = () => setIsSpeaking(false);
        utterance.onerror = () => setIsSpeaking(false);
        speechSynthesis.speak(utterance);
    }, [position, isSpeaking, vesselName, phoneticName, callSign, mmsi, sogKts, cogDeg]);

    // ── Copy to clipboard ──
    const handleCopy = useCallback(() => {
        if (!position) return;
        triggerHaptic('light');

        const text = buildClipboardText(
            vesselName,
            callSign,
            mmsi,
            rego,
            position.latitude,
            position.longitude,
            sogKts,
            cogDeg,
        );

        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    }, [position, vesselName, callSign, mmsi, rego, sogKts, cogDeg]);

    const utcTime = new Date().toISOString().slice(11, 19);

    return (
        <div className="radio-console">
            {/* ── Header bar ── */}
            <div className="radio-console__header">
                <button onClick={onBack} className="radio-console__back" aria-label="Back to vessel">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                    </svg>
                </button>
                <div className="radio-console__title">
                    <div className="radio-console__title-icon">📻</div>
                    <div>
                        <h1>Radio Console</h1>
                        <p>Report Position</p>
                    </div>
                </div>
                <div
                    className={`radio-console__gps-status ${gpsError ? 'error' : gpsAge === 'LIVE' ? 'live' : 'stale'}`}
                >
                    <div className="radio-console__gps-dot" />
                    <span>{gpsError ? 'NO FIX' : gpsAge}</span>
                </div>
            </div>

            {/* ── Vessel identity strip ── */}
            <div className="radio-console__identity">
                <div className="radio-console__vessel-name">{vesselName}</div>
                <div className="radio-console__id-row">
                    {callSign && (
                        <div className="radio-console__id-chip">
                            <span className="label">CS</span>
                            <span className="value">{callSign}</span>
                        </div>
                    )}
                    {mmsi && (
                        <div className="radio-console__id-chip">
                            <span className="label">MMSI</span>
                            <span className="value">{mmsi}</span>
                        </div>
                    )}
                    {rego && (
                        <div className="radio-console__id-chip">
                            <span className="label">REGO</span>
                            <span className="value">{rego}</span>
                        </div>
                    )}
                    {!callSign && !mmsi && !rego && (
                        <button
                            onClick={() => {
                                onBack();
                                onNavigate?.('settings');
                            }}
                            className="radio-console__id-chip empty"
                            style={{ cursor: 'pointer' }}
                        >
                            <span className="value">⚙️ Set identity in Vessel Settings →</span>
                        </button>
                    )}
                </div>
            </div>

            {/* ── Position display ── */}
            <div className="radio-console__position">
                {position ? (
                    <>
                        <div className="radio-console__coord">
                            <span className="radio-console__coord-label">LAT</span>
                            <span className="radio-console__coord-value">{formatLat(position.latitude)}</span>
                        </div>
                        <div className="radio-console__coord">
                            <span className="radio-console__coord-label">LON</span>
                            <span className="radio-console__coord-value">{formatLon(position.longitude)}</span>
                        </div>
                    </>
                ) : (
                    <div className="radio-console__no-fix">
                        <svg
                            width="32"
                            height="32"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.5}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
                            />
                        </svg>
                        <span>Acquiring GPS Fix…</span>
                    </div>
                )}
            </div>

            {/* ── SOG / COG / UTC strip ── */}
            <div className="radio-console__metrics">
                <div className="radio-console__metric">
                    <span className="radio-console__metric-label">SOG</span>
                    <span className="radio-console__metric-value">
                        {position ? sogKts.toFixed(1) : '—'}
                        <span className="radio-console__metric-unit">kts</span>
                    </span>
                </div>
                <div className="radio-console__metric-divider" />
                <div className="radio-console__metric">
                    <span className="radio-console__metric-label">COG</span>
                    <span className="radio-console__metric-value">
                        {position ? `${Math.round(cogDeg)}` : '—'}
                        <span className="radio-console__metric-unit">°T</span>
                    </span>
                </div>
                <div className="radio-console__metric-divider" />
                <div className="radio-console__metric">
                    <span className="radio-console__metric-label">UTC</span>
                    <span className="radio-console__metric-value radio-console__metric-value--time">{utcTime}</span>
                </div>
            </div>

            {/* ── Action buttons ── */}
            <div className="radio-console__actions">
                <button
                    onClick={handleSpeak}
                    disabled={!position || isSpeaking}
                    className={`radio-console__btn radio-console__btn--speak ${isSpeaking ? 'speaking' : ''}`}
                    aria-label="Read position aloud"
                >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"
                        />
                    </svg>
                    <span>{isSpeaking ? 'Speaking…' : 'Read Position'}</span>
                </button>

                <button
                    onClick={handleCopy}
                    disabled={!position}
                    className={`radio-console__btn radio-console__btn--copy ${copied ? 'copied' : ''}`}
                    aria-label="Copy position to clipboard"
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                        {copied ? (
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        ) : (
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"
                            />
                        )}
                    </svg>
                    <span>{copied ? 'Copied!' : 'Copy'}</span>
                </button>
            </div>
        </div>
    );
};
