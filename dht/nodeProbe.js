import { Helper } from  './helper.js';
import { NodeMessages } from './nodeMessages.js';

// Probe the network
export class NodeProbe extends NodeMessages {
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
    let results = await contact.sendRPC(finder, targetKey);
    if (!results) return []; // disconnected
    await this.addToRoutingTable(helper.contact); // Live node, so update bucket.
    if (this.constructor.isArrayResult(results)) { // Keep only those that we have not seen, and note the new ones we have.
      results = results.filter(helper => !keysSeen.has(helper.key) && keysSeen.add(helper.key));
      // Results are (helpers around) contacts. Clone them for this host.
      results = results.map(h => new Helper(h.contact.clone(this), h.distance));
      results.forEach(h => h.contact.sponsor = contact); // Record the contact that introduced us to this new contact.
    }
    return results;
  }
  static alpha = 3; // How many lookup requests are initially tried in parallel. If no progress, we repeat with up to k more.
  async iterate(targetKey, finder, k = this.constructor.k, trace = false) {
    // Promise a best-first list of k Helpers from the network, by repeatedly trying to improve our closest known by applying finder.
    // But if any finder operation answer isValueResult, answer that instead.

    // Each iteration uses a bigger pool than asked for, because some will have disconnected.
    let pool = this.findClosestHelpers(targetKey, 2*k); // The k best-first Helpers known so far, that we have NOT queried yet.
    const isValueResult = this.constructor.isValueResult;
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
      
      let found = results.find(isValueResult); // Did we get back a 'findValue' result.
      if (found) {
	// Store at closest result that didn't have it (if any). This can cause more than k copies in the network.
	for (let i = 0; i < toQuery.length; i++) {
	  if (!isValueResult(results[i])) {
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
}
