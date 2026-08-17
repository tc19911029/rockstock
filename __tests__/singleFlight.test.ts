import { createSingleFlightRunner } from '@/lib/scheduler/singleFlight';

describe('createSingleFlightRunner', () => {
  test('相同 key 的重疊呼叫只執行一次', async () => {
    const joined: string[] = [];
    const run = createSingleFlightRunner(key => joined.push(key));
    let executions = 0;
    let release: ((value: number) => void) | undefined;
    const task = () => {
      executions++;
      return new Promise<number>(resolve => { release = resolve; });
    };

    const first = run('realtime-scan', task);
    const second = run('realtime-scan', task);
    expect(executions).toBe(1);
    expect(joined).toEqual(['realtime-scan']);
    release?.(42);
    await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);
  });

  test('失敗後會釋放 key，下一輪可重試', async () => {
    const run = createSingleFlightRunner();
    let executions = 0;
    await expect(run('l2', async () => {
      executions++;
      throw new Error('temporary failure');
    })).rejects.toThrow('temporary failure');

    await expect(run('l2', async () => {
      executions++;
      return 'recovered';
    })).resolves.toBe('recovered');
    expect(executions).toBe(2);
  });

  test('不同 key 仍可並行', async () => {
    const run = createSingleFlightRunner();
    const values = await Promise.all([
      run('TW', async () => 'tw'),
      run('CN', async () => 'cn'),
    ]);
    expect(values).toEqual(['tw', 'cn']);
  });
});
