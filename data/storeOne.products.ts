/**
 * Store One — Minimum Viable Storefront product catalog.
 *
 * Mock data for the first three hardware products in the curated chandlery.
 * Backend wiring (Supabase + Stripe Edge Function) lands in the Q3-2026 sprint;
 * this module gives the UI work a stable, typed surface to build against.
 */

export interface StoreOneProduct {
    id: string;
    name: string;
    /** Display price in USD, whole-dollar for MVS. */
    price: number;
    description: string;
    specs: string[];
    /**
     * True if the product needs vessel 12V (or NMEA 2000 bus) power.
     * Drives the "Will this fit your boat?" vessel-aware filter.
     */
    requires_12v: boolean;
}

export const STORE_ONE_PRODUCTS: StoreOneProduct[] = [
    {
        id: 'copperhill-pican-m',
        name: 'Copperhill PiCAN-M Hat',
        price: 89,
        description:
            "NMEA 2000 / CAN-Bus interface board for Raspberry Pi. Bridges your boat's data backbone to the Thalassa Pi — wind, depth, AIS, autopilot and engine telemetry, all streamed into one open stack.",
        specs: [
            'NMEA 2000 micro-C connector + screw-terminal CAN-Bus port',
            'Powered from the NMEA 2000 bus — no extra wiring',
            'Real-time clock with battery backup',
            'Compatible with Raspberry Pi 3B+ / 4 / 5',
            'SocketCAN driver — Linux-native, no proprietary blob',
        ],
        requires_12v: true,
    },
    {
        id: 'xenarc-703wp',
        name: 'Xenarc 703WP Display',
        price: 849,
        description:
            'Seven-inch IP67 waterproof touchscreen, sunlight-readable at 1500+ nits. The cockpit-grade display for the Thalassa Pi — built to take a green-water boarding and keep going.',
        specs: [
            '7" 1024×600 IPS panel, 1500+ nits sunlight readable',
            'IP67 sealed front, capacitive multi-touch',
            'HDMI input + USB-C touch passthrough',
            '12–24 VDC input, 5–18 W typical draw',
            'Bracket + flush-mount kit included',
        ],
        requires_12v: true,
    },
    {
        id: 'calypso-ultrasonic-portable-mini',
        name: 'Calypso Ultrasonic Portable Mini',
        price: 269,
        description:
            'Solid-state Bluetooth wind sensor — no moving parts, no maintenance, no climbing the mast. Solar-powered, mast-clip mounted, streams to the Thalassa Pi over BLE.',
        specs: [
            'Ultrasonic anemometer — apparent wind speed + direction',
            'Bluetooth Low Energy 4.2 streaming',
            'Solar-powered with USB-C top-up port',
            'No moving parts — saltwater-grade IP66',
            'Mast-clip mount, removable for portable use',
        ],
        requires_12v: false,
    },
];
