import { Node } from '../../index.js';
const { describe, it, expect } = globalThis; // For linters.

/**
 * Unit tests for R/Kademlia configuration options
 * Feature: rdht-conformance
 * 
 * Validates: Requirements 5.6, 6.6, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
 */
describe('Node R/Kademlia Configuration', function () {
  describe('configuration defaults', function () {
    it('recursiveRoutingEnabled defaults to false', function () {
      // Requirement 11.1: recursive routing disabled by default
      expect(Node.recursiveRoutingEnabled).toBe(false);
    });

    it('proximityRoutingEnabled defaults to true', function () {
      // Requirement 5.6, 11.1: proximity routing enabled by default
      expect(Node.proximityRoutingEnabled).toBe(true);
    });

    it('pnsEnabled defaults to false', function () {
      // Requirement 6.6, 11.2: PNS disabled by default
      expect(Node.pnsEnabled).toBe(false);
    });

    it('defaultTTL is 20', function () {
      // Requirement 11.5: configurable max trace path length
      expect(Node.defaultTTL).toBe(20);
    });

    it('dedupCacheSize is 1000', function () {
      // Requirement 11.3: configurable dedup cache size
      expect(Node.dedupCacheSize).toBe(1000);
    });

    it('dedupCacheTTL is 10000ms', function () {
      // Requirement 11.4: configurable dedup cache TTL
      expect(Node.dedupCacheTTL).toBe(10000);
    });

    it('proximityWeight is 0.1', function () {
      // Requirement 11.6: configurable proximity weight factor
      expect(Node.proximityWeight).toBe(0.1);
    });
  });

  describe('configuration types', function () {
    it('recursiveRoutingEnabled is a boolean', function () {
      expect(typeof Node.recursiveRoutingEnabled).toBe('boolean');
    });

    it('proximityRoutingEnabled is a boolean', function () {
      expect(typeof Node.proximityRoutingEnabled).toBe('boolean');
    });

    it('pnsEnabled is a boolean', function () {
      expect(typeof Node.pnsEnabled).toBe('boolean');
    });

    it('defaultTTL is a number', function () {
      expect(typeof Node.defaultTTL).toBe('number');
    });

    it('dedupCacheSize is a number', function () {
      expect(typeof Node.dedupCacheSize).toBe('number');
    });

    it('dedupCacheTTL is a number', function () {
      expect(typeof Node.dedupCacheTTL).toBe('number');
    });

    it('proximityWeight is a number', function () {
      expect(typeof Node.proximityWeight).toBe('number');
    });
  });
});
