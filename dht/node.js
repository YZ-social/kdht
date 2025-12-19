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
  async locateValue(targetKey) { // Promise value stored for targetKey, or undefined.
    // Side effect is to discover other nodes (and they us).
    targetKey = await this.ensureKey(targetKey);

    // Optimization: should still work without this, but then there are more RPCs.
    const found = this.retrieveLocally(targetKey);
    if (found !== undefined) return found;

    const result = await this.iterate(targetKey, 'findValue');
    if (Node.isValueResult(result)) return result.value;
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
    contact = this.ensureContact(contact);
    await contact.connect();
    await this.addToRoutingTable(contact);
    await this.locateNodes(this.key); // Discovers between us and otherNode.

    // Refresh every bucket farther out than our closest neighbor.
    // I think(?) that this can be done by refreshing "just" the farthest bucket:
    //this.ensureBucket(this.constructor.keySize - 1).resetRefresh();
    await Node.delay(Node.randomInteger(3e3));
    this.ensureBucket(this.constructor.keySize - 1).refresh();
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

    return this.contact; // Answering this node's home contact is handy for chaining or keeping track of contacts being made and joined.
  }


  // TODO: separate all this out: neither transport nor dht.
  // TODO: fragment/reassemble big messages.
  messageTags = new Map(); // maps message messageTags => responders, separately from inFlight, above
  pingTags = new Map();
  async message(targetKey, excluded, messageTag, ...rest) { // Send message to targetKey, using our existing routingTable contacts.
    const MAX_PING_MS = 100;
    const MAX_MESSAGE_MS = 10 * MAX_PING_MS;
    let responsePromise = null;
    if (!messageTag) { // If this is an outgoing request from us, message() promises the response.
      messageTag = uuidv4();
      responsePromise = new Promise(resolve => this.messageTags.set(messageTag, resolve));
      rest.unshift(this.key.toString()); // Add return address.
    }
    // The excluded list of keys prevents cycles.
    excluded.push(this.key.toString()); // TODO: Find a way to not have an excluded list, or at least add junk for privacy.
    const body = JSON.stringify([targetKey.toString(), excluded, messageTag, ...rest]);
    const contacts = this.findClosestHelpers(targetKey).map(helper => helper.contact);
    //this.xlog('message to:', targetKey, 'contacts:', contacts.map(c => c.sname + '/' + c.key), 'excluding:', excluded);
    let selected = null;
    for (const contact of contacts) {
      if (excluded.includes(contact.key.toString())) continue; 
      //this.xlog('trying message through', contact.sname);
      if (!contact.connection) continue;
      if (!(await Promise.race([Node.delay(MAX_PING_MS, false), contact.sendRPC('ping', contact.key)]))) {
	this.xlog('failed to get ping', contact.sname);
	this.removeContact(contact);
	continue;
      }
      const overlay = await contact.overlay;
      overlay.send(body);
      selected = contact;
      break;
    }
    if (selected) {
      //this.xlog('hop to:', selected?.sname, 'excluding:', excluded, contacts.map(c => c.sname), rest.map(s => Array.isArray(s) ? s[0] : s));
      return await Promise.race([responsePromise, Node.delay(MAX_MESSAGE_MS, null)]);
    }
    this.xlog('No connected contacts to send message among', contacts.map(c => c.sname));
    return responsePromise; // Original promise, if any.
  }
  async messageHandler(dataString) {
    //this.log('got overlay', dataString);
    const data = JSON.parse(dataString);

    // If intended for another node, pass it on.
    const [to, excluded, ...rest] = data;
    const targetKey = BigInt(to);
    if (targetKey !== this.key) return await this.message(targetKey, excluded, ...rest); // rest includes messageTag.

    // If it is a response to something we sent, resolve the waiting promise with the rest of the data.
    const [messageTag, ...requestOrResponse] = rest;
    const responder = this.messageTags.get(messageTag);
    this.messageTags.delete(messageTag);
    if (responder) return responder(requestOrResponse);

    // Finally, answer a request to us by messaging the sender with the same-tagged response.
    const [from, method, ...args] = requestOrResponse;
    if (!(method in this)) return this.log('ignoring unrecognized request', {messageTag, from, method, args}); // Could be a double response.
    let response = await this[method](...args);
    if (!Array.isArray(response)) response = [response]; // HACK!
    //this.xlog('response', response, 'to', method, ...args);
    return await this.message(BigInt(from), [], messageTag, ...response);
  }
  signal(...rest) {
    return this.contact.signals(...rest);
  }
}
