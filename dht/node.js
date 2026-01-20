const { BigInt } = globalThis; // For linters.
import { v4 as uuidv4 } from 'uuid';
import { NodeProbe } from './nodeProbe.js';

/*
  The chain of superclasses are not really intended to be used separately.
  They are just broken into smaller peices to make it easier to review the code.
*/

// An actor within thin DHT.
export class Node extends NodeProbe {
  // These are the public methods for applications.

  async locateNodes(targetKey, number = this.constructor.k) { // Promise up to k best Contacts for targetKey (sorted closest first).
    // Side effect is to discover other nodes (and they us).
    targetKey = await this.ensureKey(targetKey);
    return await this.iterate(targetKey, 'findNodes', number);
  }
  async locateValue(targetKey, additionalTries = 1) { // Promise value stored for targetKey, or undefined.
    // Side effect is to discover other nodes (and they us).
    targetKey = await this.ensureKey(targetKey);

    // Optimization: should still work without this, but then there are more RPCs.
    const found = this.retrieveLocally(targetKey);
    if (found !== undefined) return found;

    const result = await this.iterate(targetKey, 'findValue');
    if (Node.isValueResult(result)) return result.value;
    // KLUDGE ALERT:
    if (additionalTries) {
      console.log('\n\n*** failed to find value for', targetKey, 'and trying again', additionalTries, '***\n');
      await Node.delay(1e3);
      return await this.locateValue(targetKey, additionalTries - 1);
    }
    return undefined;
  }
  async storeValue(targetKey, value) { // Convert targetKey to a bigint if necessary, and store k copies.
    // Promises the number of nodes that it was stored on.
    targetKey = await this.ensureKey(targetKey);
    // Go until we are sure have written k.
    const k = this.constructor.k;
    let remaining = k;
    // Ask for more, than needed, and then store to each, one at a time, until we
    // have replicated k times.
    let helpers = await this.locateNodes(targetKey, remaining * 2);
    helpers = helpers.reverse(); // So we can save best-first by popping off the end.
    // TODO: batches in parallel, if the client and network can handle it. (For now, better to spread it out.)
    while (helpers.length && remaining) {
      const contact = helpers.pop().contact;
      const stored = await contact.store(targetKey, value);
      if (stored) remaining--;
    }
    return k - remaining;
  }
  async join(contact) {
    this.log('joining', contact.sname);
    contact = this.ensureContact(contact);
    await contact.connect();
    await this.addToRoutingTable(contact);
    await this.locateNodes(this.key); // Discovers between us and otherNode.

    // Refresh every bucket farther out than our closest neighbor.
    // I think(?) that this can be done by refreshing "just" the farthest bucket:
    //this.ensureBucket(this.constructor.keySize - 1).resetRefresh();
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
    this.log('joined', contact.sname);
    return this.contact; // Answering this node's home contact is handy for chaining or keeping track of contacts being made and joined.
  }
}
