import { createConcurrencyLimiter } from '@/lib/datasource/curlConcurrency';

describe('curl process concurrency guard', () => {
  it('caps the combined number of active subprocess tasks', async () => {
    const limiter = createConcurrencyLimiter(3);
    let active = 0;
    let peak = 0;

    const results = await Promise.all(
      Array.from({ length: 18 }, (_, index) => limiter.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return index;
      })),
    );

    expect(peak).toBe(3);
    expect(results).toEqual(Array.from({ length: 18 }, (_, index) => index));
  });

  it('releases a slot when a task fails', async () => {
    const limiter = createConcurrencyLimiter(1);
    const first = limiter.run(async () => {
      throw new Error('expected failure');
    });
    const second = limiter.run(async () => 'continued');

    await expect(first).rejects.toThrow('expected failure');
    await expect(second).resolves.toBe('continued');
  });

  it('rejects invalid limits', () => {
    expect(() => createConcurrencyLimiter(0)).toThrow('positive integer');
  });
});
