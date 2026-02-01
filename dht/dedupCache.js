const { Date, Map } = globalThis; // For linters.

/**
 * DedupCache prevents duplicate processing of recursive lookups.
 * 
 * This cache stores lookup IDs with timestamps to:
 * - Detect duplicate requests (same lookup_id seen before)
 * - Track whether a lookup was forwarded
 * - Automatically evict stale entries based on TTL
 * 
 * Requirements: 3.1, 3.6
 */
export class DedupCache {
  /**
   * @param {number} [maxSize=1000] - Maximum number of entries in the cache
   * @param {number} [ttlMs=10000] - Time-to-live in milliseconds for cache entries
   */
  constructor(maxSize = 1000, ttlMs = 10000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map(); // lookupId → {firstSeen, forwarded}
  }

  /**
   * Check if a lookup ID was already seen and is still valid (not expired).
   * 
   * @param {string} lookupId - The lookup ID to check
   * @returns {boolean} True if the lookup ID is in the cache and not expired
   */
  has(lookupId) {
    const entry = this.cache.get(lookupId);
    if (!entry) return false;
    
    if (Date.now() - entry.firstSeen > this.ttlMs) {
      this.cache.delete(lookupId);
      return false;
    }
    return true;
  }

  /**
   * Record a lookup ID as seen.
   * Enforces size limit by removing oldest entry when full.
   * 
   * @param {string} lookupId - The lookup ID to add
   */
  add(lookupId) {
    this.evictStale();
    
    if (this.cache.size >= this.maxSize) {
      // Remove oldest entry (first key in Map iteration order)
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    
    this.cache.set(lookupId, {
      firstSeen: Date.now(),
      forwarded: false,
    });
  }

  /**
   * Mark a lookup as having been forwarded.
   * 
   * @param {string} lookupId - The lookup ID to mark
   */
  markForwarded(lookupId) {
    const entry = this.cache.get(lookupId);
    if (entry) {
      entry.forwarded = true;
    }
  }

  /**
   * Remove all entries that have exceeded their TTL.
   */
  evictStale() {
    const now = Date.now();
    for (const [id, entry] of this.cache) {
      if (now - entry.firstSeen > this.ttlMs) {
        this.cache.delete(id);
      }
    }
  }
}
