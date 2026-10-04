// Research-only configuration: no app setup and no cache through shared dependencies.
export default {
    test: {
        environment: 'node',
        setupFiles: [],
        include: [
            'tests/DirectMessageEnvelope.test.ts',
            'tests/EncryptedDmDelivery.test.ts',
            'tests/E2eeResearchDeviceBundle.test.ts',
            'tests/E2eeResearchGateway.test.ts',
            'tests/E2eeResearchSignedGateway.test.ts',
            'tests/E2eeResearchSupabaseAuth.test.ts',
            'tests/E2eeResearchHttpGateway.test.ts',
            'tests/E2eeHostedGateway.test.ts',
            'tests/ResearchRelayPolicy.test.ts',
            'tests/E2eePilotBridgeAuth.test.ts',
            'tests/E2eePilotBridgeMessaging.test.ts',
            'tests/E2eeResearchDeviceSigning.test.ts',
            'tests/E2eeResearchLaunchLifecycle.test.ts',
            'tests/E2eeResearchNativePath.test.ts',
        ],
        maxWorkers: 1,
        fileParallelism: false,
        cache: false,
    },
};
