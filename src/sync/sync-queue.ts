import { db, SyncQueueItem } from "../data/db";
import {
  SphereProductInput,
  SphereProductSyncItem,
} from "../extraction/bandago-normalizer";

export interface QueueStats {
  pending: number;
  syncing: number;
  failed: number;
  total: number;
}

/**
 * Deduplicates product items across pending queue jobs by externalPosId,
 * preserving the latest state in chronological order.
 * Items with stock === 0 are strictly retained so out-of-stock transitions reach Sphere.
 */
export function coalesceSyncItems(
  items: SphereProductSyncItem[],
): SphereProductSyncItem[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const latestByPosId = new Map<string, SphereProductSyncItem>();
  for (const item of items) {
    if (!item || !item.externalPosId) continue;
    // Later items in chronological order overwrite earlier states for the same externalPosId
    latestByPosId.set(item.externalPosId, item);
  }
  return Array.from(latestByPosId.values());
}

export class SyncQueueManager {
  /**
   * Enqueues normalized product items for sync.
   * Upserts by externalPosId so rapid local updates to the same medication
   * are collapsed into the freshest payload.
   */
  static async enqueue(items: SphereProductInput[]): Promise<number> {
    if (!items || items.length === 0) return 0;
    const now = Date.now();
    let count = 0;

    await db.transaction("rw", db.sync_queue, async () => {
      for (const item of items) {
        if (!item.externalPosId) continue;

        const existing = await db.sync_queue
          .where("externalPosId")
          .equals(item.externalPosId)
          .first();

        if (existing && existing.id) {
          await db.sync_queue.update(existing.id, {
            payload: item,
            status: "PENDING",
            retryCount: 0,
            lastError: undefined,
            updatedAt: now,
          });
        } else {
          await db.sync_queue.add({
            externalPosId: item.externalPosId,
            payload: item,
            status: "PENDING",
            retryCount: 0,
            createdAt: now,
            updatedAt: now,
          });
        }
        count++;
      }
    });

    return count;
  }

  /**
   * Retrieves pending items up to the specified limit.
   */
  static async getPending(limit = 50): Promise<SyncQueueItem[]> {
    return await db.sync_queue
      .where("status")
      .equals("PENDING")
      .limit(limit)
      .toArray();
  }

  /**
   * Recovers items stuck in 'SYNCING' state due to ephemeral MV3 service worker
   * terminations or browser process crashes.
   */
  static async recoverStaleSyncing(timeoutMs = 60000): Promise<number> {
    try {
      if (!db.sync_queue || typeof db.sync_queue.where !== "function") return 0;
      const whereClause = db.sync_queue.where("status");
      if (!whereClause || typeof whereClause.equals !== "function") return 0;

      const threshold = Date.now() - timeoutMs;
      const syncingItems = await whereClause.equals("SYNCING").toArray();

      const staleToReset = syncingItems.filter(
        (item) => (item.updatedAt || 0) < threshold,
      );
      if (staleToReset.length === 0) return 0;

      const ids = staleToReset.map((i) => i.id!).filter(Boolean);
      await db.sync_queue.where("id").anyOf(ids).modify({
        status: "PENDING",
        updatedAt: Date.now(),
      });

      return ids.length;
    } catch {
      return 0;
    }
  }

  /**
   * Marks a list of item IDs as actively syncing.
   */
  static async markSyncing(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await db.sync_queue.where("id").anyOf(ids).modify({
      status: "SYNCING",
      updatedAt: Date.now(),
    });
  }

  /**
   * Deletes successfully synced items to reclaim IndexedDB storage.
   * Only deletes if the item is still in 'SYNCING' status. If the item was
   * updated with newer stock while sync was in-flight, it will be in 'PENDING'
   * status and is preserved for the next flush cycle.
   */
  static async markSuccess(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await db.transaction("rw", db.sync_queue, async () => {
      for (const id of ids) {
        const item =
          typeof db.sync_queue.get === "function"
            ? await db.sync_queue.get(id)
            : null;
        if (!item || item.status === "SYNCING") {
          await db.sync_queue.delete(id);
        }
      }
    });
  }

  /**
   * Updates failure state with exponential backoff retry count.
   * Preserves items that have transitioned out of 'SYNCING' (e.g. re-enqueued as PENDING).
   */
  static async markFailed(
    items: SyncQueueItem[],
    errorMessage: string,
    maxRetries = 5,
  ): Promise<void> {
    const now = Date.now();

    await db.transaction("rw", db.sync_queue, async () => {
      for (const item of items) {
        if (!item.id) continue;
        const current =
          typeof db.sync_queue.get === "function"
            ? await db.sync_queue.get(item.id)
            : item;

        // Skip modifying if fresh payload already transitioned it out of SYNCING
        if (current && current.status !== "SYNCING") {
          continue;
        }

        const nextRetry = ((current?.retryCount ?? item.retryCount) || 0) + 1;
        const status = nextRetry >= maxRetries ? "FAILED" : "PENDING";

        await db.sync_queue.update(item.id, {
          status,
          retryCount: nextRetry,
          lastError: errorMessage,
          updatedAt: now,
        });
      }
    });
  }

  /**
   * Returns current sync queue aggregate counters.
   */
  static async getStats(): Promise<QueueStats> {
    const [pending, syncing, failed, total] = await Promise.all([
      db.sync_queue.where("status").equals("PENDING").count(),
      db.sync_queue.where("status").equals("SYNCING").count(),
      db.sync_queue.where("status").equals("FAILED").count(),
      db.sync_queue.count(),
    ]);

    return { pending, syncing, failed, total };
  }

  /**
   * Resets all FAILED items to PENDING so user or service worker can re-attempt.
   */
  static async retryFailed(): Promise<number> {
    const failedItems = await db.sync_queue
      .where("status")
      .equals("FAILED")
      .toArray();

    if (failedItems.length === 0) return 0;
    const ids = failedItems.map((f) => f.id!).filter(Boolean);

    await db.sync_queue.where("id").anyOf(ids).modify({
      status: "PENDING",
      retryCount: 0,
      updatedAt: Date.now(),
    });

    return ids.length;
  }

  /**
   * Clears the entire sync queue.
   */
  static async clearQueue(): Promise<void> {
    await db.sync_queue.clear();
  }
}
