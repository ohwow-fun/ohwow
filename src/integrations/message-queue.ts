/**
 * Per-Chat Message Queue
 * Promise-chain-based lock per channel:chatId key.
 * Different chats process concurrently; same chat is serialized.
 */

export class MessageQueue {
  private locks = new Map<string, Promise<void>>();

  async enqueue(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(key, next);
    next.finally(() => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    });
    return next;
  }
}
