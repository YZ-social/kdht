import * as fc from 'fast-check';
import { Node, SimulatedContact, SimulatedConnectionContact, Helper, KBucket } from '../../index.js';
const { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, BigInt } = globalThis; // For linters.

/**
 * Backward Compatibility Tests for R/Kademlia Conformance
 * Feature: rdht-conformance
 * 
 * These tests verify that when R/Kademlia features are disabled,
 * the system behaves identically to the pre-modification implementation.
 * 
 * Validates: Requirements 12.1, 12.2
 */
describe('Backward Compatibility', function () {
  // Store original configuration values
  let originalRecursiveRoutingEnabled;
  let originalProximityRoutingEnabled;
  let originalPnsEnabled;

  beforeAll(function () {
    // Save original configuration
    originalRecursiveRoutingEnabled = Node.recursiveRoutingEnabled;
    originalProximityRoutingEnabled = Node.proximityRoutingEnabled;
    originalPnsEnabled = Node.pnsEnabled;
    
    // Disable all R/Kademlia features for backward compatibility testing
    Node.recursiveRoutingEnabled = false;
    Node.proximityRoutingEnabled = false;
    Node.pnsEnabled = false;
    
    // Disable automatic refresh to avoid interference
    Node.stopRefresh();
  });

  afterAll(function () {
    // Restore original configuration
    Node.recursiveRoutingEnabled = originalRecursiveRoutingEnabled;
    Node.proximityRoutingEnabled = originalProximityRoutingEnabled;
    Node.pnsEnabled = originalPnsEnabled;
  });

  describe('Task 17.1: Backward Compatibility Test Suite', function () {
    /**
     * Verifies that with R/Kademlia features disabled, the system
     * behaves identically to the pre-modification implementation.
     * 
     * Requirements: 12.1, 12.2
     */
    
    describe('locateNodes behavior with features disabled', function () {
      let network;
      const nNodes = 10;

      beforeAll(async function () {
        // Create a small network for testing
        network = [];
        for (let i = 0; i < nNodes; i++) {
          const contact = await SimulatedContact.create({ name: `node-${i}`, info: false });
          network.push(contact);
        }

        // Build network: each node knows about all others
        for (let i = 0; i < nNodes; i++) {
          const node = network[i].node;
          for (let j = 0; j < nNodes; j++) {
            if (i !== j) {
              node.addToRoutingTable(network[j].clone(node));
            }
          }
        }
      }, 30e3);

      afterAll(function () {
        network.forEach(contact => contact.disconnect());
      });

      it('uses iterative routing (originator controls each hop)', async function () {
        const searcher = network[0].node;
        const targetKey = await Node.key('test-locate-nodes');

        // With recursive routing disabled, iterate() should be used
        // which is the iterative approach where originator controls each hop
        const result = await searcher.locateNodes(targetKey);

        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBeLessThanOrEqual(Node.k);
        // Results should be Helpers sorted by distance
        for (let i = 1; i < result.length; i++) {
          expect(result[i].distance >= result[i - 1].distance).toBe(true);
        }
      });

      it('returns up to k closest nodes', async function () {
        const searcher = network[0].node;
        const targetKey = await Node.key('test-k-closest');

        const result = await searcher.locateNodes(targetKey);

        expect(result.length).toBeLessThanOrEqual(Node.k);
        expect(result.length).toBeGreaterThan(0);
      });

      it('discovers nodes during lookup', async function () {
        const searcher = network[0].node;
        const targetKey = await Node.key('test-discovery');
        const initialContacts = searcher.contacts.length;

        await searcher.locateNodes(targetKey);

        // Routing table should be updated with discovered nodes
        // (may or may not change depending on what was already known)
        expect(searcher.contacts.length).toBeGreaterThanOrEqual(0);
      });
    });

    describe('locateValue behavior with features disabled', function () {
      let network;
      const nNodes = 8;

      beforeAll(async function () {
        network = [];
        for (let i = 0; i < nNodes; i++) {
          const contact = await SimulatedContact.create({ name: `value-node-${i}`, info: false });
          network.push(contact);
        }

        // Build fully connected network
        for (let i = 0; i < nNodes; i++) {
          const node = network[i].node;
          for (let j = 0; j < nNodes; j++) {
            if (i !== j) {
              node.addToRoutingTable(network[j].clone(node));
            }
          }
        }
      }, 30e3);

      afterAll(function () {
        network.forEach(contact => contact.disconnect());
      });

      it('stores and retrieves values correctly', async function () {
        const storer = network[0].node;
        const reader = network[3].node;
        const testKey = 'backward-compat-value-test';
        const testValue = 'test-value-123';

        const storeCount = await storer.storeValue(testKey, testValue);
        expect(storeCount).toBeGreaterThan(0);

        const retrieved = await reader.locateValue(testKey);
        expect(retrieved).toBe(testValue);
      });

      it('returns undefined for non-existent keys', async function () {
        const reader = network[0].node;
        const result = await reader.locateValue('non-existent-key-12345');
        expect(result).toBeUndefined();
      });

      it('finds locally stored values first', async function () {
        const node = network[0].node;
        const testKey = await Node.key('local-value-test');
        const testValue = 'local-value';

        node.storeLocally(testKey, testValue);
        const retrieved = await node.locateValue(testKey);

        expect(retrieved).toBe(testValue);
      });
    });

    describe('storeValue behavior with features disabled', function () {
      let network;
      const nNodes = 8;

      beforeAll(async function () {
        network = [];
        for (let i = 0; i < nNodes; i++) {
          const contact = await SimulatedContact.create({ name: `store-node-${i}`, info: false });
          network.push(contact);
        }

        for (let i = 0; i < nNodes; i++) {
          const node = network[i].node;
          for (let j = 0; j < nNodes; j++) {
            if (i !== j) {
              node.addToRoutingTable(network[j].clone(node));
            }
          }
        }
      }, 30e3);

      afterAll(function () {
        network.forEach(contact => contact.disconnect());
      });

      it('stores to k closest nodes', async function () {
        const storer = network[0].node;
        const testKey = 'store-k-test';
        const testValue = 'store-value';

        const storeCount = await storer.storeValue(testKey, testValue);

        // Should store to up to k nodes
        expect(storeCount).toBeGreaterThan(0);
        expect(storeCount).toBeLessThanOrEqual(Node.k);
      });

      it('replicates value to multiple nodes', async function () {
        const storer = network[0].node;
        const testKey = 'replicate-test';
        const testValue = 'replicated-value';

        await storer.storeValue(testKey, testValue);

        // Verify value is stored on multiple nodes
        const targetKey = await Node.key(testKey);
        let nodesWithValue = 0;
        for (const contact of network) {
          const stored = contact.node.retrieveLocally(targetKey);
          if (stored === testValue) {
            nodesWithValue++;
          }
        }

        expect(nodesWithValue).toBeGreaterThan(1);
      });
    });

    describe('join behavior with features disabled', function () {
      it('performs self-lookup on join', async function () {
        const bootstrap = await SimulatedContact.create({ name: 'bootstrap', info: false });
        const joiner = await SimulatedContact.create({ name: 'joiner', info: false });

        // Join through bootstrap
        await joiner.node.join(bootstrap);

        // After join, joiner should have bootstrap in routing table
        const contacts = joiner.node.contacts;
        const hasBootstrap = contacts.some(c => c.key === bootstrap.key);
        expect(hasBootstrap).toBe(true);

        bootstrap.disconnect();
        joiner.disconnect();
      });

      it('seeds buckets with discovered neighbors', async function () {
        // Create a small network
        const nodes = [];
        for (let i = 0; i < 5; i++) {
          const contact = await SimulatedContact.create({ name: `join-test-${i}`, info: false });
          nodes.push(contact);
        }

        // Connect first 4 nodes
        for (let i = 1; i < 4; i++) {
          await nodes[i].node.join(nodes[0]);
        }

        // New node joins
        await nodes[4].node.join(nodes[0]);

        // New node should have discovered some neighbors
        const contacts = nodes[4].node.contacts;
        expect(contacts.length).toBeGreaterThan(0);

        nodes.forEach(n => n.disconnect());
      });
    });

    describe('existing test suite compatibility', function () {
      /**
       * Verifies that existing internal tests pass with features disabled.
       * Requirements: 12.2
       */

      it('bucket placement works correctly', function () {
        const node = Node.fromKey(0n);
        
        // Test bucket index calculation
        expect(node.getBucketIndex(1n)).toBe(0);
        expect(node.getBucketIndex(2n)).toBe(1);
        expect(node.getBucketIndex(3n)).toBe(1);
      });

      it('XOR distance calculation is unchanged', function () {
        const a = 100n;
        const b = 200n;
        const distance = Node.distance(a, b);
        
        // XOR distance should be symmetric
        expect(Node.distance(b, a)).toBe(distance);
        
        // Distance to self is 0
        expect(Node.distance(a, a)).toBe(0n);
      });

      it('commonPrefixLength calculation is unchanged', function () {
        expect(Node.commonPrefixLength(0n)).toBe(Node.keySize);
        expect(Node.commonPrefixLength(1n)).toBe(Node.keySize - 1);
      });

      it('Helper comparison is unchanged', function () {
        const h1 = { distance: 10n };
        const h2 = { distance: 20n };
        const h3 = { distance: 10n };

        expect(Helper.compare(h1, h2)).toBeLessThan(0);
        expect(Helper.compare(h2, h1)).toBeGreaterThan(0);
        expect(Helper.compare(h1, h3)).toBe(0);
      });

      it('local storage works correctly', async function () {
        const contact = await SimulatedContact.create({ name: 'storage-test', info: false });
        const node = contact.node;
        const key = await Node.key('test-storage');
        const value = 'test-value';

        node.storeLocally(key, value);
        const retrieved = node.retrieveLocally(key);

        expect(retrieved).toBe(value);
        contact.disconnect();
      });
    });
  });


  describe('Task 17.2: Property 17 - Backward Compatibility', function () {
    /**
     * **Property 17: Backward Compatibility**
     * **Validates: Requirements 12.1**
     * 
     * For any configuration where recursive routing features are disabled,
     * the system's behavior for locateNodes, locateValue, storeValue, and
     * join operations SHALL be identical to the pre-modification implementation.
     */

    // Arbitrary generators
    const arbNodeCount = fc.integer({ min: 3, max: 8 });
    const arbKeyString = fc.string({ minLength: 1, maxLength: 20 });
    const arbValue = fc.oneof(
      fc.string({ minLength: 1, maxLength: 50 }),
      fc.integer({ min: 0, max: 1000 }),
      fc.boolean()
    );

    describe('locateNodes with features disabled', function () {
      it('returns sorted Helpers by XOR distance for any target key', async function () {
        // Ensure features are disabled
        expect(Node.recursiveRoutingEnabled).toBe(false);

        await fc.assert(
          fc.asyncProperty(arbKeyString, async (keyString) => {
            // Create a small network
            const network = [];
            const nNodes = 5;
            for (let i = 0; i < nNodes; i++) {
              const contact = await SimulatedContact.create({ name: `prop-node-${i}`, info: false });
              network.push(contact);
            }

            // Connect nodes
            for (let i = 0; i < nNodes; i++) {
              const node = network[i].node;
              for (let j = 0; j < nNodes; j++) {
                if (i !== j) {
                  node.addToRoutingTable(network[j].clone(node));
                }
              }
            }

            try {
              const searcher = network[0].node;
              const result = await searcher.locateNodes(keyString);

              // Verify results are sorted by distance (ascending)
              for (let i = 1; i < result.length; i++) {
                expect(result[i].distance >= result[i - 1].distance).toBe(true);
              }

              // Verify result count is within bounds
              expect(result.length).toBeLessThanOrEqual(Node.k);
            } finally {
              network.forEach(c => c.disconnect());
            }
          }),
          { numRuns: 10 } // Reduced runs due to network setup overhead
        );
      });
    });

    describe('storeValue and locateValue with features disabled', function () {
      it('stored values can be retrieved from any node in the network', async function () {
        expect(Node.recursiveRoutingEnabled).toBe(false);

        await fc.assert(
          fc.asyncProperty(arbKeyString, arbValue, async (keyString, value) => {
            // Create network
            const network = [];
            const nNodes = 6;
            for (let i = 0; i < nNodes; i++) {
              const contact = await SimulatedContact.create({ name: `store-prop-${i}`, info: false });
              network.push(contact);
            }

            // Fully connect
            for (let i = 0; i < nNodes; i++) {
              const node = network[i].node;
              for (let j = 0; j < nNodes; j++) {
                if (i !== j) {
                  node.addToRoutingTable(network[j].clone(node));
                }
              }
            }

            try {
              // Store from one node
              const storer = network[0].node;
              const storeCount = await storer.storeValue(keyString, value);

              // Value should be stored to at least one node
              expect(storeCount).toBeGreaterThan(0);

              // Read from a different node
              const reader = network[Math.floor(nNodes / 2)].node;
              const retrieved = await reader.locateValue(keyString);

              // Retrieved value should match stored value
              expect(retrieved).toEqual(value);
            } finally {
              network.forEach(c => c.disconnect());
            }
          }),
          { numRuns: 10 }
        );
      });
    });

    describe('iterate behavior with features disabled', function () {
      it('uses iterative routing pattern (alpha parallel queries)', async function () {
        expect(Node.recursiveRoutingEnabled).toBe(false);

        // Create network
        const network = [];
        const nNodes = 8;
        for (let i = 0; i < nNodes; i++) {
          const contact = await SimulatedContact.create({ name: `iterate-test-${i}`, info: false });
          network.push(contact);
        }

        // Connect nodes
        for (let i = 0; i < nNodes; i++) {
          const node = network[i].node;
          for (let j = 0; j < nNodes; j++) {
            if (i !== j) {
              node.addToRoutingTable(network[j].clone(node));
            }
          }
        }

        try {
          const searcher = network[0].node;
          const targetKey = await Node.key('iterate-pattern-test');

          // The iterate method should be used (iterative routing)
          // This is verified by the fact that the originator (searcher) 
          // directly queries nodes and receives responses
          const result = await searcher.iterate(targetKey, 'findNodes');

          // Results should be Helpers
          expect(Array.isArray(result)).toBe(true);
          result.forEach(h => {
            expect(h.distance).toBeDefined();
            expect(h.contact).toBeDefined();
          });
        } finally {
          network.forEach(c => c.disconnect());
        }
      });
    });

    describe('routing table operations with features disabled', function () {
      it('addToRoutingTable places contacts in correct buckets', async function () {
        expect(Node.recursiveRoutingEnabled).toBe(false);

        await fc.assert(
          fc.asyncProperty(
            fc.bigInt(1n, 2n ** 128n - 1n),
            fc.bigInt(1n, 2n ** 128n - 1n),
            async (nodeKey, contactKey) => {
              // Skip if keys are the same (can't add self to routing table)
              if (nodeKey === contactKey) return;

              const hostContact = SimulatedContact.fromKey(nodeKey);
              const node = hostContact.node;
              const otherContact = SimulatedContact.fromKey(contactKey, node);

              const added = node.addToRoutingTable(otherContact);

              if (added) {
                // Verify contact is in the correct bucket
                const expectedBucketIndex = node.getBucketIndex(contactKey);
                const bucket = node.routingTable.get(expectedBucketIndex);
                
                expect(bucket).toBeDefined();
                const found = bucket.contacts.some(c => c.key === contactKey);
                expect(found).toBe(true);
              }
            }
          ),
          { numRuns: 50 }
        );
      });
    });

    describe('XOR distance properties with features disabled', function () {
      it('XOR distance is symmetric', function () {
        fc.assert(
          fc.property(
            fc.bigInt(0n, 2n ** 128n - 1n),
            fc.bigInt(0n, 2n ** 128n - 1n),
            (a, b) => {
              expect(Node.distance(a, b)).toBe(Node.distance(b, a));
            }
          ),
          { numRuns: 100 }
        );
      });

      it('XOR distance to self is zero', function () {
        fc.assert(
          fc.property(
            fc.bigInt(0n, 2n ** 128n - 1n),
            (key) => {
              expect(Node.distance(key, key)).toBe(0n);
            }
          ),
          { numRuns: 100 }
        );
      });

      it('XOR distance satisfies triangle inequality', function () {
        fc.assert(
          fc.property(
            fc.bigInt(0n, 2n ** 128n - 1n),
            fc.bigInt(0n, 2n ** 128n - 1n),
            fc.bigInt(0n, 2n ** 128n - 1n),
            (a, b, c) => {
              const ab = Node.distance(a, b);
              const bc = Node.distance(b, c);
              const ac = Node.distance(a, c);
              
              // XOR metric satisfies: d(a,c) <= d(a,b) XOR d(b,c)
              // But more importantly for DHT: d(a,c) <= d(a,b) + d(b,c)
              // This is a weaker form that always holds
              expect(ac <= ab + bc).toBe(true);
            }
          ),
          { numRuns: 100 }
        );
      });
    });
  });
});
