
import React, { useState, useEffect } from 'react';
import { supabase } from '../services/supabase';
import { XIcon, LockIcon, BoatIcon, CheckIcon, DiamondIcon, AlertTriangleIcon } from './Icons';

interface AuthModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose }) => {
    const [email, setEmail] = useState('');
    const [loading, setLoading] = useState(false);
    const [sent, setSent] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [origin, setOrigin] = useState('');

    useEffect(() => {
        if (typeof window !== 'undefined') {
            setOrigin(window.location.origin);
        }
    }, []);

    if (!isOpen) return null;

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!supabase) {
            setError("Database connection not established. Check API Keys.");
            return;
        }
        
        setLoading(true);
        setError(null);
        
        try {
            const { error } = await supabase.auth.signInWithOtp({
                email,
                options: {
                    emailRedirectTo: window.location.origin,
                },
            });
            if (error) throw error;
            setSent(true);
        } catch (err: any) {
            console.error("Auth Error:", err);
            setError(err.message || "Failed to send magic link. Please try again.");
        } finally {
            setLoading(false);
        }
    };

    const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

    return (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/90 backdrop-blur-md transition-opacity" onClick={onClose} />
            
            <div className="relative bg-[#0f172a] w-full max-w-md rounded-3xl overflow-hidden border border-white/10 shadow-2xl flex flex-col animate-in fade-in zoom-in-95">
                <button onClick={onClose} className="absolute top-4 right-4 p-2 bg-black/20 hover:bg-black/40 rounded-full text-white/70 hover:text-white transition-colors z-20">
                    <XIcon className="w-5 h-5" />
                </button>

                <div className="p-8 flex flex-col items-center text-center">
                    <div className="w-16 h-16 bg-sky-500/20 rounded-full flex items-center justify-center mb-6 border border-sky-500/30 shadow-lg">
                        <LockIcon className="w-8 h-8 text-sky-400" />
                    </div>

                    <h2 className="text-2xl font-bold text-white mb-2">Sync Your Logs</h2>
                    <p className="text-sm text-gray-400 mb-8 max-w-xs leading-relaxed">
                        Sign in to synchronize your vessel profile, saved routes, and preferences across all your devices.
                    </p>

                    {sent ? (
                        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-6 w-full animate-in fade-in slide-in-from-bottom-4">
                            <div className="w-12 h-12 bg-emerald-500 rounded-full flex items-center justify-center mx-auto mb-3 shadow-lg shadow-emerald-500/20">
                                <CheckIcon className="w-6 h-6 text-white" />
                            </div>
                            <h3 className="text-white font-bold mb-1">Check your email</h3>
                            <p className="text-xs text-emerald-200/80 mb-4">We've sent a magic link to <br/> <span className="font-bold text-white">{email}</span></p>
                            
                            {isLocalhost && (
                                <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg p-3 mb-4 text-left flex gap-3">
                                    <AlertTriangleIcon className="w-5 h-5 text-orange-400 shrink-0" />
                                    <div className="text-[10px] text-orange-200 leading-relaxed">
                                        <strong>Testing on mobile?</strong><br/>
                                        The link in your email points to <code>localhost</code>. If you open it on your phone, it will fail. Open the link on this computer, or access the app via your computer's IP address (e.g. 192.168.x.x) before logging in.
                                    </div>
                                </div>
                            )}

                            <p className="text-[10px] text-gray-500 mb-4">Click the link in your email to automatically sign in.</p>
                            <button onClick={onClose} className="w-full py-2 bg-white/10 hover:bg-white/20 rounded-lg text-xs font-bold text-white transition-colors">Close</button>
                        </div>
                    ) : (
                        <form onSubmit={handleLogin} className="w-full space-y-4">
                            <div className="text-left">
                                <label className="text-[10px] uppercase font-bold text-gray-500 mb-1.5 ml-1 block">Email Address</label>
                                <input 
                                    type="email" 
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="captain@vessel.com" 
                                    className="w-full bg-slate-900 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none transition-colors"
                                    required
                                    autoFocus
                                />
                            </div>

                            {isLocalhost && (
                                <div className="text-[10px] text-gray-500 bg-white/5 p-2 rounded text-center">
                                    Link redirects to: <span className="font-mono text-sky-400">{origin}</span>
                                </div>
                            )}

                            {error && (
                                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-200">
                                    {error}
                                </div>
                            )}

                            <button 
                                type="submit" 
                                disabled={loading || !supabase}
                                className={`w-full py-3.5 bg-white text-slate-900 font-bold rounded-xl shadow-lg transition-all active:scale-95 flex items-center justify-center gap-2 ${!supabase ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100'}`}
                            >
                                {loading ? <div className="w-4 h-4 border-2 border-slate-900 border-t-transparent rounded-full animate-spin"/> : "Send Magic Link"}
                            </button>
                            
                            {!supabase && (
                                <p className="text-[10px] text-red-400 mt-2">Database not configured. Keys missing.</p>
                            )}
                        </form>
                    )}
                </div>
                
                <div className="bg-black/20 p-4 border-t border-white/5 flex items-center justify-center gap-6">
                    <div className="flex items-center gap-2 text-[10px] text-gray-500 font-medium">
                        <DiamondIcon className="w-3 h-3 text-indigo-400" /> Pro Sync
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-gray-500 font-medium">
                        <BoatIcon className="w-3 h-3 text-sky-400" /> Fleet Data
                    </div>
                </div>
            </div>
        </div>
    );
};
