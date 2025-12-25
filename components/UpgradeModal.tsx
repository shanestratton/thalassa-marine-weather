
import React from 'react';
import { XIcon, DiamondIcon, CheckIcon, StarIcon, RouteIcon, ServerIcon, LockIcon } from './Icons';

interface UpgradeModalProps {
    isOpen: boolean;
    onClose: () => void;
    onUpgrade: () => void;
}

const FeatureRow = ({ icon, title, desc }: { icon: React.ReactNode, title: string, desc: string }) => (
    <div className="flex items-start gap-4 p-4 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors">
        <div className="p-2 rounded-lg bg-sky-500/20 text-sky-300 shrink-0">
            {icon}
        </div>
        <div>
            <h4 className="text-white font-bold text-sm">{title}</h4>
            <p className="text-xs text-gray-400 mt-1 leading-relaxed">{desc}</p>
        </div>
    </div>
);

export const UpgradeModal: React.FC<UpgradeModalProps> = ({ isOpen, onClose, onUpgrade }) => {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/90 backdrop-blur-md transition-opacity" onClick={onClose} />
            
            <div className="relative bg-[#0f172a] w-full max-w-lg rounded-3xl overflow-hidden border border-white/10 shadow-2xl flex flex-col max-h-[90vh]">
                
                {/* Header Image/Gradient */}
                <div className="relative h-40 bg-gradient-to-br from-sky-900 via-blue-900 to-slate-900 flex items-center justify-center overflow-hidden">
                    <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1534008753122-a83776b29f6c?q=80&w=2070&auto=format&fit=crop')] bg-cover bg-center opacity-30"></div>
                    <div className="absolute inset-0 bg-gradient-to-t from-[#0f172a] to-transparent"></div>
                    
                    <div className="relative z-10 text-center">
                        <div className="w-16 h-16 mx-auto bg-sky-500 rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(14,165,233,0.5)] mb-3">
                            <DiamondIcon className="w-8 h-8 text-white" />
                        </div>
                        <h2 className="text-2xl font-bold text-white tracking-tight">Thalassa <span className="text-sky-400">Pro</span></h2>
                    </div>

                    <button onClick={onClose} className="absolute top-4 right-4 p-2 bg-black/20 hover:bg-black/40 rounded-full text-white/70 hover:text-white transition-colors z-20">
                        <XIcon className="w-5 h-5" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 overflow-y-auto custom-scrollbar">
                    <div className="text-center mb-6">
                        <h3 className="text-xl font-medium text-white mb-2">Unlock Professional Intelligence</h3>
                        <p className="text-sm text-gray-400">Upgrade for computational routing, extended forecasts, and advanced marine insights.</p>
                    </div>

                    <div className="space-y-3 mb-8">
                        <FeatureRow 
                            icon={<RouteIcon className="w-5 h-5"/>}
                            title="Voyage Route Planner" 
                            desc="Smart-calculated routes with waypoints, hazards, and safe anchorage recommendations." 
                        />
                        <FeatureRow 
                            icon={<ServerIcon className="w-5 h-5"/>}
                            title="Captain's Log & Audio" 
                            desc="Natural language analysis of conditions and audio broadcast briefings." 
                        />
                         <FeatureRow 
                            icon={<StarIcon className="w-5 h-5"/>}
                            title="10-Day Extended Forecast" 
                            desc="Unlock the full 10-day outlook with high-resolution hourly trends." 
                        />
                    </div>

                    {/* Pricing */}
                    <div className="bg-sky-500/10 border border-sky-500/30 rounded-2xl p-4 text-center mb-6 relative overflow-hidden">
                        <div className="absolute top-0 right-0 bg-sky-500 text-white text-[10px] font-bold px-2 py-1 rounded-bl-lg">BEST VALUE</div>
                        <p className="text-sm text-gray-400 mb-1">Annual Subscription</p>
                        <p className="text-3xl font-bold text-white mb-1">$99.99<span className="text-sm font-normal text-gray-400">/year</span></p>
                        <p className="text-xs text-sky-300">Less than $8.50/month</p>
                    </div>

                    <button 
                        onClick={() => {
                            onUpgrade();
                            onClose();
                        }}
                        className="w-full py-4 bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500 text-white font-bold rounded-xl shadow-lg shadow-sky-900/40 transition-all active:scale-95 flex items-center justify-center gap-2"
                    >
                        <LockIcon className="w-5 h-5" />
                        Start 7-Day Free Trial
                    </button>
                    
                    <button className="w-full mt-3 py-2 text-xs text-gray-500 hover:text-white transition-colors">
                        Restore Purchases
                    </button>
                </div>
            </div>
        </div>
    );
};
