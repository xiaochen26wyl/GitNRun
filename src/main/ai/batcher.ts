/**
 * 把短時間內、同一個 key 的多筆請求合併成一次處理（例如同一專案連續幾次推送只問 AI 一次）。
 * 時間窗內第一筆請求開始計時；時間到，所有等待的人拿到同一個結果。窗口為 0 就不合併。
 */

export interface Batcher<K, I, R> {
  submit(key: K, item: I): Promise<R>;
}

export interface BatcherOptions<K, I, R> {
  windowMs: () => number;
  run: (key: K, items: I[]) => Promise<R>;
  schedule?: (fn: () => void, ms: number) => void;
}

interface Waiter<I, R> {
  items: I[];
  resolvers: Array<{ resolve: (value: R) => void; reject: (reason: unknown) => void }>;
}

export const createBatcher = <K, I, R>(options: BatcherOptions<K, I, R>): Batcher<K, I, R> => {
  const schedule = options.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref());
  const open = new Map<K, Waiter<I, R>>();

  return {
    submit(key, item) {
      const windowMs = options.windowMs();
      if (windowMs <= 0) {
        return options.run(key, [item]);
      }

      return new Promise<R>((resolve, reject) => {
        const existing = open.get(key);
        if (existing) {
          existing.items.push(item);
          existing.resolvers.push({ resolve, reject });
          return;
        }

        const batch: Waiter<I, R> = { items: [item], resolvers: [{ resolve, reject }] };
        open.set(key, batch);
        schedule(() => {
          open.delete(key);
          options.run(key, batch.items).then(
            (result) => batch.resolvers.forEach((waiter) => waiter.resolve(result)),
            (error: unknown) => batch.resolvers.forEach((waiter) => waiter.reject(error))
          );
        }, windowMs);
      });
    }
  };
};
