import { db, SyncQueueItem } from "../data/db";
import {
  SphereProductInput,
  SphereProductSyncItem,
  BandaGoNormalizer,
} from "../extraction/bandago-normalizer";

export interface QueueStats {
  pending: number;
  syncing: number;
  failed: number;
  total: number;
}

export interface ProblemQueueItem {
  id?: number;
  externalPosId: string;
  name: string;
  sku: string | null;
  stock: number;
  status: "PENDING" | "SYNCING" | "SUCCESS" | "FAILED";
  retryCount: number;
  lastError: string;
  updatedAt: number;
}

/**
 * Deduplicates product items across pending queue jobs by externalPosId,
 * merging batch arrays, FEFO stock, and catalog metadata.
 * Items with stock === 0 are strictly retained so out-of-stock transitions reach Sphere.
 */
export function coalesceSyncItems(
  items: SphereProductSyncItem[],
): SphereProductSyncItem[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const deduped = new Map<string, SphereProductSyncItem>();
  for (const item of items) {
    if (!item || !item.externalPosId) continue;
    const existing = deduped.get(item.externalPosId);
    if (existing) {
      // Merge batch arrays, FEFO stock, and metadata instead of overwriting
      deduped.set(
        item.externalPosId,
        BandaGoNormalizer.mergeProducts(existing, item),
      );
    } else {
      deduped.set(item.externalPosId, item);
    }
  }
  return Array.from(deduped.values());
}

export class SyncQueueManager {
  /**
   * Enqueues normalized product items for sync.
   * Upserts by externalPosId so rapid local updates to the same medication
   * are collapsed and merged into the freshest payload.
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
          // If existing item is PENDING, FAILED, or SYNCING, merge with incoming payload
          // so M_ProductGet and M_StorageOnHandGet enrich each other instead of clobbering.
          const mergedPayload =
            existing.payload &&
            (existing.status === "PENDING" ||
              existing.status === "FAILED" ||
              existing.status === "SYNCING")
              ? BandaGoNormalizer.mergeProducts(
                  existing.payload as SphereProductInput,
                  item,
                )
              : item;

          await db.sync_queue.update(existing.id, {
            payload: mergedPayload,
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
   * Returns failed or retrying items with their specific error messages for diagnostics UI.
   */
  static async getProblemItems(limit = 25): Promise<ProblemQueueItem[]> {
    try {
      if (!db.sync_queue || typeof db.sync_queue.toArray !== "function") {
        return [];
      }
      const all = await db.sync_queue.toArray();
      return all
        .filter(
          (item) =>
            item.status === "FAILED" ||
            Boolean(item.lastError && (item.retryCount || 0) > 0),
        )
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, limit)
        .map((item) => {
          const payload = (item.payload || {}) as Partial<SphereProductSyncItem>;
          return {
            id: item.id,
            externalPosId: item.externalPosId,
            name: payload.name || item.externalPosId,
            sku: payload.sku ?? null,
            stock: typeof payload.stock === "number" ? payload.stock : 0,
            status: item.status,
            retryCount: item.retryCount || 0,
            lastError: item.lastError || "Unknown sync error",
            updatedAt: item.updatedAt || item.createdAt || Date.now(),
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * Clears the entire sync queue.
   */
  static async clearQueue(): Promise<void> {
    await db.sync_queue.clear();
  }
}
