import { InFlightDeduper } from '@/lib/ai/inFlightDeduper';

describe('InFlightDeduper', () => {
  test('相同 key 的同時請求只執行一次', async () => {
    const deduper = new InFlightDeduper<string, string>();
    let release!: (value: string) => void;
    const task = jest.fn(() => new Promise<string>((resolve) => { release = resolve; }));

    const first = deduper.run('2330:2026-08-17', task);
    const second = deduper.run('2330:2026-08-17', task);

    expect(first.shared).toBe(false);
    expect(second.shared).toBe(true);
    expect(deduper.get('2330:2026-08-17')).toBe(first.promise);
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
    release('done');
    await expect(Promise.all([first.promise, second.promise])).resolves.toEqual(['done', 'done']);
    expect(deduper.get('2330:2026-08-17')).toBeUndefined();
  });

  test('失敗後會釋放 key，允許下一次重試', async () => {
    const deduper = new InFlightDeduper<string, string>();
    await expect(deduper.run('key', async () => { throw new Error('failed'); }).promise)
      .rejects.toThrow('failed');
    await Promise.resolve();

    const retry = jest.fn(async () => 'ok');
    await expect(deduper.run('key', retry).promise).resolves.toBe('ok');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('不同 key 不會被錯誤合併', async () => {
    const deduper = new InFlightDeduper<string, string>();
    const first = deduper.run('2330', async () => 'A');
    const second = deduper.run('2317', async () => 'B');
    await expect(Promise.all([first.promise, second.promise])).resolves.toEqual(['A', 'B']);
    expect(first.shared).toBe(false);
    expect(second.shared).toBe(false);
  });
});
