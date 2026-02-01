import * as fc from 'fast-check';
import { DedupCache } from '../../dht/dedupCache.js';
const { describe, it, expect, beforeEach } = globalThis; // For linters.

/**
 * Property-based tests for DedupCache
 * Feature: rdht-conformance
 */
describe('DedupCache', function () {
  // Arbitrary generators for property tests
  const arbLookupId = fc.uuid();
  const arbTTL = fc.integer({ min: 1, max: 100 }); // TTL in ms for testing
  const arbMaxSize = fc.integer({ min: 1, max: 100 });

  describe('Property 4: Deduplication Cache TTL Eviction', function () {
    /**
     * **Validates: Requirements 3.1**
     * 
     * For any entry added to the DedupCache, after the configured TTL has elapsed,
     * the cache SHALL report that the entry does not exist (has() returns false).
     */
    it('entries expire after TTL elapses', function () {
      fc.assert(
        fc.property(arbLookupId, arbTTL, (lookupId, ttlMs) => {
          const cache = new DedupCache(1000, ttlMs);
          
          // Add entry
          cache.add(lookupId);
          
          // Entry should exist immediately
          expect(cache.has(lookupId)).toBe(true);
          
          // Simulate time passing by manipulating firstSeen
          const entry = cache.cache.get(lookupId);
          entry.firstSeen = Date.now() - ttlMs - 1;
          
          // Entry should no longer exist after TTL
          expect(cache.has(lookupId)).toBe(false);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Unit tests', function () {
    let cache;

    beforeEach(function () {
      cache = new DedupCache(1000, 10000);
    });

    describe('constructor', function () {
      it('creates cache with default parameters', function () {
        const defaultCache = new DedupCache();
        expect(defaultCache.maxSize).toBe(1000);
        expect(defaultCache.ttlMs).toBe(10000);
      });

      it('creates cache with custom parameters', function () {
        const customCache = new DedupCache(500, 5000);
        expect(customCache.maxSize).toBe(500);
        expect(customCache.ttlMs).toBe(5000);
      });
    });

    describe('has', function () {
      it('returns false for unknown lookup ID', function () {
        expect(cache.has('unknown-id')).toBe(false);
      });

      it('returns true for known lookup ID', function () {
        cache.add('test-id');
        expect(cache.has('test-id')).toBe(true);
      });

      it('returns false for expired entry', function () {
        cache.add('test-id');
        // Simulate expiration
        const entry = cache.cache.get('test-id');
        entry.firstSeen = Date.now() - cache.ttlMs - 1;
        
        expect(cache.has('test-id')).toBe(false);
      });

      it('removes expired entry from cache', function () {
        cache.add('test-id');
        const entry = cache.cache.get('test-id');
        entry.firstSeen = Date.now() - cache.ttlMs - 1;
        
        cache.has('test-id');
        expect(cache.cache.has('test-id')).toBe(false);
      });
    });

    describe('add', function () {
      it('adds entry to cache', function () {
        cache.add('test-id');
        expect(cache.cache.has('test-id')).toBe(true);
      });

      it('sets firstSeen timestamp', function () {
        const before = Date.now();
        cache.add('test-id');
        const after = Date.now();
        
        const entry = cache.cache.get('test-id');
        expect(entry.firstSeen).toBeGreaterThanOrEqual(before);
        expect(entry.firstSeen).toBeLessThanOrEqual(after);
      });

      it('sets forwarded to false', function () {
        cache.add('test-id');
        const entry = cache.cache.get('test-id');
        expect(entry.forwarded).toBe(false);
      });

      it('enforces size limit by removing oldest entry', function () {
        const smallCache = new DedupCache(2, 10000);
        smallCache.add('first');
        smallCache.add('second');
        smallCache.add('third');
        
        expect(smallCache.cache.size).toBe(2);
        expect(smallCache.cache.has('first')).toBe(false);
        expect(smallCache.cache.has('second')).toBe(true);
        expect(smallCache.cache.has('third')).toBe(true);
      });
    });

    describe('markForwarded', function () {
      it('marks entry as forwarded', function () {
        cache.add('test-id');
        cache.markForwarded('test-id');
        
        const entry = cache.cache.get('test-id');
        expect(entry.forwarded).toBe(true);
      });

      it('does nothing for unknown entry', function () {
        // Should not throw
        cache.markForwarded('unknown-id');
      });
    });

    describe('evictStale', function () {
      it('removes expired entries', function () {
        cache.add('fresh');
        cache.add('stale');
        
        // Make one entry stale
        const staleEntry = cache.cache.get('stale');
        staleEntry.firstSeen = Date.now() - cache.ttlMs - 1;
        
        cache.evictStale();
        
        expect(cache.cache.has('fresh')).toBe(true);
        expect(cache.cache.has('stale')).toBe(false);
      });

      it('keeps non-expired entries', function () {
        cache.add('test-id');
        cache.evictStale();
        expect(cache.cache.has('test-id')).toBe(true);
      });
    });
  });
});
