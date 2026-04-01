import { StorageBag } from './storageBag.js';
import { NodePubSub } from './nodePubSub.js';

/*
  The chain of superclasses are not really intended to be used separately.
  They are just broken into smaller peices to make it easier to review the code.
*/

// An actor within thin DHT.
export class Node extends NodePubSub {
  // These are the public methods for applications.

  static diagnosticTrace = false; // Set to true for detailed store/read logging

  async locateNodes(targetKey, number = this.constructor.k, includeSelf = false, trace = false) { // Promise up to k best Contacts for targetKey (sorted closest first).
    // Side effect is to discover other nodes (and they us).
    // includeSelf: If true, the local node is included as a candidate (useful for finding storage locations).
    targetKey = await this.ensureKey(targetKey);
    return await this.iterate(targetKey, 'findNodes', number, trace, false, includeSelf);
  }
  async locateValue(targetKey, additionalTries = 1) { // Same as locateStorageValue, but in the case of a single raw value payload, return that.
    const storageItems = await this.locateStorageValue(targetKey, additionalTries);
    if (storageItems?.length !== 1) return storageItems;
    const storageItem = storageItems[0];
    if (storageItem.type !== 'raw') return storageItems;
    return storageItem.payload;
  }
  async locateStorageValue(targetKey, additionalTries = 1) { // Promise list of StorageItems stored for targetKey, or undefined.
    // Side effect is to discover other nodes (and they us).
    targetKey = await this.ensureKey(targetKey);
    const trace = this.constructor.diagnosticTrace;

    const result = await this.iterate(targetKey, 'findValue');
    if (Node.isValueResult(result)) {
      if (trace) {
        const responderInfo = result.responder ? ` (from ${result.responder.name})` : '';
        this.log(`locateValue(${targetKey}): found in network =>`, result.value, responderInfo);
      }
      return result.value;
    }
    // Always log failures - this helps debug sporadic read failures
    const queried = result.map(h => h.name).join(', ');
    const distances = result.slice(0, 5).map(h => String(h.distance).length).join(',');
    this.log(`locateValue(${targetKey}): NOT FOUND - queried ${result.length} nodes: ${queried} (dist digits: ${distances}...)`);

    // Check which of the queried nodes actually have the value (for debugging)
    const nodesWithValue = result.filter(h => h.node?.retrieveLocally(targetKey) !== undefined);
    if (nodesWithValue.length > 0) {
      this.log(`  BUG: ${nodesWithValue.length} queried nodes actually have the value: ${nodesWithValue.map(h => h.name).join(', ')}`);
    }
    return undefined;
  }
  async storeValue(targetKey, value) { // Convert targetKey to a bigint if necessary, and store k copies.
    // Promises the number of nodes that it was stored on.
    targetKey = await this.ensureKey(targetKey);
    value = StorageBag.ensureItems(value);
    const trace = this.diagnosticTrace || this.constructor.diagnosticTrace;

    // Early exit if this node is no longer running (e.g., disconnected during scheduled replication)
    if (!this.isRunning) {
      if (trace) this.flog(`storeValue(${targetKey}, ${value}): aborted - node disconnected`);
      return 0;
    }
    if (!value.length) return 0; // expired and nothing to store.

    // Go until we are sure have written k.
    const k = this.constructor.k;
    let remaining = k;
    // Ask for more, than needed, and then store to each, one at a time, until we
    // have replicated k times.
    let contacts = (await this.locateNodes(targetKey, remaining * 2, true, trace)) // includeSelf: we're a valid storage location
	.map(helper => helper.contact);

    // Check again after the async locateNodes call
    if (!this.isRunning) {
      if (trace) this.flog(`storeValue(${targetKey}, ${value}): aborted after locateNodes - node disconnected`);
      return 0;
    }

    if (trace) this.flog(`storeValue(${targetKey}): locateNodes found ${contacts.length} contacts`);
    const storedTo = []; // Track where we stored for diagnostics, and for seeing if we no longer need to store.

    // Do what we can in parallel right away. This might not all be the very closest, but those stored will take care of migrating.
    const connected = contacts.filter(contact => contact.connection).slice(0, k);
    await Promise.all(connected.map(async contact => {
      await contact.sendRPC('store', targetKey, value);
      storedTo.push(contact.name);
      remaining--;
    }));
    if (remaining) {
      this.log("initial parallel store produced", connected.length, "results.");
      contacts = contacts.filter(contact => !connected.includes(contact)).reverse(); // So we can save best-first by popping off the end.
    }
    while (contacts.length && remaining) {
      const contact = contacts.pop();
      const stored = await contact.sendRPC('store', targetKey, value);
      if (stored) {
        remaining--;
        storedTo.push(contact.name);
      } else if (!this.isRunning) {
        // Node disconnected mid-replication - no point continuing
        if (trace) this.flog(`storeValue(${targetKey}, ${value}): aborted mid-store - node disconnected`);
        return k - remaining;
      }
    }
    const storedCount = k - remaining;
    if (trace || (this.debug && storedCount < k)) {
      // Explain why we got fewer than k stores
      let reason = '';
      if (!this.isRunning) {
        reason = ' (node disconnected)';
      } else if (contacts.length === 0 && storedCount < k) {
        reason = ' (insufficient nodes found)';
      }
      this.flog(`storeValue(${targetKey}, ${value}): stored to ${storedCount}/${k} nodes${storedTo.length ? ': ' + storedTo.join(', ') : ''}${reason}`);
    }
    if (!storedTo.includes(this.name) && this.storage.has(targetKey)) {
      this.ilog('is now too distant from', targetKey, 'to store', value.map(item => item.type));
      this.storage.delete(targetKey);
    }
    return k - remaining;
  }
  async join(contact) {
    this.ilog('joining', contact.sname);
    contact = this.ensureContact(contact); // in non-simulation context, this is effectively a no-op because only a single host exists (and we're not providing a sponsor argument)
    await contact.connect();
    this.addToRoutingTable(contact);
    await this.locateNodes(this.key); // Discovers between us and otherNode.

    // Refresh every bucket farther out than our closest neighbor.
    // I think(?) that this can be done by refreshing "just" the farthest bucket:
    await this.ensureBucket(this.constructor.keySize - 1).refresh();
    // But if it turns out to be necessary to explicitly refresh each next bucket in turn, this is how:
    // let started = false;
    // for (let index = 0; index < this.constructor.keySize; index++) {
    //   // TODO: Do we really have to perform a refresh on EACH bucket? Won't a refresh of the farthest bucket update the closer ones?
    //   // TODO: Can it be in parallel?
    //   const bucket = this.routingTable.get(index);
    //   if (!bucket?.contacts.length && !started) continue;
    //   if (!started) started = true;
    //   else if (!bucket?.contacts.length) await this.ensureBucket(index).refresh();
    // }
    this.ilog('joined', contact.sname);
    return this.contact; // Answering this node's home contact is handy for chaining or keeping track of contacts being made and joined.
  }
}
