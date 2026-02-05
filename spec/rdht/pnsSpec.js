import * as fc from 'fast-check';
import { Node, SimulatedContact, KBucket } from '../../index.js';
const { describe, it, expect, beforeAll, beforeEach, afterAll } = globalThis; // For linters.

/**
 * Property-based tests for PNS (Proximity Neighbor Selection)
 * Feature: rdht-conformance
 */
describe('PNS (Proximity Neighbor Selection)', function () {
  // Save original PNS setting
  let originalPnsEnabled;

  beforeAll(function () {
    Node.stopRefresh();
    originalPnsEnabled = Node.pnsEnabled;
  });

  afterAll(function () {
    Node.pnsEnabled = originalPnsEnabled;
  });

  // Arbitrary generators for property tests
  const arbRTT = fc.integer({ min: 1, max: 5000 });
  const arbRTTOrNull = fc.option(arbRTT, { nil: null });

  /**
   * Create a mock contact with specified RTT
   */
  function mockContact(key, rtt = null) {
    return {
      key: key,
      rtt: rtt,
      rttUpdatedAt: rtt !== null ? Date.now() : null,
      name: `mock-${key.toString().slice(0, 8)}`,
      node: { key: key },
      connection: true,
      sendRPC: async () => 'pong'
    };
  }

  /**
   * Create a mock node for bucket testing
   */
  function mockNode(key = 1n) {
    return {
      key: key,
      constructor: {
        keySize: 128,
        k: 20,
        pnsEnabled: true,
        assert: (cond, ...msg) => { if (!cond) throw new Error(msg.join(' ')); }
      },
      routingTable: new Map(),
      looseContacts: [],
      removeLooseContact: () => {},
      schedule: () => {}
    };
  }

  describe('Property 10: PNS Bucket Ordering', function () {
    /**
     * **Validates: Requirements 6.1**
     * 
     * For any KBucket with PNS enabled containing multiple contacts,
     * the contacts SHALL be ordered by RTT (lowest first) within the
     * constraint that all contacts remain XOR-valid for that bucket's prefix range.
     */
    it('reorderByProximity sorts contacts by RTT (lowest first)', function () {
      fc.assert(
        fc.property(
          fc.array(arbRTT, { minLength: 2, maxLength: 20 }),
          (rtts) => {
            // Create mock node with PNS enabled
            const node = mockNode();
            node.constructor.pnsEnabled = true;

            // Create bucket
            const bucket = new KBucket(node, 10);

            // Add contacts with various RTTs
            rtts.forEach((rtt, i) => {
              const contact = mockContact(BigInt(i + 100), rtt);
              bucket.contacts.push(contact);
            });

            // Reorder by proximity
            const result = bucket.reorderByProximity();
            expect(result).toBe(true);

            // Verify contacts are sorted by RTT (lowest first)
            for (let i = 1; i < bucket.contacts.length; i++) {
              const prevRTT = bucket.contacts[i - 1].rtt ?? Infinity;
              const currRTT = bucket.contacts[i].rtt ?? Infinity;
              expect(currRTT).toBeGreaterThanOrEqual(prevRTT);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('reorderByProximity preserves all original contacts (bucket structure)', function () {
      fc.assert(
        fc.property(
          fc.array(arbRTTOrNull, { minLength: 2, maxLength: 20 }),
          (rtts) => {
            const node = mockNode();
            node.constructor.pnsEnabled = true;

            const bucket = new KBucket(node, 10);

            // Add contacts and track original keys
            const originalKeys = new Set();
            rtts.forEach((rtt, i) => {
              const key = BigInt(i + 100);
              const contact = mockContact(key, rtt);
              bucket.contacts.push(contact);
              originalKeys.add(key);
            });

            // Reorder
            bucket.reorderByProximity();

            // Verify all original contacts are still present
            const newKeys = new Set(bucket.contacts.map(c => c.key));
            expect(newKeys.size).toBe(originalKeys.size);
            for (const key of originalKeys) {
              expect(newKeys.has(key)).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('reorderByProximity places null RTT contacts at the end', function () {
      fc.assert(
        fc.property(
          fc.array(arbRTT, { minLength: 1, maxLength: 10 }),
          fc.integer({ min: 1, max: 5 }),
          (knownRtts, nullCount) => {
            const node = mockNode();
            node.constructor.pnsEnabled = true;

            const bucket = new KBucket(node, 10);

            // Add contacts with known RTTs
            knownRtts.forEach((rtt, i) => {
              bucket.contacts.push(mockContact(BigInt(i + 100), rtt));
            });

            // Add contacts with null RTT
            for (let i = 0; i < nullCount; i++) {
              bucket.contacts.push(mockContact(BigInt(i + 200), null));
            }

            // Shuffle to randomize order
            bucket.contacts.sort(() => Math.random() - 0.5);

            // Reorder
            bucket.reorderByProximity();

            // Verify null RTT contacts are at the end
            const firstNullIndex = bucket.contacts.findIndex(c => c.rtt === null);
            if (firstNullIndex !== -1) {
              // All contacts after first null should also be null
              for (let i = firstNullIndex; i < bucket.contacts.length; i++) {
                expect(bucket.contacts[i].rtt).toBeNull();
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('reorderByProximity does nothing when PNS is disabled', function () {
      fc.assert(
        fc.property(
          fc.array(arbRTT, { minLength: 2, maxLength: 10 }),
          (rtts) => {
            const node = mockNode();
            node.constructor.pnsEnabled = false; // PNS disabled

            const bucket = new KBucket(node, 10);

            // Add contacts
            rtts.forEach((rtt, i) => {
              bucket.contacts.push(mockContact(BigInt(i + 100), rtt));
            });

            // Record original order
            const originalOrder = bucket.contacts.map(c => c.key);

            // Try to reorder
            const result = bucket.reorderByProximity();
            expect(result).toBe(false);

            // Verify order unchanged
            const newOrder = bucket.contacts.map(c => c.key);
            expect(newOrder).toEqual(originalOrder);
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  describe('Property 11: PNS Rate Limiting', function () {
    /**
     * **Validates: Requirements 6.3**
     * 
     * For any time window, the number of RTT probes performed for PNS
     * reevaluation SHALL NOT exceed the configured rate limit.
     */
    it('canProbe respects rate limit within window', function () {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 100, max: 10000 }),
          (rateLimit, windowMs) => {
            const node = mockNode();
            node.constructor.pnsEnabled = true;

            const bucket = new KBucket(node, 10);
            
            // Configure rate limiting
            const originalRateLimit = KBucket.pnsProbeRateLimit;
            const originalWindowMs = KBucket.pnsProbeWindowMs;
            const originalMinInterval = KBucket.pnsMinProbeIntervalMs;
            
            KBucket.pnsProbeRateLimit = rateLimit;
            KBucket.pnsProbeWindowMs = windowMs;
            KBucket.pnsMinProbeIntervalMs = 0; // Disable min interval for this test

            try {
              // Record probes up to the limit
              for (let i = 0; i < rateLimit; i++) {
                expect(bucket.canProbe()).toBe(true);
                bucket.recordProbe();
              }

              // Next probe should be blocked
              expect(bucket.canProbe()).toBe(false);
            } finally {
              // Restore original values
              KBucket.pnsProbeRateLimit = originalRateLimit;
              KBucket.pnsProbeWindowMs = originalWindowMs;
              KBucket.pnsMinProbeIntervalMs = originalMinInterval;
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('rate limit resets after window expires', function () {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10 }),
          (rateLimit) => {
            const node = mockNode();
            node.constructor.pnsEnabled = true;

            const bucket = new KBucket(node, 10);
            
            // Configure rate limiting with short window
            const originalRateLimit = KBucket.pnsProbeRateLimit;
            const originalWindowMs = KBucket.pnsProbeWindowMs;
            const originalMinInterval = KBucket.pnsMinProbeIntervalMs;
            
            KBucket.pnsProbeRateLimit = rateLimit;
            KBucket.pnsProbeWindowMs = 100; // Short window for testing
            KBucket.pnsMinProbeIntervalMs = 0;

            try {
              // Exhaust the rate limit
              for (let i = 0; i < rateLimit; i++) {
                bucket.recordProbe();
              }
              expect(bucket.canProbe()).toBe(false);

              // Simulate window expiration
              bucket._pnsProbeWindowStart = Date.now() - 200;

              // Should be able to probe again
              expect(bucket.canProbe()).toBe(true);
            } finally {
              KBucket.pnsProbeRateLimit = originalRateLimit;
              KBucket.pnsProbeWindowMs = originalWindowMs;
              KBucket.pnsMinProbeIntervalMs = originalMinInterval;
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('probeCount tracks probes within current window', function () {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 20 }),
          (probeCount) => {
            const node = mockNode();
            const bucket = new KBucket(node, 10);

            // Initially zero
            expect(bucket.probeCount).toBe(0);

            // Record probes
            for (let i = 0; i < probeCount; i++) {
              bucket.recordProbe();
            }

            expect(bucket.probeCount).toBe(probeCount);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('probeCount resets to 0 after window expires', function () {
      const node = mockNode();
      const bucket = new KBucket(node, 10);

      // Record some probes
      bucket.recordProbe();
      bucket.recordProbe();
      expect(bucket.probeCount).toBe(2);

      // Simulate window expiration
      bucket._pnsProbeWindowStart = Date.now() - KBucket.pnsProbeWindowMs - 1;

      // Count should be 0
      expect(bucket.probeCount).toBe(0);
    });

    it('minimum probe interval is respected', function () {
      const node = mockNode();
      const bucket = new KBucket(node, 10);

      // Configure minimum interval
      const originalMinInterval = KBucket.pnsMinProbeIntervalMs;
      KBucket.pnsMinProbeIntervalMs = 100;

      try {
        // First probe should be allowed
        expect(bucket.canProbe()).toBe(true);
        bucket.recordProbe();

        // Immediate second probe should be blocked
        expect(bucket.canProbe()).toBe(false);

        // Simulate time passing
        bucket._lastPnsProbeTime = Date.now() - 150;

        // Now should be allowed
        expect(bucket.canProbe()).toBe(true);
      } finally {
        KBucket.pnsMinProbeIntervalMs = originalMinInterval;
      }
    });
  });

  describe('Unit tests', function () {
    describe('reorderByProximity', function () {
      it('returns false for bucket with less than 2 contacts', function () {
        const node = mockNode();
        node.constructor.pnsEnabled = true;

        const bucket = new KBucket(node, 10);
        
        // Empty bucket
        expect(bucket.reorderByProximity()).toBe(false);

        // Single contact
        bucket.contacts.push(mockContact(100n, 50));
        expect(bucket.reorderByProximity()).toBe(false);
      });

      it('correctly sorts mixed RTT values', function () {
        const node = mockNode();
        node.constructor.pnsEnabled = true;

        const bucket = new KBucket(node, 10);

        // Add contacts in random order
        bucket.contacts.push(mockContact(100n, 500));
        bucket.contacts.push(mockContact(101n, 100));
        bucket.contacts.push(mockContact(102n, null));
        bucket.contacts.push(mockContact(103n, 300));
        bucket.contacts.push(mockContact(104n, 50));

        bucket.reorderByProximity();

        // Verify order: 50, 100, 300, 500, null
        expect(bucket.contacts[0].rtt).toBe(50);
        expect(bucket.contacts[1].rtt).toBe(100);
        expect(bucket.contacts[2].rtt).toBe(300);
        expect(bucket.contacts[3].rtt).toBe(500);
        expect(bucket.contacts[4].rtt).toBeNull();
      });
    });

    describe('probeForRTT', function () {
      it('returns 0 when PNS is disabled', async function () {
        const node = mockNode();
        node.constructor.pnsEnabled = false;

        const bucket = new KBucket(node, 10);
        bucket.contacts.push(mockContact(100n, null));

        const probed = await bucket.probeForRTT();
        expect(probed).toBe(0);
      });

      it('only probes contacts without RTT', async function () {
        const node = mockNode();
        node.constructor.pnsEnabled = true;

        const bucket = new KBucket(node, 10);
        
        // Disable rate limiting for this test
        const originalMinInterval = KBucket.pnsMinProbeIntervalMs;
        KBucket.pnsMinProbeIntervalMs = 0;

        try {
          // Add contacts - some with RTT, some without
          let probeCallCount = 0;
          const contactWithRTT = mockContact(100n, 50);
          const contactWithoutRTT = mockContact(101n, null);
          contactWithoutRTT.sendRPC = async () => {
            probeCallCount++;
            return 'pong';
          };

          bucket.contacts.push(contactWithRTT);
          bucket.contacts.push(contactWithoutRTT);

          await bucket.probeForRTT(10);

          // Only the contact without RTT should have been probed
          expect(probeCallCount).toBe(1);
        } finally {
          KBucket.pnsMinProbeIntervalMs = originalMinInterval;
        }
      });

      it('respects maxProbes parameter', async function () {
        const node = mockNode();
        node.constructor.pnsEnabled = true;

        const bucket = new KBucket(node, 10);
        
        const originalMinInterval = KBucket.pnsMinProbeIntervalMs;
        KBucket.pnsMinProbeIntervalMs = 0;

        try {
          // Add multiple contacts without RTT
          for (let i = 0; i < 5; i++) {
            bucket.contacts.push(mockContact(BigInt(100 + i), null));
          }

          const probed = await bucket.probeForRTT(2);
          expect(probed).toBe(2);
        } finally {
          KBucket.pnsMinProbeIntervalMs = originalMinInterval;
        }
      });
    });

    describe('updateProximityOrder', function () {
      it('returns zeros when PNS is disabled', async function () {
        const node = mockNode();
        node.constructor.pnsEnabled = false;

        const bucket = new KBucket(node, 10);
        bucket.contacts.push(mockContact(100n, null));
        bucket.contacts.push(mockContact(101n, 50));

        const result = await bucket.updateProximityOrder();
        expect(result.probed).toBe(0);
        expect(result.reordered).toBe(false);
      });

      it('probes and reorders when PNS is enabled', async function () {
        const node = mockNode();
        node.constructor.pnsEnabled = true;

        const bucket = new KBucket(node, 10);
        
        const originalMinInterval = KBucket.pnsMinProbeIntervalMs;
        KBucket.pnsMinProbeIntervalMs = 0;

        try {
          bucket.contacts.push(mockContact(100n, 500));
          bucket.contacts.push(mockContact(101n, 100));

          const result = await bucket.updateProximityOrder();
          expect(result.reordered).toBe(true);

          // Verify order
          expect(bucket.contacts[0].rtt).toBe(100);
          expect(bucket.contacts[1].rtt).toBe(500);
        } finally {
          KBucket.pnsMinProbeIntervalMs = originalMinInterval;
        }
      });
    });

    describe('pnsEnabled getter', function () {
      it('reflects node constructor pnsEnabled setting', function () {
        const node = mockNode();
        
        node.constructor.pnsEnabled = true;
        const bucket1 = new KBucket(node, 10);
        expect(bucket1.pnsEnabled).toBe(true);

        node.constructor.pnsEnabled = false;
        const bucket2 = new KBucket(node, 10);
        expect(bucket2.pnsEnabled).toBe(false);
      });
    });
  });
});
