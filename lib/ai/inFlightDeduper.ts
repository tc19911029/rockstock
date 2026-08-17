/**
 * 讓相同 key 的昂貴工作共用同一個 Promise。
 * 任務完成或失敗後會自動清除，下一次請求才能真的重跑。
 */
export class InFlightDeduper<K, V> {
  private readonly tasks = new Map<K, Promise<V>>();

  get(key: K): Promise<V> | undefined {
    return this.tasks.get(key);
  }

  run(key: K, create: () => Promise<V>): { promise: Promise<V>; shared: boolean } {
    const existing = this.tasks.get(key);
    if (existing) return { promise: existing, shared: true };

    const promise = Promise.resolve().then(create);
    this.tasks.set(key, promise);
    void promise.then(
      () => this.clearIfCurrent(key, promise),
      () => this.clearIfCurrent(key, promise),
    );
    return { promise, shared: false };
  }

  private clearIfCurrent(key: K, promise: Promise<V>): void {
    if (this.tasks.get(key) === promise) this.tasks.delete(key);
  }
}
