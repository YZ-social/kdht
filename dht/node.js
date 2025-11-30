import { Helper } from  './helper.js';
import { KBucket } from './kbucket.js';
import { NodeMessages } from './nodeMessages.js';
const { BigInt, process } = globalThis; // For linters.

/*
  The chain of superclasses are not really intended to be used separately.
  They are just broken into smaller peices to make it easier to review the code.
*/

export class Node extends NodeMessages { // An actor within thin DHT.
  static alpha = 3; // How many lookup requests are initially tried in parallel. If no progress, we repeat with up to k more.

  /* Active operations involving messages to other Nodes. */
  async ensureKey(targetKey) { // If targetKey is not already a real key, hash it into one.
    if (typeof(targetKey) !== 'bigint') targetKey = await this.constructor.key(targetKey);
    return targetKey;
  }
  async locateNodes(targetKey, number = this.constructor.k) { // Promise up to k best Contacts for targetKey (sorted closest first).
    // Side effect is to discover other nodes (and they us).
    targetKey = await this.ensureKey(targetKey);
    return await this.iterate(targetKey, 'findNodes', number);
  }
  async locateValue(targetKey) { // Promise value stored for targetKey, or undefined.
    // Side effect is to discover other nodes (and they us).
    targetKey = await this.ensureKey(targetKey);

    // Optimization.
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

  // There are only three kinds of rpc results: 'pong', [...helper], {value: something}
  static isValueResult(rpcResult) {
    return rpcResult !== 'pong' && 'value' in rpcResult;
  }
  static isArrayResult(rpcResult) {
    return Array.isArray(rpcResult);
  }
  async step(targetKey, finder, helper, keysSeen) {
    // Get up to k previously unseen Helpers from helper, adding results to keysSeen.
    const contact = helper.contact;
    let results = await contact.sendCatchingRpc(finder, targetKey);
    if (!results) return []; // disconnected
    await this.addToRoutingTable(helper.contact); // Live node, so update bucket.
    if (Node.isArrayResult(results)) { // Keep only those that we have not seen, and note the new ones we have.
      results = results.filter(helper => !keysSeen.has(helper.key) && keysSeen.add(helper.key));
      // Results are (helpers around) contacts. Clone them for this host.
      results = results.map(h => new Helper(h.contact.clone(this), h.distance));
      results.forEach(h => h.contact.sponsor = contact); // Record the contact that introduced us to this new contact.
    }
    return results;
  }
  async iterate(targetKey, finder, k = this.constructor.k, trace = false) {
    // Promise a best-first list of k Helpers from the network, by repeatedly trying to improve our closest known by applying finder.
    // But if any finder operation answer isValueResult, answer that instead.

    // Each iteration uses a bigger pool than asked for, because some will have disconnected.
    let pool = this.findClosestHelpers(targetKey, 2*k); // The k best-first Helpers known so far, that we have NOT queried yet.
    const alpha = Math.min(pool.length, this.constructor.alpha);
    const keysSeen = new Set(pool.map(h => h.key));    // Every key we've seen at all (candidates and all responses).
    keysSeen.add(this.key); // We might or might not be in our list of closest helpers, but we could be in someone else's.
    let toQuery = pool.slice(0, alpha);
    pool = pool.slice(alpha); // Yes, this could be done with splice instead of slice, above, but it makes things hard to trace.
    let best = []; // The accumulated closest-first result.    
    while (toQuery.length && this.contact.isConnected) { // Stop if WE disconnect.
      let requests = toQuery.map(helper => this.step(targetKey, finder, helper, keysSeen));
      let results = await Promise.all(requests);
      if (trace) console.log(toQuery.map(h => h.name), '=>', results.map(r => r.map?.(h => h.name) || r));
      
      let found = results.find(Node.isValueResult); // Did we get back a 'findValue' result.
      if (found) {
	// Store at closest result that didn't have it (if any). This can cause more than k copies in the network.
	for (let i = 0; i < toQuery.length; i++) {
	  if (!Node.isValueResult(results[i])) {
	    toQuery[i].contact.store(targetKey, found.value);
	    break;
	  }
	}
	return found;
     }

      let closer = [].concat(...results); // Flatten results.
      // closer might not be in order, and one or more toQuery might belong among them.
      best = [...closer, ...toQuery, ...best].sort(Helper.compare).slice(0, k);
      if (!closer.length) {
	if (toQuery.length === alpha && pool.length) {
	  toQuery = pool.slice(0, 2*k);  // Try again with k more. (Interestingly, not k - alpha.)
	  pool = pool.slice(2*k);
	} else break; // We've tried everything and there's nothing better.
      } else {
	pool = [...closer, ...pool].slice(0, 2*k); // k best-first nodes that we have not queried.
	toQuery = pool.slice(0, alpha);
	pool = pool.slice(alpha);
      }
    }
    return best;
  }
  async join(contact) {
    contact = contact.clone(this);
    await this.addToRoutingTable(contact);
    await this.locateNodes(this.key); // Discovers between us and otherNode.
    // Refresh every bucket farther out than our closest neighbor.
    let started = false;
    for (let index = 0; index < this.constructor.keySize; index++) {
      // TODO: Do we really have to perform a refresh on EACH bucket? Won't a refresh of the farthest bucket update the closer ones?
      // TODO: Can it be in parallel?
      const bucket = this.routingTable.get(index);
      if (!bucket?.contacts.length && !started) continue;
      if (!started) started = true;
      else if (!bucket?.contacts.length) await this.ensureBucket(index).refresh();
    }
    return this.contact;
  }
}
