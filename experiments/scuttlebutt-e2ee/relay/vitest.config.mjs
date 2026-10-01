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
        ],
        maxWorkers: 1,
        fileParallelism: false,
        cache: false,
    },
};
