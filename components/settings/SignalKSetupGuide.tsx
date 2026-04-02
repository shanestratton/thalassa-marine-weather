/**
 * SignalKSetupGuide — Step-by-step Pi setup guide for Signal K charts.
 *
 * Shown inline within the Signal K settings tab.
 * Covers both Path A (free government charts) and Path B (encrypted o-charts).
 */
import React, { useState } from 'react';

type GuidePath = 'free' | 'ocharts';

export const SignalKSetupGuide: React.FC = () => {
    const [expanded, setExpanded] = useState(false);
    const [activePath, setActivePath] = useState<GuidePath>('free');

    if (!expanded) {
        return (
            <button
                onClick={() => setExpanded(true)}
                className="w-full rounded-2xl bg-gradient-to-br from-emerald-500/10 to-sky-500/10 border border-emerald-500/20 p-4 text-left transition-all hover:border-emerald-500/40 active:scale-[0.99]"
            >
                <div className="flex items-center gap-2">
                    <span className="text-lg">📖</span>
                    <span className="text-sm font-bold text-emerald-300 flex-1">Pi Setup Guide</span>
                    <span className="text-[11px] text-gray-500 uppercase tracking-wider">Tap to expand</span>
                    <svg
                        className="w-4 h-4 text-gray-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                </div>
                <p className="text-[11px] text-gray-400 mt-1 ml-7">
                    Complete walkthrough for setting up Signal K and nautical charts on your Raspberry Pi
                </p>
            </button>
        );
    }

    return (
        <div className="rounded-2xl bg-gradient-to-br from-emerald-500/[0.06] to-sky-500/[0.06] border border-emerald-500/20 overflow-hidden">
            {/* Header */}
            <button
                onClick={() => setExpanded(false)}
                className="w-full flex items-center gap-2 px-4 py-3 text-left border-b border-white/[0.06] hover:bg-white/[0.03] transition-all"
            >
                <span className="text-lg">📖</span>
                <span className="text-sm font-bold text-emerald-300 flex-1">Pi Setup Guide</span>
                <svg
                    className="w-4 h-4 text-gray-500 rotate-180"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            <div className="p-4 space-y-4">
                {/* What You Need */}
                <div>
                    <h4 className="text-[11px] font-black text-white/70 uppercase tracking-[0.15em] mb-2">
                        What You Need
                    </h4>
                    <div className="space-y-1.5">
                        <CheckItem text="Raspberry Pi 4 (2GB+ RAM) with Signal K HAT or USB" />
                        <CheckItem text="Signal K server installed (via OpenPlotter or standalone)" />
                        <CheckItem text="Pi connected to your vessel's WiFi network" />
                        <CheckItem text="Thalassa on a device connected to the same network" />
                    </div>
                </div>

                {/* Path Selector */}
                <div>
                    <h4 className="text-[11px] font-black text-white/70 uppercase tracking-[0.15em] mb-2">
                        Choose Your Chart Source
                    </h4>
                    <div className="flex gap-2">
                        <button
                            onClick={() => setActivePath('free')}
                            className={`flex-1 px-3 py-2.5 rounded-xl text-xs font-bold border transition-all ${
                                activePath === 'free'
                                    ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                                    : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:bg-white/[0.06]'
                            }`}
                        >
                            <span className="block text-sm mb-0.5">🆓</span>
                            Free Gov't Charts
                            <span className="block text-[10px] font-normal mt-0.5 text-gray-500">
                                NOAA · LINZ · CHS
                            </span>
                        </button>
                        <button
                            onClick={() => setActivePath('ocharts')}
                            className={`flex-1 px-3 py-2.5 rounded-xl text-xs font-bold border transition-all ${
                                activePath === 'ocharts'
                                    ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                                    : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:bg-white/[0.06]'
                            }`}
                        >
                            <span className="block text-sm mb-0.5">🔐</span>
                            o-charts (Paid)
                            <span className="block text-[10px] font-normal mt-0.5 text-gray-500">AHO · UKHO · BSH</span>
                        </button>
                    </div>
                </div>

                {/* Path A: Free Charts */}
                {activePath === 'free' && (
                    <div className="space-y-3">
                        <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-3 py-2">
                            <p className="text-[11px] text-emerald-300 font-bold">
                                ✅ Easiest path — no DRM, no OpenCPN needed
                            </p>
                        </div>

                        <Step number={1} title="Install the chart plugin on Signal K">
                            <Code>
                                {`# On your Pi, open Signal K Admin UI
# Navigate to: Appstore → Search
# Install: signalk-charts-provider-simple

# Or via command line:
cd ~/.signalk
npm install signalk-charts-provider-simple`}
                            </Code>
                        </Step>

                        <Step number={2} title="Download free charts">
                            <p className="text-[11px] text-gray-400 mb-2">
                                Download S-57 ENC files from your government hydrographic office:
                            </p>
                            <div className="space-y-1">
                                <LinkItem flag="🇺🇸" label="NOAA (US waters)" url="charts.noaa.gov/ENCs/ENCs.shtml" />
                                <LinkItem flag="🇳🇿" label="LINZ (NZ waters)" url="data.linz.govt.nz" />
                                <LinkItem
                                    flag="🇨🇦"
                                    label="CHS (Canadian waters)"
                                    url="charts.gc.ca/charts-cartes/enc"
                                />
                                <LinkItem
                                    flag="🇬🇧"
                                    label="ADMIRALTY (UK waters)"
                                    url="admiralty.co.uk"
                                    note="Some free"
                                />
                                <LinkItem
                                    flag="🇦🇺"
                                    label="AHO (AU waters)"
                                    url="hydro.gov.au"
                                    note="Paid — see o-charts path"
                                />
                            </div>
                        </Step>

                        <Step number={3} title="Convert to MBTiles">
                            <p className="text-[11px] text-gray-400 mb-2">
                                Convert the downloaded S-57 .000 files to MBTiles format:
                            </p>
                            <Code>
                                {`# Install GDAL on your Pi
sudo apt install gdal-bin

# Convert S-57 to GeoTIFF, then to MBTiles
ogr2ogr -f "MBTiles" chart.mbtiles chart.000

# Or use the excellent s57-tiler tool
pip install s57-tiler
s57-tiler convert --input chart.000 --output chart.mbtiles`}
                            </Code>
                        </Step>

                        <Step number={4} title="Drop charts into Signal K">
                            <Code>
                                {`# Copy your .mbtiles files to Signal K charts dir
cp chart.mbtiles ~/.signalk/charts/

# Restart Signal K
sudo systemctl restart signalk`}
                            </Code>
                        </Step>

                        <Step number={5} title="Connect from Thalassa">
                            <div className="space-y-1">
                                <CheckItem text="Enter your Pi's IP address above (e.g. 192.168.1.50)" />
                                <CheckItem text="Tap Connect — status should show 🟢 Connected" />
                                <CheckItem text="Charts will appear in the list above" />
                                <CheckItem text="Go to MAP → Layer menu → toggle charts on" />
                            </div>
                        </Step>
                    </div>
                )}

                {/* Path B: o-charts (encrypted) */}
                {activePath === 'ocharts' && (
                    <div className="space-y-3">
                        <div className="rounded-xl bg-amber-500/10 border border-amber-500/20 px-3 py-2">
                            <p className="text-[11px] text-amber-300 font-bold">
                                🔐 AvNav handles everything — no OpenCPN needed
                            </p>
                        </div>

                        <Step number={1} title="Install AvNav on your Pi">
                            <p className="text-[11px] text-gray-400 mb-2">
                                AvNav runs headless on the Pi and handles chart decryption, rendering, and tile serving
                                in one package.
                            </p>
                            <Code>
                                {`# Install AvNav
sudo apt update
sudo apt install avnav

# Or use the AvNav installer image:
# https://www.wellenvogel.net/software/avnav/docs/install.html

# Start AvNav as a service
sudo systemctl enable avnav
sudo systemctl start avnav`}
                            </Code>
                        </Step>

                        <Step number={2} title="Install the oeSENC plugin">
                            <p className="text-[11px] text-gray-400 mb-2">
                                This gives AvNav the ability to decrypt encrypted o-charts:
                            </p>
                            <Code>
                                {`# Install the oeSENC plugin for AvNav
sudo apt install avnav-oesenc

# Restart AvNav
sudo systemctl restart avnav`}
                            </Code>
                        </Step>

                        <Step number={3} title="Buy & activate o-charts">
                            <div className="space-y-1.5">
                                <CheckItem text="Visit o-charts.org and create an account" />
                                <CheckItem text="Register your Pi's fingerprint (AvNav generates this)" />
                                <CheckItem text="Purchase your region (e.g. AU — Coral Sea, ~$50-80/yr)" />
                                <CheckItem text="Download the .oesenc chart files" />
                                <CheckItem text="Copy charts to AvNav's chart directory on the Pi" />
                            </div>
                            <Code>
                                {`# Copy downloaded charts to AvNav
cp ~/Downloads/*.oesenc /home/pi/avnav/data/charts/

# AvNav auto-discovers and decrypts the charts
# Verify at http://your-pi-ip:8080`}
                            </Code>
                        </Step>

                        <Step number={4} title="Bridge tiles to Signal K">
                            <p className="text-[11px] text-gray-400 mb-2">
                                AvNav serves tiles at its own HTTP endpoint. Install the chart provider plugin on Signal
                                K to bridge them:
                            </p>
                            <Code>
                                {`# Install chart provider on Signal K
cd ~/.signalk
npm install signalk-charts-provider-simple

# Configure it to proxy AvNav's tile output
# Signal K Admin → Plugin Config → Charts Provider
# Add URL source: http://localhost:8080/tiles`}
                            </Code>
                        </Step>

                        <Step number={5} title="Connect from Thalassa">
                            <div className="space-y-1">
                                <CheckItem text="Enter your Pi's IP address above" />
                                <CheckItem text="Tap Connect — charts should be discovered" />
                                <CheckItem text="Go to MAP → Layer menu → toggle your chart on" />
                                <CheckItem text="Adjust opacity slider to blend with satellite" />
                            </div>
                        </Step>

                        <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-3 py-2">
                            <p className="text-[11px] text-amber-300 font-bold mb-1">💡 Pro Tip</p>
                            <p className="text-[10px] text-gray-400">
                                Once set up, chart updates are simple — buy the update on o-charts.org, copy the new
                                files to the Pi, and AvNav picks them up automatically. No changes needed in Thalassa.
                            </p>
                        </div>
                    </div>
                )}

                {/* Troubleshooting */}
                <div className="border-t border-white/[0.06] pt-3">
                    <h4 className="text-[11px] font-black text-white/70 uppercase tracking-[0.15em] mb-2">
                        Troubleshooting
                    </h4>
                    <div className="space-y-2">
                        <TroubleItem
                            q="Can't connect to Signal K?"
                            a="Make sure your phone/tablet is on the same WiFi as the Pi. Try the Pi's IP address instead of 'signalk.local' (find it with 'hostname -I' on the Pi)."
                        />
                        <TroubleItem
                            q="Connected but no charts?"
                            a="Check that the charts-provider-simple plugin is installed and enabled in Signal K Admin → Server → Plugin Config. Make sure .mbtiles files are in the configured directory."
                        />
                        <TroubleItem
                            q="Charts look blurry?"
                            a="Zoom in — raster charts have a fixed resolution range. Check the min/max zoom shown in the layer menu. Consider higher-resolution MBTiles if available."
                        />
                        <TroubleItem
                            q="Charts disappear when moving?"
                            a="The chart may have limited coverage bounds. Check if you've moved outside the chart's geographic area. You may need additional chart regions."
                        />
                    </div>
                </div>

                {/* Offshore Backup Strategy */}
                <div className="border-t border-white/[0.06] pt-3">
                    <h4 className="text-[11px] font-black text-white/70 uppercase tracking-[0.15em] mb-2">
                        ⚓ Offshore Backup Strategy
                    </h4>
                    <p className="text-[10px] text-gray-400 mb-3">
                        o-charts are locked to a hardware fingerprint (CPU serial + MAC address). Every Pi is unique —
                        swapping an SD card into a different Pi will lock you out. Here's how to stay covered offshore:
                    </p>

                    <div className="space-y-2">
                        <div className="rounded-lg bg-amber-500/[0.08] border border-amber-500/25 px-3 py-2.5">
                            <div className="flex items-center gap-2 mb-1">
                                <span className="text-sm">🥇</span>
                                <span className="text-[11px] text-amber-300 font-bold">
                                    o-charts USB Dongle (Gold Standard)
                                </span>
                            </div>
                            <p className="text-[10px] text-gray-400 ml-6">
                                Buy the <span className="text-amber-300 font-bold">o-charts USB dongle (€19)</span> from
                                o-charts.org and assign one of your two chart licenses to it instead of the Pi's
                                hardware. The license lives on the dongle, not the CPU. If the Pi dies: plug the dongle
                                + cloned SD card into any spare Pi and the charts decrypt instantly.
                            </p>
                        </div>

                        <div className="rounded-lg bg-sky-500/[0.06] border border-sky-500/15 px-3 py-2.5">
                            <div className="flex items-center gap-2 mb-1">
                                <span className="text-sm">💻</span>
                                <span className="text-[11px] text-sky-300 font-bold">Register 2 Systems</span>
                            </div>
                            <p className="text-[10px] text-gray-400 ml-6">
                                o-charts allows <span className="text-sky-300 font-bold">2 devices per purchase</span>.
                                Register device #1 as the USB dongle (for the Pi) and device #2 as your laptop. If
                                everything fails, run AvNav on your laptop as the last resort.
                            </p>
                        </div>

                        <div className="rounded-lg bg-emerald-500/[0.06] border border-emerald-500/15 px-3 py-2.5">
                            <div className="flex items-center gap-2 mb-1">
                                <span className="text-sm">🆓</span>
                                <span className="text-emerald-300 text-[11px] font-bold">Free Charts Fallback</span>
                            </div>
                            <p className="text-[10px] text-gray-400 ml-6">
                                Download free government ENCs as MBTiles for your passage area and keep them on a USB
                                stick.{' '}
                                <span className="text-emerald-300 font-bold">
                                    No DRM — works on any device, any time.
                                </span>{' '}
                                LINZ has excellent coverage of the NZ/Fiji/Tonga triangle. NOAA covers the Pacific.
                            </p>
                        </div>

                        <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] px-3 py-2.5">
                            <div className="flex items-center gap-2 mb-1">
                                <span className="text-sm">🗺️</span>
                                <span className="text-[11px] text-gray-300 font-bold">
                                    Thalassa Always Has OpenSeaMap
                                </span>
                            </div>
                            <p className="text-[10px] text-gray-400 ml-6">
                                Even with no Pi at all, Thalassa still has the OpenSeaMap "Sea Marks" layer with buoys,
                                lights, and channel markers built in. It's not a full chart, but it's always there.
                            </p>
                        </div>
                    </div>

                    <div className="mt-3 rounded-xl bg-gradient-to-r from-red-500/10 to-amber-500/10 border border-red-500/20 px-3 py-2.5">
                        <p className="text-[11px] text-red-300 font-bold mb-1">🔖 Pre-Departure Checklist</p>
                        <div className="space-y-1">
                            <CheckItem text="Buy o-charts USB dongle (€19) — assign chart license to it" />
                            <CheckItem text="Register laptop as 2nd system on o-charts.org" />
                            <CheckItem text="Clone SD card as backup (works with any Pi + dongle)" />
                            <CheckItem text="Download free ENCs (LINZ/NOAA) for passage area as MBTiles on USB" />
                            <CheckItem text="Test dongle + spare Pi before departure" />
                            <CheckItem text="Store spare Pi + dongle + SD card in waterproof bag" />
                        </div>
                    </div>
                </div>

                {/* Support Links */}
                <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-3 py-2">
                    <p className="text-[10px] text-gray-500">
                        <span className="font-bold text-gray-400">Helpful links: </span>
                        <span className="text-sky-400">signalk.org</span>
                        {' · '}
                        <span className="text-sky-400">wellenvogel.net/avnav</span>
                        {' · '}
                        <span className="text-sky-400">o-charts.org</span>
                        {' · '}
                        <span className="text-sky-400">openplotter.com</span>
                    </p>
                </div>
            </div>
        </div>
    );
};

// ── Sub-components ──

const Step: React.FC<{ number: number; title: string; children: React.ReactNode }> = ({ number, title, children }) => (
    <div>
        <div className="flex items-center gap-2 mb-2">
            <span className="w-5 h-5 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-[10px] font-black text-emerald-400 shrink-0">
                {number}
            </span>
            <h4 className="text-xs font-bold text-white">{title}</h4>
        </div>
        <div className="ml-7">{children}</div>
    </div>
);

const Code: React.FC<{ children: string }> = ({ children }) => (
    <pre className="bg-black/60 rounded-lg px-3 py-2 text-[10px] text-emerald-300/80 font-mono leading-relaxed overflow-x-auto border border-white/[0.06]">
        {children.trim()}
    </pre>
);

const CheckItem: React.FC<{ text: string }> = ({ text }) => (
    <div className="flex items-start gap-2">
        <span className="text-emerald-400 text-[10px] mt-0.5 shrink-0">✓</span>
        <span className="text-[11px] text-gray-300">{text}</span>
    </div>
);

const LinkItem: React.FC<{ flag: string; label: string; url: string; note?: string }> = ({
    flag,
    label,
    url,
    note,
}) => (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/[0.02]">
        <span className="text-sm">{flag}</span>
        <span className="text-[11px] text-white font-bold flex-1">{label}</span>
        {note && <span className="text-[10px] text-amber-400 font-bold">{note}</span>}
        <span className="text-[10px] text-sky-400 font-mono truncate max-w-[140px]">{url}</span>
    </div>
);

const TroubleItem: React.FC<{ q: string; a: string }> = ({ q, a }) => (
    <div className="rounded-lg bg-white/[0.02] px-3 py-2">
        <p className="text-[11px] text-white font-bold">{q}</p>
        <p className="text-[10px] text-gray-400 mt-0.5">{a}</p>
    </div>
);
