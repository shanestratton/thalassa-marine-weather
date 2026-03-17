/**
 * Type stub for @nicklucas/capacitor-udp.
 * Allows the build to pass before the package is installed.
 * Install the real package before deploying to device:
 *   npm install @nicklucas/capacitor-udp && npx cap sync
 */
declare module '@nicklucas/capacitor-udp' {
    interface UdpSocketPlugin {
        create(): Promise<{ socketId: number }>;
        send(options: { socketId: number; address: string; port: number; buffer: string }): Promise<void>;
        close(options: { socketId: number }): Promise<void>;
    }
    export const UdpSocket: UdpSocketPlugin;
}
