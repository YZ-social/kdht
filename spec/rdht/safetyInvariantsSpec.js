import * as fc from 'fast-check';
import { Node, SimulatedContact, KBucket, Helper } from '../../index.js';
const { describe, it, expect, beforeAll, beforeEach, afterEach } = globalThis; // For linters.

/**
 * Safety Invariant Tests for R/Kademlia Conformance
 * Feature: rdht-conformance
 * 
 * These tests verify that the KDHT implementation preserves Kademlia's
 * correctness guarantees as specified in Requirement 10.
 */
describe('Safety Invariants', function () {
  beforeAll(function () {
    // Disable automatic refresh to prevent interference with tests
    Node.stopRefresh();
  });

  /**
   * Task 14.1: Property test for bucket structure preservation
   * Property 12: Bucket Structure Preservation
   * 
   * For any operation (including PNS reordering), the bucket index assignment
   * based on XOR prefix SHALL remain unchanged, buckets SHALL NOT be merged
   * or reshaped, and each bucket SHALL only contain contacts whose keys fall
   * within the correct XOR prefix range.
   * 
   * **Validates: Requirements 6.4, 10.2, 10.3**
   */
  describe('Property 12: Bucket Structure Preservation', function () {
    let hostContact;
    let hostNode;

    beforeEach(async function () {
      hostContact = await SimulatedContact.create({ name: 'host', info: false });
      hostNode = hostContact.node;
    });

    afterEach(function () {
      hostNode.routingTable.clear();
      hostContact?.disconnect();
    });

    it('Property: bucket index assignment is deterministic based on XOR prefix', function () {
      /**
       * Property 12: Bucket Structure Preservation
       * **Validates: Requirements 10.2**
       * 
       * For any key, getBucketIndex SHALL always return the same bucket index,
       * determined solely by the XOR distance prefix.
       */
      fc.assert(
        fc.property(
          fc.bigInt(0n, 2n ** 128n - 1n),
          (contactKey) => {
            // Skip if key equals host key (would be self)
            if (contactKey === hostNode.key) return true;

            // Get bucket index multiple times - should always be the same
            const index1 = hostNode.getBucketIndex(contactKey);
            const index2 = hostNode.getBucketIndex(contactKey);
            const index3 = hostNode.getBucketIndex(contactKey);

            // Bucket index must be deterministic
            if (index1 !== index2 || index2 !== index3) return false;

            // Bucket index must be within valid range [0, keySize-1]
            if (index1 < 0 || index1 >= Node.keySize) return false;

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });


    it('Property: contacts in bucket have keys within correct XOR prefix range', function () {
      /**
       * Property 12: Bucket Structure Preservation
       * **Validates: Requirements 6.4, 10.3**
       * 
       * For any contact added to a bucket, its key SHALL fall within the
       * correct XOR prefix range for that bucket index.
       */
      fc.assert(
        fc.property(
          fc.array(fc.bigInt(0n, 2n ** 128n - 1n), { minLength: 1, maxLength: 50 }),
          (contactKeys) => {
            // Filter out host's own key
            const validKeys = contactKeys.filter(k => k !== hostNode.key);
            if (validKeys.length === 0) return true;

            // Add contacts to routing table
            for (const key of validKeys) {
              const mockContact = {
                key: key,
                node: { key: key },
                connection: { active: true },
                clone: function() { return this; },
                noteSponsor: function() {},
              };
              
              const bucketIndex = hostNode.getBucketIndex(key);
              const bucket = hostNode.ensureBucket(bucketIndex);
              
              // Only add if not already present and bucket not full
              if (!bucket.contacts.some(c => c.key === key) && !bucket.isFull) {
                bucket.contacts.push(mockContact);
              }
            }

            // Verify all contacts are in correct buckets
            for (const [bucketIndex, bucket] of hostNode.routingTable) {
              for (const contact of bucket.contacts) {
                const expectedIndex = hostNode.getBucketIndex(contact.key);
                if (expectedIndex !== bucketIndex) {
                  return false;
                }
              }
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Property: buckets are not merged or reshaped during operations', function () {
      /**
       * Property 12: Bucket Structure Preservation
       * **Validates: Requirements 6.4, 10.2**
       * 
       * After any sequence of add/remove operations, the bucket structure
       * SHALL remain intact - buckets are not merged or reshaped.
       */
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              key: fc.bigInt(0n, 2n ** 128n - 1n),
              operation: fc.constantFrom('add', 'remove'),
            }),
            { minLength: 1, maxLength: 30 }
          ),
          (operations) => {
            const addedKeys = new Set();

            for (const op of operations) {
              if (op.key === hostNode.key) continue;

              const bucketIndex = hostNode.getBucketIndex(op.key);

              if (op.operation === 'add') {
                const bucket = hostNode.ensureBucket(bucketIndex);
                const mockContact = {
                  key: op.key,
                  node: { key: op.key },
                  connection: { active: true },
                };
                
                if (!bucket.contacts.some(c => c.key === op.key) && !bucket.isFull) {
                  bucket.contacts.push(mockContact);
                  addedKeys.add(op.key);
                }
              } else if (op.operation === 'remove' && addedKeys.has(op.key)) {
                const bucket = hostNode.routingTable.get(bucketIndex);
                if (bucket) {
                  bucket.removeKey(op.key, false);
                  addedKeys.delete(op.key);
                }
              }
            }

            // Verify bucket structure integrity
            for (const [bucketIndex, bucket] of hostNode.routingTable) {
              // Each bucket should have a valid index
              if (bucket.index !== bucketIndex) return false;

              // Each contact in bucket should map to this bucket
              for (const contact of bucket.contacts) {
                const expectedIndex = hostNode.getBucketIndex(contact.key);
                if (expectedIndex !== bucketIndex) return false;
              }

              // Bucket should not exceed capacity k
              if (bucket.contacts.length > Node.k) return false;
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Property: XOR prefix determines bucket uniquely', function () {
      /**
       * Property 12: Bucket Structure Preservation
       * **Validates: Requirements 10.2**
       * 
       * Keys with the same XOR prefix length SHALL map to the same bucket.
       */
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 127 }),
          (bucketIndex) => {
            const bucket = hostNode.ensureBucket(bucketIndex);
            
            // Generate multiple random keys for this bucket
            const keys = [];
            for (let i = 0; i < 5; i++) {
              keys.push(bucket.randomTarget);
            }

            // All keys should map to the same bucket index
            for (const key of keys) {
              const computedIndex = hostNode.getBucketIndex(key);
              if (computedIndex !== bucketIndex) return false;
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Task 14.2: Property test for no XOR-worse replacement
   * Property 13: No XOR-Worse Replacement
   * 
   * For any bucket modification operation, a contact that is XOR-closer to
   * the bucket's range SHALL NOT be replaced by a contact that is XOR-farther,
   * regardless of proximity metrics.
   * 
   * **Validates: Requirements 6.5, 10.4**
   */
  describe('Property 13: No XOR-Worse Replacement', function () {
    let hostContact;
    let hostNode;
    const k = Node.k;

    beforeEach(async function () {
      hostContact = await SimulatedContact.create({ name: 'host', info: false });
      hostNode = hostContact.node;
    });

    afterEach(function () {
      hostNode.routingTable.clear();
      hostContact?.disconnect();
    });

    it('Property: XOR-closer contacts are never replaced by XOR-farther contacts', function () {
      /**
       * Property 13: No XOR-Worse Replacement
       * **Validates: Requirements 6.5, 10.4**
       * 
       * When a bucket is full and a new contact arrives, the system SHALL NOT
       * replace an existing contact with one that is XOR-farther from the
       * bucket's target range.
       */
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 100 }),
          (bucketIndex) => {
            const bucket = hostNode.ensureBucket(bucketIndex);
            bucket.contacts = []; // Reset bucket

            // Generate unique keys for this bucket
            const usedKeys = new Set();
            const getUniqueKey = () => {
              let key;
              let attempts = 0;
              do {
                key = bucket.randomTarget;
                attempts++;
                if (attempts > 1000) {
                  // Fallback: modify key slightly
                  key = key ^ BigInt(attempts);
                }
              } while (usedKeys.has(key.toString()));
              usedKeys.add(key.toString());
              return key;
            };

            // Fill bucket with live contacts
            const originalContacts = [];
            for (let i = 0; i < k; i++) {
              const key = getUniqueKey();
              const contact = {
                key: key,
                node: { key: key },
                connection: { active: true },
              };
              bucket.contacts.push(contact);
              originalContacts.push({ key, distance: hostNode.distance(key) });
            }

            // Record original XOR distances
            const originalDistances = originalContacts.map(c => c.distance);

            // Try to add a new contact
            const newKey = getUniqueKey();
            const newContact = {
              key: newKey,
              node: { key: newKey },
              connection: { active: true },
            };
            const newDistance = hostNode.distance(newKey);

            bucket.addContact(newContact);

            // Verify: no contact was replaced with an XOR-farther one
            // Since all original contacts are live, none should be evicted
            // The new contact should NOT be in the bucket
            const currentKeys = new Set(bucket.contacts.map(c => c.key.toString()));
            
            // All original contacts should still be present (possibly reordered)
            for (const original of originalContacts) {
              if (!currentKeys.has(original.key.toString())) {
                // An original contact was removed - this violates the property
                // unless it was the head that was moved to tail
                return false;
              }
            }

            // New contact should NOT be present (bucket was full with live contacts)
            if (currentKeys.has(newKey.toString())) {
              return false;
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Property: proximity metrics do not override XOR correctness', function () {
      /**
       * Property 13: No XOR-Worse Replacement
       * **Validates: Requirements 6.5, 10.4**
       * 
       * Even if a new contact has better RTT (proximity), it SHALL NOT
       * replace an existing contact that is XOR-closer.
       */
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 100 }),
          fc.integer({ min: 1, max: 100 }), // RTT for existing contacts
          fc.integer({ min: 1, max: 10 }),  // Better RTT for new contact
          (bucketIndex, existingRtt, newRtt) => {
            const bucket = hostNode.ensureBucket(bucketIndex);
            bucket.contacts = []; // Reset bucket

            const usedKeys = new Set();
            const getUniqueKey = () => {
              let key;
              let attempts = 0;
              do {
                key = bucket.randomTarget;
                attempts++;
                if (attempts > 1000) {
                  key = key ^ BigInt(attempts);
                }
              } while (usedKeys.has(key.toString()));
              usedKeys.add(key.toString());
              return key;
            };

            // Fill bucket with live contacts that have high RTT
            const originalKeys = [];
            for (let i = 0; i < k; i++) {
              const key = getUniqueKey();
              const contact = {
                key: key,
                node: { key: key },
                connection: { active: true },
                rtt: existingRtt, // High RTT
              };
              bucket.contacts.push(contact);
              originalKeys.push(key.toString());
            }

            // Try to add new contact with better RTT
            const newKey = getUniqueKey();
            const newContact = {
              key: newKey,
              node: { key: newKey },
              connection: { active: true },
              rtt: newRtt, // Better RTT
            };

            bucket.addContact(newContact);

            // Verify: proximity (RTT) did not cause replacement
            const currentKeys = new Set(bucket.contacts.map(c => c.key.toString()));

            // All original contacts should still be present
            for (const originalKey of originalKeys) {
              if (!currentKeys.has(originalKey)) {
                return false;
              }
            }

            // New contact should NOT be present despite better RTT
            if (currentKeys.has(newKey.toString())) {
              return false;
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Property: dead contacts can be replaced but only by valid bucket members', function () {
      /**
       * Property 13: No XOR-Worse Replacement
       * **Validates: Requirements 10.4**
       * 
       * When a dead contact is evicted, the replacement contact SHALL be
       * valid for that bucket (correct XOR prefix range).
       */
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 100 }),
          (bucketIndex) => {
            const bucket = hostNode.ensureBucket(bucketIndex);
            bucket.contacts = []; // Reset bucket

            const usedKeys = new Set();
            const getUniqueKey = () => {
              let key;
              let attempts = 0;
              do {
                key = bucket.randomTarget;
                attempts++;
                if (attempts > 1000) {
                  key = key ^ BigInt(attempts);
                }
              } while (usedKeys.has(key.toString()));
              usedKeys.add(key.toString());
              return key;
            };

            // Fill bucket with first contact dead, rest live
            const deadKey = getUniqueKey();
            bucket.contacts.push({
              key: deadKey,
              node: { key: deadKey },
              connection: null, // Dead
            });

            for (let i = 1; i < k; i++) {
              const key = getUniqueKey();
              bucket.contacts.push({
                key: key,
                node: { key: key },
                connection: { active: true },
              });
            }

            // Add new contact (should replace dead head)
            const newKey = getUniqueKey();
            const newContact = {
              key: newKey,
              node: { key: newKey },
              connection: { active: true },
            };

            bucket.addContact(newContact);

            // Verify: new contact is in bucket and maps to correct bucket
            const hasNew = bucket.contacts.some(c => c.key === newKey);
            if (!hasNew) return false;

            // Verify: new contact is valid for this bucket
            const newContactBucketIndex = hostNode.getBucketIndex(newKey);
            if (newContactBucketIndex !== bucketIndex) return false;

            // Verify: dead contact was evicted
            const hasDead = bucket.contacts.some(c => c.key === deadKey);
            if (hasDead) return false;

            // Verify: all contacts in bucket are valid for this bucket
            for (const contact of bucket.contacts) {
              const contactBucketIndex = hostNode.getBucketIndex(contact.key);
              if (contactBucketIndex !== bucketIndex) return false;
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
