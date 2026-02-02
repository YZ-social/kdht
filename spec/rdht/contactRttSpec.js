import * as fc from 'fast-check';
import { Node, SimulatedContact } from '../../index.js';
const { describe, it, expect, beforeAll, afterAll } = globalThis; // For linters.

/**
 * Property-based tests for Contact RTT tracking
 * Feature: rdht-conformance
 */
describe('Contact RTT Tracking', function () {
  beforeAll(function () {
    Node.stopRefresh();
  });

  describe('Property 8: RTT Measurement During RPC', function () {
    /**
     * **Validates: Requirements 5.1, 5.3**
     * 
     * For any successful RPC call (non-null result), the Contact's rtt property
     * SHALL be updated with the measured round-trip time, and no separate probing
     * traffic SHALL be generated for this measurement.
     */
    it('updates RTT on successful RPC calls', async function () {
      // Create two nodes
      const contact1 = await SimulatedContact.create({ name: 'rtt-test-1' });
      const contact2 = await SimulatedContact.create({ name: 'rtt-test-2' });
      const node1 = contact1.node;
      const node2 = contact2.node;

      // Create a contact from node1 to node2
      const contactToNode2 = SimulatedContact.fromNode(node2, node1);

      // Verify RTT is initially null
      expect(contactToNode2.rtt).toBeNull();
      expect(contactToNode2.rttUpdatedAt).toBeNull();

      // Make a successful RPC call (ping)
      const beforeCall = Date.now();
      const result = await contactToNode2.sendRPC('ping', node1.key);
      const afterCall = Date.now();

      // Verify the call succeeded
      expect(result).not.toBeNull();

      // Verify RTT was updated
      expect(contactToNode2.rtt).not.toBeNull();
      expect(contactToNode2.rtt).toBeGreaterThanOrEqual(0);
      expect(contactToNode2.rttUpdatedAt).not.toBeNull();
      expect(contactToNode2.rttUpdatedAt).toBeGreaterThanOrEqual(beforeCall);
      expect(contactToNode2.rttUpdatedAt).toBeLessThanOrEqual(afterCall);
    });

    it('RTT reflects actual elapsed time', async function () {
      // Create two nodes
      const contact1 = await SimulatedContact.create({ name: 'rtt-time-1' });
      const contact2 = await SimulatedContact.create({ name: 'rtt-time-2' });
      const node1 = contact1.node;
      const node2 = contact2.node;

      // Create a contact from node1 to node2
      const contactToNode2 = SimulatedContact.fromNode(node2, node1);

      // Make a successful RPC call
      const beforeCall = Date.now();
      await contactToNode2.sendRPC('ping', node1.key);
      const afterCall = Date.now();

      // RTT should be within the bounds of actual elapsed time
      const maxPossibleRTT = afterCall - beforeCall;
      expect(contactToNode2.rtt).toBeLessThanOrEqual(maxPossibleRTT);
    });

    it('does not update RTT on failed RPC (null result)', async function () {
      // Create a node
      const contact1 = await SimulatedContact.create({ name: 'rtt-fail-1' });
      const node1 = contact1.node;

      // Create a contact to a non-existent/stopped node
      const fakeNode = Node.fromKey(12345n);
      fakeNode.isRunning = false;
      const contactToFake = SimulatedContact.fromNode(fakeNode, node1);

      // Verify RTT is initially null
      expect(contactToFake.rtt).toBeNull();

      // Make an RPC call that will fail (node not running)
      const result = await contactToFake.sendRPC('ping', node1.key);

      // Verify the call failed
      expect(result).toBeNull();

      // Verify RTT was NOT updated
      expect(contactToFake.rtt).toBeNull();
    });

    it('updates RTT on each successful RPC', async function () {
      // Create two nodes
      const contact1 = await SimulatedContact.create({ name: 'rtt-multi-1' });
      const contact2 = await SimulatedContact.create({ name: 'rtt-multi-2' });
      const node1 = contact1.node;
      const node2 = contact2.node;

      // Create a contact from node1 to node2
      const contactToNode2 = SimulatedContact.fromNode(node2, node1);

      // Make first RPC call
      await contactToNode2.sendRPC('ping', node1.key);
      const firstRTT = contactToNode2.rtt;
      const firstTimestamp = contactToNode2.rttUpdatedAt;

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));

      // Make second RPC call
      await contactToNode2.sendRPC('ping', node1.key);
      const secondTimestamp = contactToNode2.rttUpdatedAt;

      // Verify timestamp was updated (RTT value may or may not change)
      expect(secondTimestamp).toBeGreaterThan(firstTimestamp);
    });
  });

  describe('Unit tests', function () {
    describe('updateRTT method', function () {
      it('sets rtt property', async function () {
        const contact = await SimulatedContact.create({ name: 'update-rtt-1' });
        
        expect(contact.rtt).toBeNull();
        contact.updateRTT(100);
        expect(contact.rtt).toBe(100);
      });

      it('sets rttUpdatedAt timestamp', async function () {
        const contact = await SimulatedContact.create({ name: 'update-rtt-2' });
        
        expect(contact.rttUpdatedAt).toBeNull();
        const before = Date.now();
        contact.updateRTT(50);
        const after = Date.now();
        
        expect(contact.rttUpdatedAt).toBeGreaterThanOrEqual(before);
        expect(contact.rttUpdatedAt).toBeLessThanOrEqual(after);
      });

      it('overwrites previous RTT value', async function () {
        const contact = await SimulatedContact.create({ name: 'update-rtt-3' });
        
        contact.updateRTT(100);
        expect(contact.rtt).toBe(100);
        
        contact.updateRTT(200);
        expect(contact.rtt).toBe(200);
      });
    });

    describe('RTT properties initialization', function () {
      it('rtt defaults to null', async function () {
        const contact = await SimulatedContact.create({ name: 'init-rtt-1' });
        expect(contact.rtt).toBeNull();
      });

      it('rttUpdatedAt defaults to null', async function () {
        const contact = await SimulatedContact.create({ name: 'init-rtt-2' });
        expect(contact.rttUpdatedAt).toBeNull();
      });
    });
  });
});
