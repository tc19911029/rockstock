import {
  isTranscriptionActive,
  withTranscriptionLock,
} from '@/lib/youtube/transcriptionLock';

describe('withTranscriptionLock', () => {
  it('serializes Taiwan and China Whisper jobs through one queue', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withTranscriptionLock(async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = withTranscriptionLock(async () => {
      order.push('second:start');
      order.push('second:end');
    });

    await Promise.resolve();
    expect(isTranscriptionActive()).toBe(true);
    expect(order).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(isTranscriptionActive()).toBe(false);
  });

  it('releases the queue when a job throws', async () => {
    await expect(withTranscriptionLock(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    await expect(withTranscriptionLock(async () => 'next')).resolves.toBe('next');
    expect(isTranscriptionActive()).toBe(false);
  });
});
