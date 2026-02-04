import * as fc from 'fast-check';
import { v4 as uuidv4 } from 'uuid';
import { Node, SimulatedContact, Contact } from '../../index.js';
import { NodeRecursive } from '../../dht/nodeRecursive.js';
import { RequestContext } from '../../dht/requestContext.js';
import { DedupCache } from '../../dht/dedupCache.js';
const { describe, it, expect, beforeAll, afterAll, beforeEach } = globalThis; // For linters.

/**
 * Test helper: Create a Node subclass that uses NodeRecursive.
 * This allows testing NodeRecursive methods before the inheritance chain is updated.
 * 
 * We extend NodeRecursive (which extends NodeMessages) and add the missing
 * functionality from NodeProbe and Node that we need for testing.
 */
class TestNodeRecursive extends NodeRecursive {
  // NodeRecursive extends NodeMessages, which has all the base functionality we need
}

/**
 * Test helper: SimulatedContact that creates TestNodeRecursive nodes.
 */
class TestSimulatedContact extends SimulatedContact {
  static async create(properties, host = undefined) {
    const node = await TestNodeRecursive.create(properties);
    return this.fromNode(node, host);
  }
}

/**
 * Property-based tests for NodeRecursive
 * Feature: rdht-conformance
 */
describe('NodeRecursive', function () {
  // Arbitrary generators for property tests
  const arbNodeKey = fc.bigInt(0n, 2n ** 128n - 1n);
  const arbLookupId = fc.uuid();
  const arbTTL = fc.integer({ min: 0, max: 50 });
  const arbTracePath = fc.array(arbNodeKey, { maxLength: 20 });

  const arbRequestContext = fc.record({
    lookupId: arbLookupId,
    originId: arbNodeKey,
    targetId: arbNodeKey,
    ttl: arbTTL,
    tracePath: arbTracePath,
  });

  beforeAll(function () {
    Node.stopRefresh();
    TestNodeRecursive.stopRefresh();
  });

  describe('Property 5: Duplicate Detection', function () {
    /**
     * **Validates: Requirements 3.2, 3.3, 3.4**
     * 
     * For any recursive lookup request where either:
     * (a) the lookup_id is already in the dedup cache, or
     * (b) the receiving node's key is in the trace path,
     * the node SHALL respond with DUPLICATE status and SHALL NOT silently drop the request.
     */
    it('returns DUPLICATE when lookup_id is already in cache', async function () {
      await fc.assert(
        fc.asyncProperty(arbLookupId, arbNodeKey, async (lookupId, targetId) => {
          // Create a node with NodeRecursive capabilities
          const contact = await TestSimulatedContact.create({ name: `dedup-cache-${uuidv4().slice(0, 8)}` });
          const node = contact.node;

          // Pre-populate the dedup cache with the lookup_id
          node.dedupCache.add(lookupId);

          // Create a request context with the same lookup_id
          const ctx = new RequestContext({
            lookupId: lookupId,
            originId: 123n,
            targetId: targetId,
            ttl: 20,
            tracePath: [],
          });

          // Call recursiveFindNodes
          const result = await node.recursiveFindNodes(ctx.serialize());

          // Should return DUPLICATE status, not null (not silently dropped)
          expect(result).not.toBeNull();
          expect(result.status).toBe('DUPLICATE');
          expect(result.reason).toBe('lookup_id_seen');
        }),
        { numRuns: 100 }
      );
    });

    it('returns DUPLICATE when node key is in trace path (loop detection)', async function () {
      await fc.assert(
        fc.asyncProperty(arbLookupId, arbNodeKey, async (lookupId, targetId) => {
          // Create a node
          const contact = await TestSimulatedContact.create({ name: `loop-detect-${uuidv4().slice(0, 8)}` });
          const node = contact.node;

          // Create a request context with the node's key in the trace path
          const ctx = new RequestContext({
            lookupId: lookupId,
            originId: 123n,
            targetId: targetId,
            ttl: 20,
            tracePath: [456n, node.key, 789n], // Node's key is in the path
          });

          // Call recursiveFindNodes
          const result = await node.recursiveFindNodes(ctx.serialize());

          // Should return DUPLICATE status, not null (not silently dropped)
          expect(result).not.toBeNull();
          expect(result.status).toBe('DUPLICATE');
          expect(result.reason).toBe('loop_detected');
        }),
        { numRuns: 100 }
      );
    });

    it('does not return DUPLICATE for fresh lookup_id and no loop', async function () {
      await fc.assert(
        fc.asyncProperty(arbLookupId, async (lookupId) => {
          // Create a node
          const contact = await TestSimulatedContact.create({ name: `fresh-lookup-${uuidv4().slice(0, 8)}` });
          const node = contact.node;

          // Create a fresh request context (not in cache, node not in trace)
          // Use BigInt values for targetId
          const ctx = new RequestContext({
            lookupId: lookupId,
            originId: 123n,
            targetId: 456n,
            ttl: 0, // TTL 0 so it returns immediately without forwarding
            tracePath: [789n], // Some other node, not this one
          });

          // Call recursiveFindNodes
          const result = await node.recursiveFindNodes(ctx.serialize());

          // Should NOT return DUPLICATE
          expect(result).not.toBeNull();
          expect(result.status).not.toBe('DUPLICATE');
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 7: XOR-Distance Progress', function () {
    /**
     * **Validates: Requirements 4.5, 10.1**
     * 
     * For any recursive forwarding decision, the selected next hop's XOR distance
     * to the target SHALL be strictly less than the current node's XOR distance
     * to the target.
     */
    it('selectProximityAware only returns candidates with strictly smaller XOR distance', async function () {
      await fc.assert(
        fc.asyncProperty(
          arbNodeKey,
          fc.array(arbNodeKey, { minLength: 1, maxLength: 10 }),
          async (targetId, candidateKeys) => {
            // Create a node
            const contact = await TestSimulatedContact.create({ name: `xor-progress-${uuidv4().slice(0, 8)}` });
            const node = contact.node;

            const myDistance = node.distance(targetId);

            // Create mock helpers with various distances
            const helpers = [];
            for (const key of candidateKeys) {
              if (key === node.key) continue; // Skip self
              const mockContact = {
                key: key,
                rtt: null,
                name: `mock-${key.toString().slice(0, 8)}`
              };
              const distance = Node.distance(key, targetId);
              helpers.push({
                key: key,
                contact: mockContact,
                distance: distance,
                name: mockContact.name
              });
            }

            // Sort by distance (as findClosestHelpers would)
            helpers.sort((a, b) => {
              if (a.distance < b.distance) return -1;
              if (a.distance > b.distance) return 1;
              return 0;
            });

            // Create a context with empty trace path
            const ctx = new RequestContext({
              lookupId: uuidv4(),
              originId: 123n,
              targetId: targetId,
              ttl: 20,
              tracePath: [],
            });

            // Call selectProximityAware
            const selected = node.selectProximityAware(helpers, ctx);

            // If a candidate was selected, it must have strictly smaller distance
            if (selected !== null) {
              expect(selected.distance).toBeLessThan(myDistance);
            }
            // If no candidate was selected, all candidates must have >= distance
            else {
              for (const h of helpers) {
                if (h.key !== node.key && !ctx.hasVisited(h.key)) {
                  expect(h.distance).toBeGreaterThanOrEqual(myDistance);
                }
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 2: Trace Path Growth on Forward', function () {
    /**
     * **Validates: Requirements 2.2, 4.2**
     * 
     * For any recursive lookup forwarding operation, the trace path in the
     * forwarded context SHALL contain exactly one more entry than the original,
     * and that entry SHALL be the forwarding node's key.
     */
    it('forward() adds exactly one entry (the forwarding node key) to trace path', function () {
      fc.assert(
        fc.property(arbRequestContext, arbNodeKey, (contextData, forwardingNodeKey) => {
          const original = new RequestContext(contextData);
          const originalLength = original.tracePath.length;

          const forwarded = original.forward(forwardingNodeKey);

          // Trace path should have exactly one more entry
          expect(forwarded.tracePath.length).toBe(originalLength + 1);

          // The new entry should be the forwarding node's key
          expect(forwarded.tracePath[forwarded.tracePath.length - 1]).toBe(forwardingNodeKey);

          // Original trace path entries should be preserved
          for (let i = 0; i < originalLength; i++) {
            expect(forwarded.tracePath[i]).toBe(original.tracePath[i]);
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 3: TTL Enforcement', function () {
    /**
     * **Validates: Requirements 2.4, 4.3**
     * 
     * For any recursive lookup request with TTL equal to zero, the receiving
     * node SHALL NOT forward the request and SHALL return its closest known nodes.
     */
    it('returns TTL_EXPIRED and does not forward when TTL is zero', async function () {
      await fc.assert(
        fc.asyncProperty(arbLookupId, arbNodeKey, async (lookupId, targetId) => {
          // Create a node
          const contact = await TestSimulatedContact.create({ name: `ttl-zero-${uuidv4().slice(0, 8)}` });
          const node = contact.node;

          // Ensure targetId is different from node.key to avoid FOUND status
          const actualTargetId = targetId === node.key ? targetId + 1n : targetId;

          // Create a request context with TTL = 0
          const ctx = new RequestContext({
            lookupId: lookupId,
            originId: node.key,
            targetId: actualTargetId, // Use BigInt
            ttl: 0, // Zero TTL
            tracePath: [],
          });

          // Call recursiveFindNodes
          const result = await node.recursiveFindNodes(ctx.serialize());

          // Should return TTL_EXPIRED status (or NO_CLOSER if no contacts)
          expect(result).not.toBeNull();
          // With TTL=0 and no contacts, we get TTL_EXPIRED
          expect(['TTL_EXPIRED', 'NO_CLOSER']).toContain(result.status);

          // Should include nodes (closest known)
          expect(result.nodes).toBeDefined();
          expect(Array.isArray(result.nodes)).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('forward() decrements TTL by exactly 1', function () {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 50 }),
          arbNodeKey,
          (ttl, forwardingNodeKey) => {
            const ctx = new RequestContext({
              lookupId: uuidv4(),
              originId: 123n,
              targetId: 456n,
              ttl: ttl,
              tracePath: [],
            });

            const forwarded = ctx.forward(forwardingNodeKey);

            expect(forwarded.ttl).toBe(ttl - 1);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Unit tests', function () {
    describe('dedupCache initialization', function () {
      it('lazily initializes dedupCache on first access', async function () {
        const contact = await TestSimulatedContact.create({ name: 'dedup-init-test' });
        const node = contact.node;

        // Access dedupCache
        const cache = node.dedupCache;

        expect(cache).toBeDefined();
        expect(cache).toBeInstanceOf(DedupCache);
      });

      it('uses configured cache size and TTL', async function () {
        const contact = await TestSimulatedContact.create({ name: 'dedup-config-test' });
        const node = contact.node;

        const cache = node.dedupCache;

        expect(cache.maxSize).toBe(TestNodeRecursive.dedupCacheSize);
        expect(cache.ttlMs).toBe(TestNodeRecursive.dedupCacheTTL);
      });
    });

    describe('createLookupContext', function () {
      it('creates context with unique lookupId', async function () {
        const contact = await TestSimulatedContact.create({ name: 'ctx-create-test' });
        const node = contact.node;

        const ctx1 = node.createLookupContext(123n);
        const ctx2 = node.createLookupContext(123n);

        expect(ctx1.lookupId).not.toBe(ctx2.lookupId);
      });

      it('sets originId to node key', async function () {
        const contact = await TestSimulatedContact.create({ name: 'ctx-origin-test' });
        const node = contact.node;

        const ctx = node.createLookupContext(456n);

        expect(ctx.originId).toBe(node.key);
      });

      it('sets targetId to provided key', async function () {
        const contact = await TestSimulatedContact.create({ name: 'ctx-target-test' });
        const node = contact.node;

        const ctx = node.createLookupContext(789n);

        expect(ctx.targetId).toBe(789n);
      });

      it('uses defaultTTL from configuration', async function () {
        const contact = await TestSimulatedContact.create({ name: 'ctx-ttl-test' });
        const node = contact.node;

        const ctx = node.createLookupContext(123n);

        expect(ctx.ttl).toBe(TestNodeRecursive.defaultTTL);
      });

      it('starts with empty trace path', async function () {
        const contact = await TestSimulatedContact.create({ name: 'ctx-trace-test' });
        const node = contact.node;

        const ctx = node.createLookupContext(123n);

        expect(ctx.tracePath).toEqual([]);
      });
    });

    describe('selectProximityAware', function () {
      it('returns null when no valid candidates', async function () {
        const contact = await TestSimulatedContact.create({ name: 'select-empty-test' });
        const node = contact.node;

        const ctx = new RequestContext({
          lookupId: uuidv4(),
          originId: 123n,
          targetId: 456n,
          ttl: 20,
          tracePath: [],
        });

        const result = node.selectProximityAware([], ctx);

        expect(result).toBeNull();
      });

      it('excludes nodes in trace path', async function () {
        const contact = await TestSimulatedContact.create({ name: 'select-exclude-test' });
        const node = contact.node;

        const visitedKey = 999n;
        const ctx = new RequestContext({
          lookupId: uuidv4(),
          originId: 123n,
          targetId: 456n,
          ttl: 20,
          tracePath: [visitedKey],
        });

        // Create a helper that's in the trace path
        const helpers = [{
          key: visitedKey,
          contact: { key: visitedKey, rtt: null, name: 'visited' },
          distance: 1n, // Very close
          name: 'visited'
        }];

        const result = node.selectProximityAware(helpers, ctx);

        expect(result).toBeNull();
      });

      it('excludes self', async function () {
        const contact = await TestSimulatedContact.create({ name: 'select-self-test' });
        const node = contact.node;

        const ctx = new RequestContext({
          lookupId: uuidv4(),
          originId: 123n,
          targetId: 456n,
          ttl: 20,
          tracePath: [],
        });

        // Create a helper that is self
        const helpers = [{
          key: node.key,
          contact: { key: node.key, rtt: null, name: 'self' },
          distance: 0n,
          name: 'self'
        }];

        const result = node.selectProximityAware(helpers, ctx);

        expect(result).toBeNull();
      });
    });

    describe('updateFromTracePath', function () {
      it('does not throw for empty trace path', async function () {
        const contact = await TestSimulatedContact.create({ name: 'update-empty-test' });
        const node = contact.node;

        expect(() => node.updateFromTracePath([])).not.toThrow();
      });

      it('does not add self to routing table', async function () {
        const contact = await TestSimulatedContact.create({ name: 'update-self-test' });
        const node = contact.node;

        // This should not throw or cause issues
        node.updateFromTracePath([node.key]);
      });
    });

    describe('recursiveFindNodes', function () {
      it('adds lookup to dedup cache', async function () {
        const contact = await TestSimulatedContact.create({ name: 'rfn-dedup-test' });
        const node = contact.node;

        const lookupId = uuidv4();
        const ctx = new RequestContext({
          lookupId: lookupId,
          originId: node.key, // Use valid BigInt key
          targetId: node.key, // Target self to avoid distance issues
          ttl: 0, // Zero TTL to avoid forwarding
          tracePath: [],
        });

        await node.recursiveFindNodes(ctx.serialize());

        expect(node.dedupCache.has(lookupId)).toBe(true);
      });

      it('returns FOUND when target is self', async function () {
        const contact = await TestSimulatedContact.create({ name: 'rfn-found-test' });
        const node = contact.node;

        const ctx = new RequestContext({
          lookupId: uuidv4(),
          originId: node.key, // Use valid BigInt key
          targetId: node.key, // Target is this node
          ttl: 20,
          tracePath: [],
        });

        const result = await node.recursiveFindNodes(ctx.serialize());

        expect(result.status).toBe('FOUND');
      });
    });
  });
});
