const mockDisconnectDB = jest.fn().mockResolvedValue();
const mockConnectDB = jest.fn().mockResolvedValue();
const mockApp = {
  listen: jest.fn(),
  set: jest.fn(),
};
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../src/app', () => mockApp);
jest.mock('../src/config/env', () => ({ port: 0 }));
jest.mock('../src/config/db', () => ({
  connectDB: mockConnectDB,
  disconnectDB: mockDisconnectDB,
}));
jest.mock('../src/utils/logger', () => mockLogger);
jest.mock('../src/config/fixIndexes', () => ({
  fixSparseCompoundIndexes: jest.fn().mockResolvedValue(),
}));
jest.mock('../src/services/batch.service', () => ({
  normalizeExpiryProducts: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/services/delivery/realtime.hub', () => ({
  closeAll: jest.fn(),
}));

describe('API graceful shutdown', () => {
  test('closes HTTP server before disconnecting MongoDB', async () => {
    let closeCallback;
    const fakeServer = {
      close: jest.fn((callback) => {
        closeCallback = callback;
      }),
    };

    mockApp.listen.mockReturnValue(fakeServer);

    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined);

    const previousListeners = process.listeners('SIGTERM').length;
    const previousRunJobs = process.env.RUN_JOBS;
    process.env.RUN_JOBS = 'false';

    try {
      jest.isolateModules(() => {
        require('../src/server');
      });

      await new Promise(setImmediate);
      await new Promise(setImmediate);

      expect(mockConnectDB).toHaveBeenCalledTimes(1);
      expect(mockApp.listen).toHaveBeenCalledTimes(1);

      const handler = process.listeners('SIGTERM')[previousListeners];
      expect(handler).toBeDefined();

      handler();

      expect(fakeServer.close).toHaveBeenCalledTimes(1);
      expect(mockDisconnectDB).not.toHaveBeenCalled();

      closeCallback();

      await new Promise(setImmediate);

      expect(mockDisconnectDB).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      if (previousRunJobs === undefined) {
        delete process.env.RUN_JOBS;
      } else {
        process.env.RUN_JOBS = previousRunJobs;
      }

      process.removeListener(
        'SIGTERM',
        process.listeners('SIGTERM')[previousListeners]
      );
      process.removeListener(
        'SIGINT',
        process.listeners('SIGINT').at(-1)
      );
      exitSpy.mockRestore();
    }
  });
});
