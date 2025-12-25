
import React, { useState, useEffect } from 'react';
import { ShareIcon, XIcon, PlusSquareIcon } from './Icons';
import { Capacitor } from '@capacitor/core';

export const IOSInstallPrompt = () => {
  const [show, setShow] = useState(false);

  useEffect(() => {
    // 1. If running natively (App Store version), NEVER show this prompt
    if (Capacitor.isNativePlatform()) return;

    // 2. Detect iOS Browser
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
    
    // 3. Detect if already installed as PWA
    // Add optional chaining to window.matchMedia to prevent crashes in environments where it might be missing
    const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || (window.navigator as any).standalone;
    
    // 4. Check dismissal history
    const dismissed = localStorage.getItem('thalassa_install_dismissed');

    if (isIOS && !isStandalone && !dismissed) {
        const t = setTimeout(() => setShow(true), 3000);
        return () => clearTimeout(t);
    }
  }, []);

  const handleDismiss = () => {
      setShow(false);
      localStorage.setItem('thalassa_install_dismissed', 'true');
  }

  if (!show) return null;

  return (
      <div className="fixed bottom-6 left-4 right-4 z-[100] animate-in fade-in slide-in-from-bottom-8 duration-700">
          <div className="bg-slate-900/90 backdrop-blur-xl border border-white/10 rounded-2xl p-4 shadow-2xl relative">
              <button onClick={handleDismiss} className="absolute top-2 right-2 p-2 text-gray-400 hover:text-white transition-colors"><XIcon className="w-4 h-4"/></button>
              <div className="flex gap-4">
                  <div className="w-12 h-12 bg-sky-500 rounded-xl flex items-center justify-center shadow-lg shrink-0">
                        <img src="https://cdn-icons-png.flaticon.com/512/567/567055.png" alt="App Icon" className="w-8 h-8 invert brightness-0" />
                  </div>
                  <div className="flex-1">
                      <h3 className="font-bold text-white text-sm">Install Thalassa</h3>
                      <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                          Install this app on your iPhone for the best experience.
                      </p>
                      <div className="flex items-center gap-2 mt-3 text-xs font-medium text-sky-400">
                          <span>Tap</span>
                          <ShareIcon className="w-4 h-4" />
                          <span>then</span>
                          <span className="flex items-center gap-1 border border-white/20 px-1.5 py-0.5 rounded bg-white/5 text-white">
                              <PlusSquareIcon className="w-3 h-3" /> Add to Home Screen
                          </span>
                      </div>
                  </div>
              </div>
              {/* Arrow pointing down */}
              <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-4 h-4 bg-slate-900/90 border-r border-b border-white/10 transform rotate-45"></div>
          </div>
      </div>
  )
}
