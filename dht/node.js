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
      console.log('\n\n*** failed to find value and trying again', additionalTries, '***\n');
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


  // TODO: separate all this out: neither transport nor dht.
  // TODO: fragment/reassemble big messages.
  messagePromises = new Map(); // maps message messageTags => responders.
  async message({targetKey, targetSname, excluded = [], requestTag, senderKey, senderSname = this.contact.sname, payload}) { // Send message to targetKey, using our existing routingTable contacts.
    //const MAX_PING_MS = 400;
    const MAX_MESSAGE_MS = 2e3;
    let responsePromise = null;
    if (!requestTag) { // If this is an outgoing request from us, promises the response.
      requestTag = uuidv4();
      senderKey = this.key;
      senderSname = this.contact.sname;
      responsePromise = new Promise(resolve => this.messagePromises.set(requestTag, resolve));
    }
    targetKey = targetKey.toString();
    senderKey = senderKey?.toString();
    // The excluded list of keys prevents cycles.
    excluded.push(this.key.toString()); // TODO: Find a way to not have an excluded list, or at least add junk for privacy.
    const body = JSON.stringify({targetKey, excluded, requestTag, senderKey, targetSname, senderSname, payload});
    const contacts = this.findClosestHelpers(BigInt(targetKey)).map(helper => helper.contact).filter(contact => contact.key !== this.key);
    this.log('=>', targetSname, 'message', requestTag, 'contacts:', contacts.map(c => c.sname));
    for (const contact of contacts) {
      if (excluded.includes(contact.key.toString())) { this.log('skiping excluded', contact.sname, 'for message', requestTag); continue; }
      //this.xlog('trying message through', contact.sname);
      if (!contact.connection) { this.log('skipping unconnected', contact.sname, 'for message', requestTag); continue; }
      if (!(await contact.sendRPC('ping', contact.key))) {
	this.xlog('failed to get ping', contact.sname, 'for message', requestTag);
	await this.removeContact(contact);
	continue;
      }
      let overlay = await contact.overlay;
      //this.xlog('hopping through', contact.sname, 'for message', requestTag, 'from',  senderSname, 'to', targetSname);
      overlay.send(body);
      // FIXME: how do we know if a response was ultimately delivered? Don't we need a confirmation for that so that we can try a different route?
      const result =  await responsePromise;
      //this.xlog('got result for message', requestTag, 'through', contact.sname);
      //const result =  await Promise.race([responsePromise, Node.delay(MAX_MESSAGE_MS, 'fixme')]);
      // if (result === 'fixme') {
      // 	this.xlog(`message timeout to ${targetSname} via ${contact.sname}.`);
      // 	continue;  // If we timeout, responsePromise is still valid.
      // }
      return result;
      break;
    }
    this.xlog(`No connected contacts to send message ${requestTag} to ${targetSname} among ${contacts.map(c => `${excluded.includes(c.key.toString()) ? 'excluded/' : (c.connection ? '' : 'unconnected/')}${c.sname}`).join(', ')}`);
    return null;
  }
  async messageHandler(dataString) {
    //this.log('got overlay', dataString);
    const data = JSON.parse(dataString);
    const {targetKey, excluded, requestTag, senderKey, targetSname, senderSname, payload} = data;
    Node.assert(targetKey, 'No targetKey to handle', dataString);
    Node.assert(payload, 'No payload to handle', dataString);    
    Node.assert(requestTag, 'No request tag by which to answer', dataString);
    this.log('handling message', requestTag, 'from', senderSname, 'to', targetSname);

    // If intended for another node, pass it on.    
    if (BigInt(targetKey) !== this.key) return await this.message(data);

    // If it is a response to something we sent, resolve the waiting promise with the payload.
    const responder = this.messagePromises.get(requestTag);
    this.messagePromises.delete(requestTag);
    if (responder) return responder(payload);

    // Finally, answer a request to us by messaging the sender with the same-tagged response.
    const [method, ...args] = payload;
    if (!(method in this)) return this.xlog('ignoring unrecognized request', {requestTag, method, args}); // Could be a double response.

    Node.assert(args[0] === senderSname, 'FIXME sender does not match signals payload sender', dataString);
    this.log('executing', method, 'from', senderSname, 'request:', requestTag);
    let response = await this[method](...args);
    Node.assert(senderKey, 'No sender key by which to answer', dataString);    
    this.log('responding to', method, 'from', senderSname, 'request:', requestTag);
    return await this.message({targetKey: BigInt(senderKey), targetSname: senderSname, requestTag, payload: response});
  }
  async signal(...rest) {
    //this.xlog(`handling signals @ ${this.key} ${rest}`);
    const fixme = await this.contact.signals(...rest);
    //this.xlog(`returning signals @ ${this.key} ${fixme}`);
    return fixme;
  }
}
