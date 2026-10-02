// Screen/SDK fixtures only. No native plugin, live Auth or E2EE is exercised.
// No cache writes through the shared dependency symlink on this 8 GB Mac.
export default {
    esbuild: { jsx: 'automatic' },
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['./tests/setup.ts'],
        include: [
            'tests/PrivateMessagePilot.test.ts',
            'tests/NativePrivateMessagePilot.test.ts',
            'tests/hooks/ChatDMEncryptionPilot.test.tsx',
            'tests/hooks/ChatDMBlocking.test.tsx',
            'tests/ChatPage.test.tsx',
            'tests/ChatSelfConversation.test.tsx',
        ],
        testTimeout: 20000,
        hookTimeout: 20000,
        maxWorkers: 1,
        fileParallelism: false,
        cache: false,
    },
};
