/**
 * GuardianPage — Maritime Neighborhood Watch Hub
 *
 * The last feature before shipping. Make it a humdinger.
 *
 * Layout:
 *   1. Bay Presence Hero — "X Thalassa boats nearby" with pulsing radar
 *   2. ARM/DISARM BOLO toggle — slide-to-arm control
 *   3. Quick Actions — Report Suspicious, Weather Alert, Set Tripwire
 *   4. Nearby Boats list with Hail buttons
 *   5. Alert Feed — live local safety alerts
 *   6. Guardian Profile Setup (if no profile)
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { LocationStore } from '../stores/LocationStore';
import {
    GuardianService,
    NearbyUser,
    GuardianAlert,
    HAIL_MESSAGES,
    WEATHER_TEMPLATES,
} from '../services/GuardianService';
import { triggerHaptic } from '../utils/system';

interface GuardianPageProps {
    onBack: () => void;
}

export const GuardianPage: React.FC<GuardianPageProps> = ({ onBack }) => {
    // ── State ──
    const [armed, setArmed] = useState(false);
    const [arming, setArming] = useState(false);
    const [nearbyUsers, setNearbyUsers] = useState<NearbyUser[]>([]);
    const [alerts, setAlerts] = useState<GuardianAlert[]>([]);
    const [_hasProfile, setHasProfile] = useState(false);
    const [loading, setLoading] = useState(true);
    const [showOnboarding, setShowOnboarding] = useState(false);

    // Modals
    const [showSetup, setShowSetup] = useState(false);
    const [showReport, setShowReport] = useState(false);
    const [showWeather, setShowWeather] = useState(false);
    const [showHail, setShowHail] = useState<NearbyUser | null>(null);

    // Setup form
    const [vesselName, setVesselName] = useState('');
    const [ownerName, setOwnerName] = useState('');
    const [dogName, setDogName] = useState('');
    const [vesselBio, setVesselBio] = useState('');
    const [mmsiInput, setMmsiInput] = useState('');

    // Report form
    const [reportText, setReportText] = useState('');

    // ARM slider
    const sliderRef = useRef<HTMLDivElement>(null);
    const [sliderX, setSliderX] = useState(0);
    const sliderXRef = useRef(0);
    const [isDragging, setIsDragging] = useState(false);

    // ── Init ──
    useEffect(() => {
        const init = async () => {
            setLoading(true);
            // Check if onboarding was already dismissed
            const dismissed = localStorage.getItem('guardian-onboarding-dismissed');
            if (!dismissed) setShowOnboarding(true);
            await GuardianService.initialize();
            const profile = await GuardianService.fetchProfile();
            if (profile) {
                setHasProfile(true);
                setArmed(profile.armed);
                setVesselName(profile.vessel_name || '');
                setOwnerName(profile.owner_name || '');
                setDogName(profile.dog_name || '');
                setVesselBio(profile.vessel_bio || '');
            } else {
                setShowSetup(true);
            }
            await GuardianService.fetchNearbyUsers();
            await GuardianService.fetchAlerts();
            setLoading(false);
        };
        init();

        const unsub = GuardianService.subscribe((state) => {
            setNearbyUsers(state.nearbyUsers);
            setAlerts(state.alerts);
            setArmed(state.armed);
        });

        return unsub;
    }, []);

    // ── ARM/DISARM handlers ──
    const handleArm = useCallback(async () => {
        // Check GPS availability first
        const pos = LocationStore.getState();
        if (!pos.lat || !pos.lon) {
            alert('Cannot arm — no GPS position available. Please enable location services.');
            return;
        }
        setArming(true);
        triggerHaptic('heavy');
        const ok = await GuardianService.arm();
        if (ok) {
            setArmed(true);
            triggerHaptic('heavy');
        } else {
            alert('Failed to arm vessel. Please ensure you have a Guardian profile set up and try again.');
        }
        setArming(false);
    }, []);

    const handleDisarm = useCallback(async () => {
        setArming(true);
        triggerHaptic('medium');
        const ok = await GuardianService.disarm();
        if (ok) {
            setArmed(false);
        } else {
            alert('Failed to disarm. Please try again.');
        }
        setArming(false);
    }, []);

    // ── Slide-to-arm touch handling ──
    const handleSliderStart = useCallback(
        (e: React.TouchEvent | React.MouseEvent) => {
            if (arming) return;
            setIsDragging(true);
            const startX = 'touches' in e ? e.touches[0].clientX : e.clientX;
            const containerWidth = sliderRef.current?.clientWidth || 300;
            const thumbWidth = 64;
            const maxX = containerWidth - thumbWidth - 8;

            const handleMove = (ev: TouchEvent | MouseEvent) => {
                const currentX = 'touches' in ev ? ev.touches[0].clientX : ev.clientX;
                const dx = Math.max(0, Math.min(currentX - startX, maxX));
                sliderXRef.current = dx;
                setSliderX(dx);
            };

            const handleEnd = () => {
                const threshold = maxX * 0.75;
                if (sliderXRef.current >= threshold) {
                    if (armed) handleDisarm();
                    else handleArm();
                }
                sliderXRef.current = 0;
                setSliderX(0);
                setIsDragging(false);
                document.removeEventListener('touchmove', handleMove);
                document.removeEventListener('touchend', handleEnd);
                document.removeEventListener('mousemove', handleMove);
                document.removeEventListener('mouseup', handleEnd);
            };

            document.addEventListener('touchmove', handleMove, { passive: true });
            document.addEventListener('touchend', handleEnd);
            document.addEventListener('mousemove', handleMove);
            document.addEventListener('mouseup', handleEnd);
        },
        [armed, arming, handleArm, handleDisarm],
    );

    // ── Profile save ──
    const handleSaveProfile = useCallback(async () => {
        triggerHaptic('light');
        const updates: Record<string, unknown> = {
            vessel_name: vesselName,
            owner_name: ownerName,
            dog_name: dogName,
            vessel_bio: vesselBio,
        };
        if (mmsiInput.trim()) {
            const mmsi = parseInt(mmsiInput, 10);
            if (!isNaN(mmsi) && mmsiInput.length === 9) {
                const result = await GuardianService.claimMMSI(mmsi);
                if (!result.success) {
                    alert(result.error || 'Failed to claim MMSI');
                    return;
                }
            }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await GuardianService.updateProfile(updates as any);
        setHasProfile(true);
        setShowSetup(false);
    }, [vesselName, ownerName, dogName, vesselBio, mmsiInput]);

    // ── Report suspicious ──
    const handleReport = useCallback(async () => {
        if (!reportText.trim()) return;
        triggerHaptic('heavy');
        const result = await GuardianService.reportSuspicious(reportText.trim());
        if (result.success) {
            setReportText('');
            setShowReport(false);
        }
    }, [reportText]);

    // ── Hail ──
    const handleHail = useCallback(async (user: NearbyUser, message: string) => {
        triggerHaptic('light');
        await GuardianService.sendHail(user.user_id, message);
        setShowHail(null);
    }, []);

    // ── Weather broadcast ──
    const handleWeatherBroadcast = useCallback(async (message: string) => {
        triggerHaptic('medium');
        await GuardianService.broadcastWeatherSpike(message);
        setShowWeather(false);
    }, []);

    // ── Alert type styling ──
    const alertStyle = (type: string) => {
        switch (type) {
            case 'bolo':
                return { icon: '🚨', color: 'text-red-400', bg: 'bg-red-500/15', border: 'border-red-500/30' };
            case 'suspicious':
                return { icon: '⚠️', color: 'text-amber-400', bg: 'bg-amber-500/15', border: 'border-amber-500/30' };
            case 'drag_warning':
                return { icon: '⚓', color: 'text-orange-400', bg: 'bg-orange-500/15', border: 'border-orange-500/30' };
            case 'weather_spike':
                return { icon: '⛈️', color: 'text-sky-400', bg: 'bg-sky-500/15', border: 'border-sky-500/30' };
            case 'geofence_breach':
                return { icon: '🏠', color: 'text-purple-400', bg: 'bg-purple-500/15', border: 'border-purple-500/30' };
            case 'hail':
                return {
                    icon: '🏴‍☠️',
                    color: 'text-emerald-400',
                    bg: 'bg-emerald-500/15',
                    border: 'border-emerald-500/30',
                };
            default:
                return { icon: '📡', color: 'text-gray-400', bg: 'bg-white/5', border: 'border-white/10' };
        }
    };

    const timeAgo = (ts: string) => {
        const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        return `${hrs}h ago`;
    };

    if (loading) {
        return (
            <div className="w-full h-full flex items-center justify-center">
                <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    return (
        <div
            className="w-full h-full flex flex-col animate-in fade-in duration-300 overflow-hidden"
            style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
        >
            {/* ── Header ── */}
            <div className="flex items-center gap-3 px-4 py-3 shrink-0">
                <button
                    onClick={() => {
                        triggerHaptic('light');
                        onBack();
                    }}
                    className="p-2 -ml-2 hover:bg-white/5 rounded-xl transition-colors active:scale-95"
                >
                    <svg
                        className="w-5 h-5 text-white"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                    </svg>
                </button>
                <div className="flex-1">
                    <h1 className="text-lg font-black tracking-wide text-white">Guardian</h1>
                    <p className="text-[11px] text-emerald-400 font-bold uppercase tracking-[0.2em]">
                        Maritime Neighbourhood Watch
                    </p>
                </div>
                <button
                    onClick={() => {
                        triggerHaptic('light');
                        setShowSetup(true);
                    }}
                    className="p-2 hover:bg-white/5 rounded-xl transition-colors"
                    aria-label="Edit Profile"
                >
                    <svg
                        className="w-5 h-5 text-gray-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.5}
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"
                        />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                </button>
            </div>

            {/* ── Scrollable Content ── */}
            <div className="flex-1 overflow-y-auto px-4 space-y-5">
                {/* ═══ ONBOARDING EXPLAINER CARDS ═══ */}
                {showOnboarding && (
                    <div className="space-y-3 animate-in fade-in slide-in-from-top-2 duration-500">
                        {/* Welcome header */}
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <div className="w-1 h-4 rounded-full bg-emerald-500" />
                                <span className="text-[11px] font-black text-emerald-400 uppercase tracking-[0.2em]">
                                    Welcome to Guardian
                                </span>
                            </div>
                            <button
                                onClick={() => {
                                    localStorage.setItem('guardian-onboarding-dismissed', 'true');
                                    setShowOnboarding(false);
                                    triggerHaptic('light');
                                }}
                                className="text-[11px] text-gray-400 font-bold uppercase tracking-wider hover:text-white transition-colors px-2 py-1"
                            >
                                Dismiss
                            </button>
                        </div>

                        {/* Card 1: ARM */}
                        <div className="bg-gradient-to-br from-red-500/10 to-amber-500/10 border border-red-500/20 rounded-xl p-4">
                            <div className="flex items-start gap-3">
                                <div className="w-10 h-10 rounded-xl bg-red-500/20 flex items-center justify-center shrink-0">
                                    <span className="text-lg">🛡️</span>
                                </div>
                                <div>
                                    <h3 className="text-sm font-black text-white mb-0.5">Slide to ARM</h3>
                                    <p className="text-xs text-gray-300 leading-relaxed">
                                        Locks your GPS position. Nearby boats see you're on watch. You'll get{' '}
                                        <strong className="text-red-400">critical alerts</strong> if your vessel drifts
                                        or suspicious activity is reported nearby.
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Card 2: Tripwire */}
                        <div className="bg-gradient-to-br from-purple-500/10 to-fuchsia-500/10 border border-purple-500/20 rounded-xl p-4">
                            <div className="flex items-start gap-3">
                                <div className="w-10 h-10 rounded-xl bg-purple-500/20 flex items-center justify-center shrink-0">
                                    <span className="text-lg">🏠</span>
                                </div>
                                <div>
                                    <h3 className="text-sm font-black text-white mb-0.5">Digital Tripwire</h3>
                                    <p className="text-xs text-gray-300 leading-relaxed">
                                        Sets a 100m geofence around your current position. If your vessel moves outside
                                        it, you get an <strong className="text-purple-400">instant alert</strong> — even
                                        at 3 AM.
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Card 3: Report */}
                        <div className="bg-gradient-to-br from-red-500/10 to-orange-500/10 border border-red-500/15 rounded-xl p-4">
                            <div className="flex items-start gap-3">
                                <div className="w-10 h-10 rounded-xl bg-red-500/20 flex items-center justify-center shrink-0">
                                    <span className="text-lg">🚨</span>
                                </div>
                                <div>
                                    <h3 className="text-sm font-black text-white mb-0.5">Report Suspicious</h3>
                                    <p className="text-xs text-gray-300 leading-relaxed">
                                        Instantly broadcasts a <strong className="text-amber-400">BOLO alert</strong> to
                                        all Thalassa users within 5 nautical miles. Look out for each other.
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Card 4: Weather */}
                        <div className="bg-gradient-to-br from-sky-500/10 to-cyan-500/10 border border-sky-500/15 rounded-xl p-4">
                            <div className="flex items-start gap-3">
                                <div className="w-10 h-10 rounded-xl bg-sky-500/20 flex items-center justify-center shrink-0">
                                    <span className="text-lg">⛈️</span>
                                </div>
                                <div>
                                    <h3 className="text-sm font-black text-white mb-0.5">Weather Broadcast</h3>
                                    <p className="text-xs text-gray-300 leading-relaxed">
                                        Spot a squall rolling in? Warn nearby boats with a one-tap{' '}
                                        <strong className="text-sky-400">weather spike</strong> so everyone can batten
                                        down the hatches.
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* ═══ ZONE 1: BAY PRESENCE HERO ═══ */}
                <div className="relative bg-gradient-to-br from-emerald-500/15 to-sky-500/15 border border-emerald-500/20 rounded-2xl p-5 overflow-hidden">
                    {/* Animated radar pulse */}
                    <div className="absolute top-3 right-3 w-16 h-16">
                        <div
                            className="absolute inset-0 rounded-full border border-emerald-500/30 animate-ping"
                            style={{ animationDuration: '3s' }}
                        />
                        <div
                            className="absolute inset-2 rounded-full border border-emerald-500/20 animate-ping"
                            style={{ animationDuration: '3s', animationDelay: '0.5s' }}
                        />
                        <div
                            className="absolute inset-4 rounded-full border border-emerald-500/15 animate-ping"
                            style={{ animationDuration: '3s', animationDelay: '1s' }}
                        />
                        {/* Your dot — colored by armed status */}
                        <div
                            className={`absolute inset-[26px] w-3 h-3 rounded-full shadow-lg ${
                                armed ? 'bg-red-400 shadow-red-400/50' : 'bg-emerald-400 shadow-emerald-400/50'
                            }`}
                        />
                    </div>

                    <div className="text-[11px] font-bold text-emerald-400 uppercase tracking-[0.2em] mb-1">
                        Bay Watch
                    </div>

                    {/* Your vessel identity */}
                    <div className="flex items-center gap-2 mb-2">
                        <div
                            className={`w-2.5 h-2.5 rounded-full shrink-0 ${armed ? 'bg-red-400 animate-pulse' : 'bg-emerald-400'}`}
                        />
                        <span className="text-sm font-bold text-white truncate">{vesselName || 'Your Vessel'}</span>
                        {armed && (
                            <span className="px-1.5 py-0.5 bg-red-500/20 border border-red-500/30 rounded text-[10px] font-black text-red-400 uppercase tracking-wider">
                                Armed
                            </span>
                        )}
                    </div>

                    <div className="text-3xl font-black text-white tracking-tight">{nearbyUsers.length}</div>
                    <div className="text-sm text-gray-300 font-medium">
                        Thalassa {nearbyUsers.length === 1 ? 'boat' : 'boats'} nearby
                        {nearbyUsers.filter((u) => u.armed).length > 0 && (
                            <span className="text-red-400 font-bold ml-1">
                                · {nearbyUsers.filter((u) => u.armed).length} armed
                            </span>
                        )}
                    </div>
                    {nearbyUsers.length > 0 && (
                        <div className="text-[11px] text-emerald-400/70 font-medium mt-1">
                            Closest: {nearbyUsers[0].vessel_name || 'Unknown'} ({nearbyUsers[0].distance_nm.toFixed(1)}{' '}
                            NM)
                        </div>
                    )}
                </div>

                {/* ═══ ZONE 2: ARM/DISARM BOLO SLIDER ═══ */}
                <div
                    className={`relative rounded-2xl border overflow-hidden transition-all duration-500 ${
                        armed
                            ? 'bg-gradient-to-r from-red-600/20 to-red-500/20 border-red-500/40 shadow-lg shadow-red-500/10'
                            : 'bg-gradient-to-r from-slate-800/60 to-slate-700/60 border-white/10'
                    }`}
                >
                    <div
                        ref={sliderRef}
                        className="relative h-[72px] flex items-center px-1"
                        onTouchStart={handleSliderStart}
                        onMouseDown={handleSliderStart}
                    >
                        {/* Track label */}
                        <div
                            className={`absolute inset-0 flex items-center justify-center pointer-events-none transition-opacity ${isDragging ? 'opacity-30' : 'opacity-100'}`}
                        >
                            <span
                                className={`text-sm font-black uppercase tracking-[0.2em] ${armed ? 'text-red-400' : 'text-gray-400'}`}
                            >
                                {arming
                                    ? 'Processing...'
                                    : armed
                                      ? '🛡️ ARMED — Slide to Disarm'
                                      : 'Slide to ARM Vessel'}
                            </span>
                        </div>
                        {/* Thumb */}
                        <div
                            className={`relative w-14 h-14 rounded-xl flex items-center justify-center shadow-2xl transition-colors z-10 cursor-grab active:cursor-grabbing ${
                                armed
                                    ? 'bg-gradient-to-br from-red-500 to-red-600'
                                    : 'bg-gradient-to-br from-emerald-500 to-emerald-600'
                            }`}
                            style={{ transform: `translateX(${sliderX}px)` }}
                        >
                            {armed ? (
                                <svg
                                    className="w-6 h-6 text-white"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
                                    />
                                </svg>
                            ) : (
                                <svg
                                    className="w-6 h-6 text-white"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
                                    />
                                </svg>
                            )}
                        </div>
                    </div>
                </div>

                {/* ═══ ZONE 3: QUICK ACTIONS ═══ */}
                <div className="grid grid-cols-3 gap-3">
                    {/* Report Suspicious */}
                    <button
                        onClick={() => {
                            triggerHaptic('medium');
                            setShowReport(true);
                        }}
                        className="bg-gradient-to-br from-red-500/15 to-red-500/10 border border-red-500/20 rounded-xl p-3 text-left group hover:scale-[1.02] transition-all active:scale-[0.97]"
                    >
                        <div className="text-xl mb-1.5">🚨</div>
                        <div className="text-[11px] font-black text-white tracking-wide">Report</div>
                        <div className="text-[11px] text-red-400 font-bold uppercase tracking-widest">Suspicious</div>
                    </button>

                    {/* Weather Alert */}
                    <button
                        onClick={() => {
                            triggerHaptic('medium');
                            setShowWeather(true);
                        }}
                        className="bg-gradient-to-br from-sky-500/15 to-sky-500/10 border border-sky-500/20 rounded-xl p-3 text-left group hover:scale-[1.02] transition-all active:scale-[0.97]"
                    >
                        <div className="text-xl mb-1.5">⛈️</div>
                        <div className="text-[11px] font-black text-white tracking-wide">Weather</div>
                        <div className="text-[11px] text-sky-400 font-bold uppercase tracking-widest">Alert</div>
                    </button>

                    {/* Digital Tripwire */}
                    <button
                        onClick={async () => {
                            triggerHaptic('medium');
                            const pos = LocationStore.getState();
                            if (!pos.lat || !pos.lon) {
                                alert('No GPS position available — please enable location services.');
                                return;
                            }
                            const ok = await GuardianService.setHomeCoordinate(pos.lat, pos.lon);
                            if (ok) {
                                triggerHaptic('heavy');
                                alert(
                                    `Home set at ${pos.lat.toFixed(4)}°, ${pos.lon.toFixed(4)}° — you'll be alerted if your vessel moves outside 100m.`,
                                );
                            }
                        }}
                        className="bg-gradient-to-br from-purple-500/15 to-purple-500/10 border border-purple-500/20 rounded-xl p-3 text-left group hover:scale-[1.02] transition-all active:scale-[0.97]"
                    >
                        <div className="text-xl mb-1.5">🏠</div>
                        <div className="text-[11px] font-black text-white tracking-wide">Tripwire</div>
                        <div className="text-[11px] text-purple-400 font-bold uppercase tracking-widest">Set Home</div>
                    </button>
                </div>

                {/* ═══ ZONE 4: NEARBY BOATS ═══ */}
                {nearbyUsers.length > 0 && (
                    <div>
                        <div className="flex items-center gap-2 mb-3">
                            <div className="w-1 h-4 rounded-full bg-emerald-500" />
                            <span className="text-[11px] font-black text-emerald-400 uppercase tracking-[0.2em]">
                                Nearby Boats
                            </span>
                        </div>
                        <div className="space-y-2">
                            {nearbyUsers.map((user) => (
                                <div
                                    key={user.user_id}
                                    className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 flex items-center gap-3 group hover:bg-white/[0.05] transition-all"
                                >
                                    {/* Avatar/Icon */}
                                    <div
                                        className={`w-10 h-10 rounded-full flex items-center justify-center text-lg shrink-0 ${
                                            user.armed
                                                ? 'bg-red-500/20 border border-red-500/30'
                                                : 'bg-emerald-500/15 border border-emerald-500/20'
                                        }`}
                                    >
                                        {user.dog_name ? '🐕' : '⛵'}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-xs font-bold text-white truncate">
                                            {user.vessel_name || `MMSI ${user.mmsi}`}
                                        </div>
                                        <div className="text-[11px] text-gray-400 flex items-center gap-2">
                                            <span>{user.distance_nm.toFixed(1)} NM</span>
                                            {user.owner_name && (
                                                <>
                                                    <span className="text-white/10">•</span>
                                                    <span>{user.owner_name}</span>
                                                </>
                                            )}
                                            {user.dog_name && (
                                                <>
                                                    <span className="text-white/10">•</span>
                                                    <span>🐕 {user.dog_name}</span>
                                                </>
                                            )}
                                        </div>
                                        {user.armed && (
                                            <div className="text-[10px] text-red-400 font-bold uppercase tracking-wider mt-0.5">
                                                🛡️ Armed
                                            </div>
                                        )}
                                    </div>
                                    {/* Hail button */}
                                    <button
                                        onClick={() => {
                                            triggerHaptic('light');
                                            setShowHail(user);
                                        }}
                                        className="px-3 py-1.5 bg-emerald-500/15 border border-emerald-500/20 rounded-lg text-[11px] font-bold text-emerald-400 uppercase tracking-wider hover:bg-emerald-500/25 transition-colors active:scale-[0.95]"
                                    >
                                        Hail
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* ═══ ZONE 5: ALERT FEED ═══ */}
                <div>
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-amber-500" />
                        <span className="text-[11px] font-black text-amber-400 uppercase tracking-[0.2em]">
                            Alert Feed
                        </span>
                        {alerts.length > 0 && (
                            <span className="px-1.5 py-0.5 bg-amber-500/20 text-amber-300 text-[10px] font-bold rounded-full">
                                {alerts.length}
                            </span>
                        )}
                    </div>
                    {alerts.length === 0 ? (
                        <div className="bg-white/[0.02] border border-white/[0.05] rounded-xl p-6 text-center">
                            <div className="text-2xl mb-2">🛟</div>
                            <div className="text-xs text-gray-400">No alerts in your area</div>
                            <div className="text-[11px] text-gray-500 mt-1">All quiet on the waterfront</div>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {alerts.slice(0, 10).map((alert) => {
                                const style = alertStyle(alert.alert_type);
                                return (
                                    <div
                                        key={alert.id}
                                        className={`${style.bg} border ${style.border} rounded-xl p-3 transition-all`}
                                    >
                                        <div className="flex items-start gap-2">
                                            <span className="text-lg shrink-0">{style.icon}</span>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center justify-between">
                                                    <span className={`text-xs font-bold ${style.color}`}>
                                                        {alert.title}
                                                    </span>
                                                    <span className="text-[10px] text-gray-500 shrink-0 ml-2">
                                                        {timeAgo(alert.created_at)}
                                                    </span>
                                                </div>
                                                <p className="text-xs text-gray-300 mt-0.5 line-clamp-2">
                                                    {alert.body}
                                                </p>
                                                {alert.source_vessel_name && (
                                                    <div className="text-[10px] text-gray-500 mt-1">
                                                        from {alert.source_vessel_name}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Bottom spacer */}
                <div className="h-4" />
            </div>

            {/* ═══ MODAL: PROFILE SETUP ═══ */}
            {showSetup && (
                <div className="fixed inset-0 z-[999] bg-black/80 backdrop-blur-sm flex items-end justify-center animate-in fade-in duration-200">
                    <div className="w-full max-w-lg bg-slate-900 border-t border-white/10 rounded-t-3xl p-6 animate-in slide-in-from-bottom duration-300 max-h-[85vh] overflow-y-auto">
                        <div className="flex items-center justify-between mb-6">
                            <h2 className="text-lg font-black text-white">Guardian Profile</h2>
                            <button
                                onClick={() => setShowSetup(false)}
                                className="p-2 hover:bg-white/5 rounded-xl text-gray-400"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1">
                                    Vessel Name
                                </label>
                                <input
                                    type="text"
                                    value={vesselName}
                                    onChange={(e) => setVesselName(e.target.value)}
                                    placeholder="S/V Poodle Power"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 text-sm"
                                />
                            </div>
                            <div>
                                <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1">
                                    Your Name
                                </label>
                                <input
                                    type="text"
                                    value={ownerName}
                                    onChange={(e) => setOwnerName(e.target.value)}
                                    placeholder="Shane"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 text-sm"
                                />
                            </div>
                            <div>
                                <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1">
                                    Dog&apos;s Name 🐕 <span className="text-gray-500">(optional but encouraged)</span>
                                </label>
                                <input
                                    type="text"
                                    value={dogName}
                                    onChange={(e) => setDogName(e.target.value)}
                                    placeholder="Biscuit"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 text-sm"
                                />
                            </div>
                            <div>
                                <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1">
                                    Vessel Bio
                                </label>
                                <textarea
                                    value={vesselBio}
                                    onChange={(e) => setVesselBio(e.target.value)}
                                    placeholder="1985 Roberts 38 cruising the Hauraki Gulf..."
                                    rows={3}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 text-sm resize-none"
                                />
                            </div>
                            <div>
                                <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1">
                                    MMSI Number <span className="text-gray-500">(9 digits)</span>
                                </label>
                                <input
                                    type="text"
                                    value={mmsiInput}
                                    onChange={(e) => setMmsiInput(e.target.value.replace(/\D/g, '').slice(0, 9))}
                                    placeholder="512345678"
                                    maxLength={9}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 text-sm font-mono"
                                />
                                <p className="text-[10px] text-gray-500 mt-1">
                                    Links your Thalassa profile to your AIS identity
                                </p>
                            </div>
                        </div>

                        <button
                            onClick={handleSaveProfile}
                            className="w-full mt-6 py-3.5 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white font-bold rounded-xl text-sm tracking-wide shadow-lg shadow-emerald-500/25 active:scale-[0.98] transition-transform"
                        >
                            Save Guardian Profile
                        </button>
                    </div>
                </div>
            )}

            {/* ═══ MODAL: REPORT SUSPICIOUS ═══ */}
            {showReport && (
                <div className="fixed inset-0 z-[999] bg-black/80 backdrop-blur-sm flex items-end justify-center animate-in fade-in duration-200">
                    <div
                        className="w-full max-w-lg bg-slate-900 border-t border-red-500/20 rounded-t-3xl p-6 animate-in slide-in-from-bottom duration-300"
                        style={{ marginBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                    >
                        {/* Header with back chevron */}
                        <div className="flex items-center gap-3 mb-4">
                            <button
                                onClick={() => setShowReport(false)}
                                className="p-2 -ml-2 hover:bg-white/5 rounded-xl transition-colors active:scale-95"
                            >
                                <svg
                                    className="w-5 h-5 text-white"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M15.75 19.5L8.25 12l7.5-7.5"
                                    />
                                </svg>
                            </button>
                            <div className="flex-1">
                                <h2 className="text-lg font-black text-red-400">🚨 Report Suspicious Activity</h2>
                                <p className="text-xs text-gray-400">Broadcast to all Thalassa users within 5 NM</p>
                            </div>
                        </div>
                        <textarea
                            value={reportText}
                            onChange={(e) => setReportText(e.target.value)}
                            placeholder="Unknown dinghy moving between boats at 2 AM..."
                            rows={3}
                            className="w-full bg-white/5 border border-red-500/20 rounded-xl px-4 py-3 text-white placeholder-gray-500 text-sm resize-none mb-4"
                            autoFocus
                        />
                        <div className="flex gap-3">
                            <button
                                onClick={() => setShowReport(false)}
                                className="flex-1 py-3 bg-white/5 border border-white/10 rounded-xl text-sm font-bold text-gray-400 active:scale-[0.98] transition-transform"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleReport}
                                disabled={!reportText.trim()}
                                className="flex-1 py-3 bg-gradient-to-r from-red-500 to-red-600 rounded-xl text-sm font-bold text-white shadow-lg shadow-red-500/25 active:scale-[0.98] transition-transform disabled:opacity-40"
                            >
                                Broadcast Alert
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ MODAL: WEATHER ALERT ═══ */}
            {showWeather && (
                <div className="fixed inset-0 z-[999] bg-black/80 backdrop-blur-sm flex items-end justify-center animate-in fade-in duration-200">
                    <div
                        className="w-full max-w-lg bg-slate-900 border-t border-sky-500/20 rounded-t-3xl p-6 animate-in slide-in-from-bottom duration-300"
                        style={{ marginBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                    >
                        {/* Header with back chevron */}
                        <div className="flex items-center gap-3 mb-4">
                            <button
                                onClick={() => setShowWeather(false)}
                                className="p-2 -ml-2 hover:bg-white/5 rounded-xl transition-colors active:scale-95"
                            >
                                <svg
                                    className="w-5 h-5 text-white"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M15.75 19.5L8.25 12l7.5-7.5"
                                    />
                                </svg>
                            </button>
                            <div className="flex-1">
                                <h2 className="text-lg font-black text-sky-400">⛈️ Weather Alert</h2>
                                <p className="text-xs text-gray-400">
                                    Broadcast a weather warning to boats within 5 NM
                                </p>
                            </div>
                        </div>
                        <div className="space-y-2">
                            {WEATHER_TEMPLATES.map((t) => (
                                <button
                                    key={t.text}
                                    onClick={() => handleWeatherBroadcast(t.text)}
                                    className="w-full bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 text-left flex items-center gap-3 hover:bg-sky-500/10 hover:border-sky-500/20 transition-all active:scale-[0.98]"
                                >
                                    <span className="text-xl">{t.emoji}</span>
                                    <span className="text-sm text-gray-200">{t.text}</span>
                                </button>
                            ))}
                        </div>
                        <button
                            onClick={() => setShowWeather(false)}
                            className="w-full mt-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm font-bold text-gray-400 active:scale-[0.98] transition-transform"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {/* ═══ MODAL: HAIL ═══ */}
            {showHail && (
                <div className="fixed inset-0 z-[999] bg-black/80 backdrop-blur-sm flex items-end justify-center animate-in fade-in duration-200">
                    <div className="w-full max-w-lg bg-slate-900 border-t border-emerald-500/20 rounded-t-3xl p-6 animate-in slide-in-from-bottom duration-300">
                        <h2 className="text-lg font-black text-emerald-400 mb-1">
                            🏴‍☠️ Hail {showHail.vessel_name || 'Vessel'}
                        </h2>
                        <p className="text-xs text-gray-400 mb-4">
                            Send a quick message to {showHail.owner_name || 'the crew'}
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                            {HAIL_MESSAGES.map((h) => (
                                <button
                                    key={h.text}
                                    onClick={() => handleHail(showHail, h.text)}
                                    className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 text-center hover:bg-emerald-500/10 hover:border-emerald-500/20 transition-all active:scale-[0.95]"
                                >
                                    <div className="text-xl mb-0.5">{h.emoji}</div>
                                    <div className="text-[11px] text-gray-300 font-medium">{h.text}</div>
                                </button>
                            ))}
                        </div>
                        <button
                            onClick={() => setShowHail(null)}
                            className="w-full mt-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm font-bold text-gray-400 active:scale-[0.98] transition-transform"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
