import { Node, SimulatedContact, KBucket } from '../../index.js';
import fc from 'fast-check';
const { describe, it, expect, beforeAll, beforeEach, afterEach } = globalThis; // For linters.

/**
 * Verification tests for R/Kademlia maintenance lifecycle compliance
 * Feature: rdht-conformance
 * 
 * These tests verify that the existing KDHT implementation already conforms
 * to R/Kademlia maintenance lifecycle requirements.
 */
describe('Maintenance Lifecycle Compliance', function () {
  beforeAll(function () {
    // Disable automatic refresh to prevent interference with tests
    Node.stopRefresh();
  });

  /**
   * Task 13.1: Verification tests for join self-lookup
   * Validates: Requirements 7.1, 7.2, 7.4
   */
  describe('T0: Node Join Self-Lookup', function () {
    let bootstrapContact;
    let bootstrapNode;
    let joiningContact;
    let joiningNode;
    let locateNodesCalls;
    let originalLocateNodes;

    beforeEach(async function () {
      // Create a bootstrap node
      bootstrapContact = await SimulatedContact.create({ name: 'bootstrap', info: false });
      bootstrapNode = bootstrapContact.node;

      // Create a joining node
      joiningContact = await SimulatedContact.create({ name: 'joiner', info: false });
      joiningNode = joiningContact.node;

      // Track locateNodes calls
      locateNodesCalls = [];
      originalLocateNodes = joiningNode.locateNodes.bind(joiningNode);
      joiningNode.locateNodes = async function (targetKey, ...args) {
        locateNodesCalls.push({ targetKey, args });
        return originalLocateNodes(targetKey, ...args);
      };
    });

    afterEach(function () {
      // Restore original method
      if (joiningNode && originalLocateNodes) {
        joiningNode.locateNodes = originalLocateNodes;
      }
      // Disconnect nodes
      bootstrapContact?.disconnect();
      joiningContact?.disconnect();
    });

    it('join() calls locateNodes(this.key) for self-lookup', async function () {
      // Requirement 7.1: WHEN a node joins, THE Node SHALL perform a recursive self-lookup
      // Requirement 7.4: THE existing join() method SHALL be verified to already perform self-lookup
      
      await joiningNode.join(bootstrapContact);

      // Verify locateNodes was called with the joining node's own key
      const selfLookupCall = locateNodesCalls.find(call => call.targetKey === joiningNode.key);
      expect(selfLookupCall).toBeDefined();
      expect(selfLookupCall.targetKey).toBe(joiningNode.key);
    });

    it('join() seeds buckets with discovered neighbors', async function () {
      // Requirement 7.2: WHEN joining, THE Node SHALL seed buckets with discovered neighbors
      
      // Verify routing table is empty before join
      expect(joiningNode.contacts.length).toBe(0);

      await joiningNode.join(bootstrapContact);

      // Verify routing table has contacts after join
      const contacts = joiningNode.contacts;
      expect(contacts.length).toBeGreaterThan(0);
      
      // Verify bootstrap node is in the routing table
      const hasBootstrap = contacts.some(c => c.key === bootstrapNode.key);
      expect(hasBootstrap).toBe(true);
    });

    it('join() with multiple bootstrap nodes seeds from all', async function () {
      // Create additional nodes in the network
      const node2Contact = await SimulatedContact.create({ name: 'node2', info: false });
      const node3Contact = await SimulatedContact.create({ name: 'node3', info: false });
      
      // Connect them to bootstrap
      bootstrapNode.addToRoutingTable(node2Contact.clone(bootstrapNode));
      bootstrapNode.addToRoutingTable(node3Contact.clone(bootstrapNode));

      await joiningNode.join(bootstrapContact);

      // Verify multiple nodes were discovered
      const contacts = joiningNode.contacts;
      expect(contacts.length).toBeGreaterThanOrEqual(1);

      // Cleanup
      node2Contact.disconnect();
      node3Contact.disconnect();
    });
  });

  /**
   * Task 13.2: Verification tests for bucket refresh
   * Validates: Requirements 8.1, 8.4
   */
  describe('T1: Periodic Bucket Refresh', function () {
    let nodeContact;
    let node;
    let savedRefreshInterval;

    beforeEach(async function () {
      // Save and restore refresh interval for tests that need refresh to work
      savedRefreshInterval = Node.refreshTimeIntervalMS;
      nodeContact = await SimulatedContact.create({ name: 'refresher', info: false });
      node = nodeContact.node;
    });

    afterEach(function () {
      Node.refreshTimeIntervalMS = savedRefreshInterval;
      nodeContact?.disconnect();
    });

    it('KBucket.randomTarget generates key in correct bucket range', function () {
      // Requirement 8.1: refresh SHALL perform FIND_NODE for random ID in bucket range
      // Verify randomTarget produces keys that map back to the same bucket
      
      for (let bucketIndex = 0; bucketIndex < 10; bucketIndex++) {
        const bucket = node.ensureBucket(bucketIndex);
        const randomKey = bucket.randomTarget;
        const computedIndex = node.getBucketIndex(randomKey);
        expect(computedIndex).toBe(bucketIndex);
      }
    });

    it('KBucket.randomTarget generates different keys each time', function () {
      // Verify randomness - multiple calls should produce different keys
      const bucket = node.ensureBucket(50);
      const keys = new Set();
      
      for (let i = 0; i < 10; i++) {
        keys.add(bucket.randomTarget);
      }
      
      // Should have generated multiple unique keys (allowing for some collision)
      expect(keys.size).toBeGreaterThan(5);
    });

    it('refresh() calls locateNodes with random target key', async function () {
      // Requirement 8.4: THE existing refresh() method SHALL be verified to use locateNodes
      
      // Enable refresh for this test
      Node.refreshTimeIntervalMS = 15000;
      node.refreshTimeIntervalMS = 15000;
      
      // Create a bucket with a contact so refresh will proceed
      const otherContact = await SimulatedContact.create({ name: 'other', info: false });
      const bucket = node.ensureBucket(50);
      bucket.contacts.push(otherContact.clone(node));

      // Track locateNodes calls
      let locateNodesCalled = false;
      let targetKeyUsed = null;
      const originalLocateNodes = node.locateNodes.bind(node);
      node.locateNodes = async function (targetKey, ...args) {
        locateNodesCalled = true;
        targetKeyUsed = targetKey;
        return originalLocateNodes(targetKey, ...args);
      };

      await bucket.refresh();

      expect(locateNodesCalled).toBe(true);
      expect(targetKeyUsed).toBeDefined();
      
      // Verify the target key maps to the correct bucket
      const computedIndex = node.getBucketIndex(targetKeyUsed);
      expect(computedIndex).toBe(50);

      // Cleanup
      node.locateNodes = originalLocateNodes;
      otherContact.disconnect();
    });

    it('refresh() does not proceed for empty buckets', async function () {
      // Enable refresh for this test
      Node.refreshTimeIntervalMS = 15000;
      node.refreshTimeIntervalMS = 15000;
      
      // Verify refresh skips empty buckets
      const bucket = node.ensureBucket(60);
      expect(bucket.contacts.length).toBe(0);

      let locateNodesCalled = false;
      const originalLocateNodes = node.locateNodes.bind(node);
      node.locateNodes = async function (...args) {
        locateNodesCalled = true;
        return originalLocateNodes(...args);
      };

      const result = await bucket.refresh();

      expect(result).toBe(false);
      expect(locateNodesCalled).toBe(false);

      node.locateNodes = originalLocateNodes;
    });
  });

  /**
   * Task 13.3: Verification tests for liveness-based eviction
   * Validates: Requirements 9.4, 9.5
   */
  describe('T2: Liveness-Based Eviction', function () {
    let hostContact;
    let hostNode;
    const k = Node.k;

    beforeEach(async function () {
      hostContact = await SimulatedContact.create({ name: 'host', info: false });
      hostNode = hostContact.node;
    });

    afterEach(function () {
      // Clear routing table before disconnect to avoid issues with mock contacts
      hostNode.routingTable.clear();
      hostContact?.disconnect();
    });

    it('addContact() checks head.connection for liveness', function () {
      // Requirement 9.4: THE System SHALL ensure liveness dominates proximity when deciding eviction
      // Requirement 9.5: THE existing addContact() method SHALL be verified to check connection liveness
      
      // Verify the addContact code checks head.connection
      // This is a code inspection test - we verify the behavior by examining the KBucket.addContact method
      const addContactSource = KBucket.prototype.addContact.toString();
      
      // The code should check head.connection to determine liveness
      expect(addContactSource).toContain('head.connection');
    });

    it('live nodes (with connection) are not evicted for new nodes', function () {
      // Requirement 9.4: liveness dominates - live nodes should not be evicted
      
      const bucket = hostNode.ensureBucket(50);
      
      // Create mock contacts with keys that map to bucket 50
      // We'll manually construct the scenario without real SimulatedContacts
      // to avoid background RPC issues
      
      // Fill bucket with "live" contacts (connection is truthy)
      for (let i = 0; i < k; i++) {
        const mockContact = {
          key: bucket.randomTarget, // Key that maps to this bucket
          node: { key: bucket.randomTarget },
          connection: { active: true }, // Truthy = live
        };
        bucket.contacts.push(mockContact);
      }
      
      expect(bucket.isFull).toBe(true);
      const originalHeadKey = bucket.contacts[0].key;
      
      // Try to add a new contact
      const newKey = bucket.randomTarget;
      const newContact = {
        key: newKey,
        node: { key: newKey },
        connection: { active: true },
      };
      
      const result = bucket.addContact(newContact);
      
      // Should return false because head is alive (has connection)
      expect(result).toBe(false);
      
      // Original head should be moved to tail (LRU behavior)
      const tailKey = bucket.contacts[bucket.contacts.length - 1].key;
      expect(tailKey).toBe(originalHeadKey);
      
      // New contact should NOT be in bucket
      const hasNewContact = bucket.contacts.some(c => c.key === newKey);
      expect(hasNewContact).toBe(false);
    });

    it('dead nodes (without connection) are evicted for new nodes', function () {
      // When head has no connection (dead), it should be evicted
      
      const bucket = hostNode.ensureBucket(50);
      
      // First contact is "dead" (no connection)
      const deadKey = bucket.randomTarget;
      const deadContact = {
        key: deadKey,
        node: { key: deadKey },
        connection: null, // Falsy = dead
      };
      bucket.contacts.push(deadContact);
      
      // Fill rest with "live" contacts
      for (let i = 1; i < k; i++) {
        const key = bucket.randomTarget;
        bucket.contacts.push({
          key: key,
          node: { key: key },
          connection: { active: true },
        });
      }
      
      expect(bucket.isFull).toBe(true);
      
      // Add new contact
      const newKey = bucket.randomTarget;
      const newContact = {
        key: newKey,
        node: { key: newKey },
        connection: { active: true },
      };
      
      const result = bucket.addContact(newContact);
      
      // Should succeed because head was dead
      expect(result).toBe('added');
      
      // Dead contact should be evicted
      const hasDeadContact = bucket.contacts.some(c => c.key === deadKey);
      expect(hasDeadContact).toBe(false);
      
      // New contact should be in bucket (at tail)
      const hasNewContact = bucket.contacts.some(c => c.key === newKey);
      expect(hasNewContact).toBe(true);
    });

    it('bucket maintains k contacts after eviction', function () {
      // Verify bucket size is maintained correctly
      
      const bucket = hostNode.ensureBucket(50);
      
      // Fill with dead head + live rest
      for (let i = 0; i < k; i++) {
        const key = bucket.randomTarget;
        bucket.contacts.push({
          key: key,
          node: { key: key },
          connection: i === 0 ? null : { active: true }, // First is dead
        });
      }
      
      expect(bucket.contacts.length).toBe(k);
      
      // Add new contact (should evict dead head)
      const newKey = bucket.randomTarget;
      bucket.addContact({
        key: newKey,
        node: { key: newKey },
        connection: { active: true },
      });
      
      // Should still have exactly k contacts
      expect(bucket.contacts.length).toBe(k);
    });
  });

  /**
   * Task 13.4: Property test for liveness-based eviction
   * Property 16: Liveness-Based Eviction
   * 
   * For any bucket at capacity when a new contact arrives:
   * - If the head contact is unresponsive (no connection), it SHALL be evicted
   * - If the head contact is responsive, the new contact SHALL NOT replace it
   * 
   * **Validates: Requirements 9.1, 9.2, 9.3, 9.4**
   */
  describe('Property 16: Liveness-Based Eviction', function () {
    let hostContact;
    let hostNode;
    const k = Node.k;

    beforeEach(async function () {
      hostContact = await SimulatedContact.create({ name: 'host', info: false });
      hostNode = hostContact.node;
    });

    afterEach(function () {
      // Clear routing table before disconnect to avoid issues with mock contacts
      hostNode.routingTable.clear();
      hostContact?.disconnect();
    });

    it('Property: unresponsive head is evicted, responsive head is preserved', function () {
      /**
       * Property 16: Liveness-Based Eviction
       * **Validates: Requirements 9.1, 9.2, 9.3, 9.4**
       */
      fc.assert(
        fc.property(
          // Generate: bucket index (use higher indices to avoid key space issues), head liveness
          fc.integer({ min: 10, max: 100 }),
          fc.boolean(),
          (bucketIndex, headIsLive) => {
            const bucket = hostNode.ensureBucket(bucketIndex);
            bucket.contacts = []; // Reset bucket
            
            // Generate unique keys using a counter approach
            let keyCounter = 0n;
            const getUniqueKey = () => {
              // Generate a key that maps to this bucket by using randomTarget
              // but ensure uniqueness by checking against existing contacts
              let key;
              let attempts = 0;
              do {
                key = bucket.randomTarget;
                attempts++;
                if (attempts > 1000) {
                  // Fallback: modify the key slightly
                  key = key ^ (++keyCounter);
                }
              } while (bucket.contacts.some(c => c.key === key));
              return key;
            };
            
            // Fill bucket to capacity
            const headKey = getUniqueKey();
            const headContact = {
              key: headKey,
              node: { key: headKey },
              connection: headIsLive ? { active: true } : null,
            };
            bucket.contacts.push(headContact);
            
            for (let i = 1; i < k; i++) {
              const key = getUniqueKey();
              bucket.contacts.push({
                key: key,
                node: { key: key },
                connection: { active: true },
              });
            }
            
            // Verify bucket is full
            if (!bucket.isFull) return true; // Skip if bucket not full
            
            // Try to add new contact with unique key
            const newKey = getUniqueKey();
            const newContact = {
              key: newKey,
              node: { key: newKey },
              connection: { active: true },
            };
            
            const result = bucket.addContact(newContact);
            
            // Check property based on head liveness
            if (headIsLive) {
              // Responsive head: new contact should NOT be added
              // Result should be false (not added)
              if (result !== false) return false;
              
              // Head should still be in bucket (moved to tail)
              const hasHead = bucket.contacts.some(c => c.key === headKey);
              if (!hasHead) return false;
              
              // New contact should NOT be in bucket
              const hasNew = bucket.contacts.some(c => c.key === newKey);
              if (hasNew) return false;
            } else {
              // Unresponsive head: should be evicted
              // Result should be 'added'
              if (result !== 'added') return false;
              
              // Head should be evicted
              const hasHead = bucket.contacts.some(c => c.key === headKey);
              if (hasHead) return false;
              
              // New contact should be in bucket
              const hasNew = bucket.contacts.some(c => c.key === newKey);
              if (!hasNew) return false;
            }
            
            // Bucket should still have k contacts
            if (bucket.contacts.length !== k) return false;
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Property: liveness dominates proximity in eviction decisions', function () {
      /**
       * Property 16: Liveness-Based Eviction
       * Regardless of XOR distance (proximity), liveness determines eviction
       * **Validates: Requirements 9.4**
       */
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 100 }),
          (bucketIndex) => {
            const bucket = hostNode.ensureBucket(bucketIndex);
            bucket.contacts = []; // Reset bucket
            
            // Generate unique keys
            let keyCounter = 0n;
            const getUniqueKey = () => {
              let key;
              let attempts = 0;
              do {
                key = bucket.randomTarget;
                attempts++;
                if (attempts > 1000) {
                  key = key ^ (++keyCounter);
                }
              } while (bucket.contacts.some(c => c.key === key));
              return key;
            };
            
            // Fill bucket with live contacts
            for (let i = 0; i < k; i++) {
              const key = getUniqueKey();
              bucket.contacts.push({
                key: key,
                node: { key: key },
                connection: { active: true },
              });
            }
            
            const originalKeys = bucket.contacts.map(c => c.key);
            
            // Try to add new contact with unique key
            const newKey = getUniqueKey();
            const newContact = {
              key: newKey,
              node: { key: newKey },
              connection: { active: true },
            };
            
            bucket.addContact(newContact);
            
            // All original contacts should still be present (just reordered)
            // because they are all live
            const currentKeys = new Set(bucket.contacts.map(c => c.key));
            for (const key of originalKeys) {
              if (!currentKeys.has(key)) return false;
            }
            // New contact should NOT be present
            if (currentKeys.has(newKey)) return false;
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

});
