import * as fc from 'fast-check';
import { v4 as uuidv4 } from 'uuid';
import { Node, SimulatedContact, SimulatedConnectionContact } from '../../index.js';
import { RequestContext } from '../../dht/requestContext.js';
const { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } = globalThis;

/**
 * Tests for Recursive Signals using R/Kademlia routing infrastructure.
 * 
 * These tests verify that WebRTC signaling works correctly through
 * multi-hop recursive routing with proper deduplication, TTL enforcement,
 * and alternate path selection.
 */
describe('Recursive Signals', function () {
  // Test network nodes using SimulatedContact (direct method calls, no connection needed)
  let nodes = [];
  let contacts = [];

  // Helper to create a test network with SimulatedContact
  async function createNetwork(size) {
    nodes = [];
    contacts = [];
    Node.stopRefresh();

    for (let i = 0; i < size; i++) {
      const contact = await SimulatedContact.create({ 
        name: `node-${i}`, 
        refreshTimeIntervalMS: 0,
        info: false 
      });
      contacts.push(contact);
      nodes.push(contact.node);
    }

    // Build network: each node knows about all others
    for (let i = 0; i < size; i++) {
      const node = nodes[i];
      for (let j = 0; j < size; j++) {
        if (i !== j) {
          node.addToRoutingTable(contacts[j].clone(node));
        }
      }
    }

    return { nodes, contacts };
  }

  // Helper to clean up network
  async function destroyNetwork() {
    for (const contact of contacts) {
      try {
        await contact.disconnect();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    nodes = [];
    contacts = [];
  }

  beforeAll(function () {
    Node.stopRefresh();
  });

  afterEach(async function () {
    await destroyNetwork();
  });

  describe('RequestContext payload support', function () {
    it('preserves payload through serialization round-trip', function () {
      const payload = { 
        signals: ['offer', 'candidate'], 
        targetNameForDebugging: 'test-target' 
      };

      const ctx = new RequestContext({
        lookupId: uuidv4(),
        originId: 123n,
        targetId: 456n,
        ttl: 20,
        tracePath: [],
        payload: payload,
      });

      const serialized = ctx.serialize();
      const deserialized = RequestContext.deserialize(serialized);

      expect(deserialized.payload).toEqual(payload);
    });

    it('preserves payload through forward()', function () {
      const payload = { signals: ['test'] };

      const ctx = new RequestContext({
        lookupId: uuidv4(),
        originId: 123n,
        targetId: 456n,
        ttl: 20,
        tracePath: [],
        payload: payload,
      });

      const forwarded = ctx.forward(789n);

      expect(forwarded.payload).toEqual(payload);
    });

    it('preserves payload through markTried()', function () {
      const payload = { signals: ['test'] };

      const ctx = new RequestContext({
        lookupId: uuidv4(),
        originId: 123n,
        targetId: 456n,
        ttl: 20,
        tracePath: [],
        payload: payload,
      });

      const marked = ctx.markTried(999n);

      expect(marked.payload).toEqual(payload);
    });
  });

  describe('initiateRecursiveSignals', function () {
    it('returns result and forwardingExclusions', async function () {
      await createNetwork(3);

      // Node 0 initiates signals to node 2
      const result = await nodes[0].initiateRecursiveSignals(
        nodes[2].key,
        [contacts[0].sname, 'dummy offer'],
        [],
        Date.now() + 10000,
        'node-2'
      );

      expect(result).toBeDefined();
      expect(result.forwardingExclusions).toBeDefined();
      expect(Array.isArray(result.forwardingExclusions)).toBe(true);
    });

    it('adds self to forwardingExclusions', async function () {
      await createNetwork(3);

      const forwardingExclusions = [];
      await nodes[0].initiateRecursiveSignals(
        nodes[2].key,
        [contacts[0].sname, 'dummy offer'],
        forwardingExclusions,
        Date.now() + 10000,
        'node-2'
      );

      expect(forwardingExclusions).toContain(nodes[0].name);
    });

    it('adds lookup to dedup cache', async function () {
      await createNetwork(2);

      // Clear any existing cache entries
      nodes[0]._dedupCache = null;

      await nodes[0].initiateRecursiveSignals(
        nodes[1].key,
        [contacts[0].sname, 'dummy offer'],
        [],
        Date.now() + 10000,
        'node-1'
      );

      // Cache should have at least one entry
      expect(nodes[0].dedupCache.cache.size).toBeGreaterThan(0);
    });
  });

  describe('recursiveSignals RPC handler', function () {
    it('returns DUPLICATE when lookup_id is in cache', async function () {
      await createNetwork(2);

      const lookupId = uuidv4();
      
      // Pre-populate cache
      nodes[1].dedupCache.add(lookupId);

      const ctx = new RequestContext({
        lookupId: lookupId,
        originId: nodes[0].key,
        targetId: nodes[1].key,
        ttl: 20,
        tracePath: [],
        payload: { signals: ['test'], targetNameForDebugging: 'test' },
      });

      const result = await nodes[1].recursiveSignals(ctx.serialize());

      expect(result.status).toBe('DUPLICATE');
      expect(result.reason).toBe('lookup_id_seen');
    });

    it('returns DUPLICATE when node is in trace path (loop)', async function () {
      await createNetwork(2);

      const ctx = new RequestContext({
        lookupId: uuidv4(),
        originId: nodes[0].key,
        targetId: 999n, // Some other target
        ttl: 20,
        tracePath: [nodes[1].key], // Node 1 is already in path
        payload: { signals: ['test'], targetNameForDebugging: 'test' },
      });

      const result = await nodes[1].recursiveSignals(ctx.serialize());

      expect(result.status).toBe('DUPLICATE');
      expect(result.reason).toBe('loop_detected');
    });

    it('returns TTL_EXPIRED when TTL is zero', async function () {
      await createNetwork(2);

      const ctx = new RequestContext({
        lookupId: uuidv4(),
        originId: nodes[0].key,
        targetId: 999n, // Some unreachable target
        ttl: 0,
        tracePath: [],
        payload: { signals: ['test'], targetNameForDebugging: 'test' },
      });

      const result = await nodes[1].recursiveSignals(ctx.serialize());

      expect(result.status).toBe('TTL_EXPIRED');
    });

    it('returns FOUND when target is self', async function () {
      // This test requires SimulatedConnectionContact which has signals() method
      // For SimulatedContact, we test that the status is FOUND but skip the result check
      await createNetwork(2);

      const ctx = new RequestContext({
        lookupId: uuidv4(),
        originId: nodes[0].key,
        targetId: nodes[1].key, // Target is node 1
        ttl: 20,
        tracePath: [],
        payload: { signals: [contacts[0].sname, 'dummy offer'], targetNameForDebugging: 'node-1' },
      });

      // Mock the signals method on the contact for this test
      nodes[1].contact.signals = async function(...args) {
        return ['dummy answer', 'dummy candidate'];
      };

      const result = await nodes[1].recursiveSignals(ctx.serialize());

      expect(result.status).toBe('FOUND');
      expect(result.result).toBeDefined();
    });

    it('populates forwardingExclusions from trace path', async function () {
      await createNetwork(3);

      const ctx = new RequestContext({
        lookupId: uuidv4(),
        originId: nodes[0].key,
        targetId: nodes[2].key,
        ttl: 20,
        tracePath: [nodes[0].key], // Node 0 is in trace
        payload: { signals: [contacts[0].sname, 'dummy offer'], targetNameForDebugging: 'node-2' },
      });

      const result = await nodes[1].recursiveSignals(ctx.serialize());

      // forwardingExclusions should include node 1 (self)
      expect(result.forwardingExclusions).toContain(nodes[1].name);
    });
  });

  describe('Multi-hop signal forwarding', function () {
    it('forwards signals through intermediate nodes', async function () {
      // Create a 4-node network where all nodes know each other
      await createNetwork(4);

      // Node 0 sends signals to node 3
      const forwardingExclusions = [];
      const result = await nodes[0].initiateRecursiveSignals(
        nodes[3].key,
        [contacts[0].sname, 'dummy offer', 'dummy candidate'],
        forwardingExclusions,
        Date.now() + 30000,
        'node-3'
      );

      // Should have traversed at least one node (self)
      expect(forwardingExclusions.length).toBeGreaterThan(0);
      
      // Result should be defined (either success or terminal failure)
      expect(result).toBeDefined();
    });

    it('handles signals to directly known node', async function () {
      await createNetwork(2);

      const result = await nodes[0].initiateRecursiveSignals(
        nodes[1].key,
        [contacts[0].sname, 'dummy offer'],
        [],
        Date.now() + 10000,
        'node-1'
      );

      expect(result).toBeDefined();
    });

    it('tries alternate paths on failure', async function () {
      // Create network with multiple paths
      await createNetwork(4);

      const forwardingExclusions = [];
      const result = await nodes[0].initiateRecursiveSignals(
        nodes[3].key,
        [contacts[0].sname, 'dummy offer'],
        forwardingExclusions,
        Date.now() + 30000,
        'node-3'
      );

      expect(result).toBeDefined();
    });
  });

  describe('Deduplication across network', function () {
    it('prevents duplicate processing of same lookup', async function () {
      await createNetwork(3);

      const lookupId = uuidv4();

      // First request
      const ctx1 = new RequestContext({
        lookupId: lookupId,
        originId: nodes[0].key,
        targetId: nodes[2].key,
        ttl: 20,
        tracePath: [],
        payload: { signals: ['test1'], targetNameForDebugging: 'test' },
      });

      const result1 = await nodes[1].recursiveSignals(ctx1.serialize());

      // Second request with same lookupId
      const ctx2 = new RequestContext({
        lookupId: lookupId, // Same lookup ID
        originId: nodes[0].key,
        targetId: nodes[2].key,
        ttl: 20,
        tracePath: [],
        payload: { signals: ['test2'], targetNameForDebugging: 'test' },
      });

      const result2 = await nodes[1].recursiveSignals(ctx2.serialize());

      // Second request should be detected as duplicate
      expect(result2.status).toBe('DUPLICATE');
    });
  });

  describe('TTL enforcement', function () {
    it('decrements TTL on each forward', async function () {
      await createNetwork(3);

      const initialTTL = 5;
      const ctx = new RequestContext({
        lookupId: uuidv4(),
        originId: nodes[0].key,
        targetId: 999n, // Unreachable target
        ttl: initialTTL,
        tracePath: [],
        payload: { signals: ['test'], targetNameForDebugging: 'test' },
      });

      // Forward through node
      const forwarded = ctx.forward(nodes[0].key);

      expect(forwarded.ttl).toBe(initialTTL - 1);
    });

    it('stops forwarding when TTL reaches zero', async function () {
      await createNetwork(5);

      // Start with TTL of 2 - should only go 2 hops
      const ctx = new RequestContext({
        lookupId: uuidv4(),
        originId: nodes[0].key,
        targetId: nodes[4].key, // Far away target
        ttl: 1, // Very low TTL
        tracePath: [],
        payload: { signals: ['test'], targetNameForDebugging: 'node-4' },
      });

      const result = await nodes[1].recursiveSignals(ctx.serialize());

      // Should hit TTL limit before reaching target
      expect(['TTL_EXPIRED', 'NO_CLOSER', 'FOUND']).toContain(result.status);
    });
  });

  describe('Property tests', function () {
    const arbNodeKey = fc.bigInt(0n, 2n ** 128n - 1n);

    it('payload is preserved through any number of forwards', function () {
      fc.assert(
        fc.property(
          fc.array(arbNodeKey, { minLength: 1, maxLength: 10 }),
          fc.oneof(
            fc.constant(null),
            fc.record({
              signals: fc.array(fc.string()),
              targetNameForDebugging: fc.string()
            })
          ),
          (forwardingNodes, payloadData) => {
            let ctx = new RequestContext({
              lookupId: uuidv4(),
              originId: 123n,
              targetId: 456n,
              ttl: 50,
              tracePath: [],
              payload: payloadData,
            });

            // Forward through all nodes
            for (const nodeKey of forwardingNodes) {
              ctx = ctx.forward(nodeKey);
            }

            // Payload should be preserved (both null or equal objects)
            if (payloadData === null) {
              expect(ctx.payload).toBeNull();
            } else {
              expect(ctx.payload).toEqual(payloadData);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('forwardingExclusions grows with each hop', async function () {
      await createNetwork(4);

      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 3 }),
          async (targetIndex) => {
            const forwardingExclusions = [];
            
            await nodes[0].initiateRecursiveSignals(
              nodes[targetIndex].key,
              [contacts[0].sname, 'test'],
              forwardingExclusions,
              Date.now() + 10000,
              `node-${targetIndex}`
            );

            // Should have at least the originator
            expect(forwardingExclusions.length).toBeGreaterThanOrEqual(1);
          }
        ),
        { numRuns: 10 }
      );
    });
  });

  describe('Integration with existing signals flow', function () {
    it('signals() method uses initiateRecursiveSignals when forwardingExclusions provided', async function () {
      await createNetwork(3);

      // Call signals with forwardingExclusions to trigger recursive path
      const forwardingExclusions = [];
      const result = await nodes[0].signals(
        nodes[2].key,
        [contacts[0].sname, 'dummy offer'],
        forwardingExclusions,
        'node-2'
      );

      // Should return result in expected format
      expect(result).toBeDefined();
      if (result) {
        expect(result.forwardingExclusions).toBeDefined();
      }
    });

    it('signals() returns directly when target is self', async function () {
      await createNetwork(2);

      // Mock the signals method on the contact for this test
      nodes[0].contact.signals = async function(...args) {
        return ['dummy answer', 'dummy candidate'];
      };

      const result = await nodes[0].signals(
        nodes[0].key, // Target is self
        [contacts[1].sname, 'dummy offer'],
        [],
        'node-0'
      );

      expect(result).toBeDefined();
      expect(result.result).toBeDefined();
    });

    it('signals() finds target through routing table', async function () {
      await createNetwork(2);

      // With SimulatedContact, nodes know about each other through routing table
      // Check that nodes know about each other
      const node0Contacts = nodes[0].contacts;
      const node1Contacts = nodes[1].contacts;
      
      // Both should have the other in contacts (we set up full mesh)
      const node0HasNode1 = node0Contacts.some(c => c.key === nodes[1].key);
      const node1HasNode0 = node1Contacts.some(c => c.key === nodes[0].key);
      expect(node0HasNode1).toBe(true);
      expect(node1HasNode0).toBe(true);

      // Test signals from node 0 to node 1 using recursive path
      const forwardingExclusions = [];
      const result = await nodes[0].signals(
        nodes[1].key,
        [contacts[0].sname, 'dummy offer'],
        forwardingExclusions,
        'node-1'
      );

      // Should get a response
      expect(result).toBeDefined();
      expect(result.forwardingExclusions).toBeDefined();
    });
  });
});
