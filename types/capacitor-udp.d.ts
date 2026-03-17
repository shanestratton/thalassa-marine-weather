/**
 * Type stub for @frontall/capacitor-udp.
 * Allows the build to pass before the package is installed.
 * Install the real package before deploying to device:
 *   npm install @frontall/capacitor-udp --legacy-peer-deps && npx cap sync
 */
declare module '@frontall/capacitor-udp' {
    interface UdpSocketPlugin {
        create(): Promise<{ socketId: number }>;
        bind(options: { socketId: number; port: number }): Promise<void>;
        send(options: { socketId: number; address: string; port: number; buffer: string }): Promise<void>;
        close(options: { socketId: number }): Promise<void>;
    }
    export const UdpSocket: UdpSocketPlugin;
}
