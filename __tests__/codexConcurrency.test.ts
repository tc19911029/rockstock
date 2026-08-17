import { CodexConcurrencyScheduler, type CodexQueueProgress } from '@/lib/ai/codexConcurrency';

describe('CodexConcurrencyScheduler', () => {
  test('前三個工作立即執行，第四個依 FIFO 排隊', async () => {
    const scheduler = new CodexConcurrencyScheduler(3);
    const release1 = await scheduler.acquire();
    const release2 = await scheduler.acquire();
    const release3 = await scheduler.acquire();
    const progress: CodexQueueProgress[] = [];
    const fourth = scheduler.acquire({ onProgress: value => progress.push(value) });

    expect(scheduler.snapshot()).toEqual({
      activeCount: 3,
      queuedCount: 1,
      maxConcurrent: 3,
    });
    expect(progress.at(-1)).toMatchObject({ state: 'queued', queuePosition: 1 });

    release2();
    const release4 = await fourth;
    expect(progress.at(-1)).toMatchObject({ state: 'running', queuePosition: null });
    expect(scheduler.snapshot().activeCount).toBe(3);

    release1();
    release3();
    release4();
    expect(scheduler.snapshot()).toEqual({
      activeCount: 0,
      queuedCount: 0,
      maxConcurrent: 3,
    });
  });

  test('前方工作開始後會更新後續工作的排隊順位', async () => {
    const scheduler = new CodexConcurrencyScheduler(1);
    const release1 = await scheduler.acquire();
    const secondProgress: CodexQueueProgress[] = [];
    const thirdProgress: CodexQueueProgress[] = [];
    const second = scheduler.acquire({ onProgress: value => secondProgress.push(value) });
    const third = scheduler.acquire({ onProgress: value => thirdProgress.push(value) });

    expect(thirdProgress.at(-1)?.queuePosition).toBe(2);
    release1();
    const release2 = await second;
    expect(thirdProgress.at(-1)).toMatchObject({ state: 'queued', queuePosition: 1 });
    release2();
    const release3 = await third;
    release3();
  });

  test('排隊中的工作取消後會移除並更新順位', async () => {
    const scheduler = new CodexConcurrencyScheduler(1);
    const release = await scheduler.acquire();
    const controller = new AbortController();
    const cancelled = scheduler.acquire({ signal: controller.signal });
    const remainingProgress: CodexQueueProgress[] = [];
    const remaining = scheduler.acquire({ onProgress: value => remainingProgress.push(value) });

    expect(remainingProgress.at(-1)?.queuePosition).toBe(2);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(remainingProgress.at(-1)?.queuePosition).toBe(1);

    release();
    const remainingRelease = await remaining;
    remainingRelease();
  });
});
