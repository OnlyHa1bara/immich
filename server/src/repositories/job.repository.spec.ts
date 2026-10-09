import { ModuleRef } from '@nestjs/core';
import { vitest } from 'vitest';
import { JobName, QueueName } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';

type WorkerMock = {
  name: string;
  processor: (job: any) => Promise<void>;
  options: unknown;
};

const workerMocks = vitest.hoisted(() => ({ instances: [] as WorkerMock[] }));

const getProcessor = (queueName: QueueName) => {
  const worker = workerMocks.instances.find((item) => item.name === queueName);
  if (!worker) {
    throw new Error(`Missing worker for queue: ${queueName}`);
  }

  return worker.processor;
};

vitest.mock(import('bullmq'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    Worker: new Proxy(actual.Worker, {
      construct(_target, [name, processor, options]) {
        workerMocks.instances.push({ name, processor, options });
        return {};
      },
    }),
  };
});

describe(JobRepository.name, () => {
  let sut: JobRepository;
  let env = mockEnvData({});
  let emit: ReturnType<typeof vitest.fn>;
  let warn: ReturnType<typeof vitest.fn>;
  let error: ReturnType<typeof vitest.fn>;

  const job = {
    id: 'job-123',
    name: JobName.VersionCheck,
    data: { secret: 'do-not-log' },
  };

  beforeEach(() => {
    vitest.useFakeTimers();
    workerMocks.instances.length = 0;
    env = mockEnvData({});
    emit = vitest.fn().mockResolvedValue(undefined);
    warn = vitest.fn();
    error = vitest.fn();

    sut = new JobRepository(
      { get: vitest.fn() } as unknown as ModuleRef,
      { getEnv: vitest.fn(() => env) } as unknown as ConfigRepository,
      { emit } as unknown as EventRepository,
      { debug: vitest.fn(), error, setContext: vitest.fn(), warn } as unknown as LoggingRepository,
    );
  });

  afterEach(() => {
    vitest.clearAllTimers();
    vitest.useRealTimers();
  });

  it('should wire each worker processor through the watchdog and clean up timers after completion', async () => {
    env = mockEnvData({ job: { timeoutWarnMs: 50, timeoutMs: 100 } });
    sut.startWorkers();

    await getProcessor(QueueName.BackgroundTask)(job);

    expect(emit).toHaveBeenCalledWith('JobRun', QueueName.BackgroundTask, job);
    expect(vitest.getTimerCount()).toBe(0);

    await vitest.advanceTimersByTimeAsync(100);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('should warn, reject at the hard timeout, and safely handle a late operation settle', async () => {
    env = mockEnvData({ job: { timeoutWarnMs: 50, timeoutMs: 100 } });
    const pending = Promise.withResolvers<void>();
    emit.mockReturnValue(pending.promise);
    sut.startWorkers();

    const result = getProcessor(QueueName.BackgroundTask)(job);
    const failure = expect(result).rejects.toThrow('Job execution exceeded the timeout threshold');

    await vitest.advanceTimersByTimeAsync(50);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/queue=backgroundTask, jobId=job-123, jobName=VersionCheck, elapsedMs=\d+, thresholdMs=50/),
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('do-not-log'));

    await vitest.advanceTimersByTimeAsync(50);
    await failure;
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        /queue=backgroundTask, jobId=job-123, jobName=VersionCheck, elapsedMs=\d+, thresholdMs=100/,
      ),
    );
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('do-not-log'));
    expect(vitest.getTimerCount()).toBe(0);

    pending.resolve();
    await Promise.resolve();
    await vitest.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('should propagate an operation rejection and clean up both watchdog timers', async () => {
    env = mockEnvData({ job: { timeoutWarnMs: 50, timeoutMs: 100 } });
    const operationError = new Error('operation failed');
    emit.mockRejectedValue(operationError);
    sut.startWorkers();

    await expect(getProcessor(QueueName.BackgroundTask)(job)).rejects.toBe(operationError);

    expect(vitest.getTimerCount()).toBe(0);
    await vitest.advanceTimersByTimeAsync(1000);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('should consume an operation rejection arriving after the watchdog timeout', async () => {
    env = mockEnvData({ job: { timeoutWarnMs: 50, timeoutMs: 100 } });
    const pending = Promise.withResolvers<void>();
    emit.mockReturnValue(pending.promise);
    sut.startWorkers();

    const result = getProcessor(QueueName.BackgroundTask)(job);
    const failure = expect(result).rejects.toThrow('Job execution exceeded the timeout threshold');
    await vitest.advanceTimersByTimeAsync(100);
    await failure;

    pending.reject(new Error('late operation failed'));
    await vitest.advanceTimersByTimeAsync(1000);

    expect(vitest.getTimerCount()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('should disable both watchdog timers when configured as zero', async () => {
    env = mockEnvData({ job: { timeoutWarnMs: 0, timeoutMs: 0 } });
    const pending = Promise.withResolvers<void>();
    emit.mockReturnValue(pending.promise);
    sut.startWorkers();

    const result = getProcessor(QueueName.BackgroundTask)(job);
    await vitest.advanceTimersByTimeAsync(1000);

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(vitest.getTimerCount()).toBe(0);

    pending.resolve();
    await expect(result).resolves.toBeUndefined();
  });

  it('should keep the full storage template migration exempt from hard timeouts', async () => {
    env = mockEnvData({ job: { timeoutWarnMs: 10, timeoutMs: 20 } });
    const pending = Promise.withResolvers<void>();
    emit.mockReturnValue(pending.promise);
    sut.startWorkers();

    const result = getProcessor(QueueName.StorageTemplateMigration)({
      id: 'migration-123',
      name: JobName.StorageTemplateMigration,
      data: {},
    });
    await vitest.advanceTimersByTimeAsync(10);
    expect(warn).toHaveBeenCalledTimes(1);

    await vitest.advanceTimersByTimeAsync(100);

    expect(error).not.toHaveBeenCalled();
    pending.resolve();
    await expect(result).resolves.toBeUndefined();
  });
});
