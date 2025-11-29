import { Helper } from  './helper.js';
import { KBucket } from './kbucket.js';
import { NodeTransports } from './nodeTransports.js';
const { BigInt, process } = globalThis; // For linters.

/*
  The chain of superclasses are not really intended to be used separately.
  They are just broken into smaller peices to make it easier to review the code.
*/

export class Node extends NodeTransports { // An actor within thin DHT.
  static alpha = 3; // How many lookup requests are initially tried in parallel. If no progress, we repeat with up to k more.
  static debug = false;
  static log(...rest) { if (this.debug) console.log(...rest); }
  log(...rest) { this.constructor.log(this.name, ...rest); }
  static assert(ok, ...rest) { // If !ok, log rests and exit.
    if (ok) return;
    console.error(...rest, new Error("Assert failure").stack); // Not throwing error, because we want to exit. But we are grabbing stack.
    process.exit(1);
  }
  static _stats = {};
  static get statistics() { // Return {bucket, storage, rpc}, where each value is [elapsedInSeconds, count, averageInMSToNearestTenth].
    // If Nodes.contacts is populated, also report average number of buckets and contacts.
    const { _stats } = this;
    if (this.contacts?.length) {
      let buckets = 0, contacts = 0, stored = 0;
      for (const {node} of this.contacts) {
	stored += node.storage.size;
	node.forEachBucket(bucket => {
	  buckets++;
	  contacts += bucket.contacts.length;
	  return true;
	});
      }
      _stats.contacts = Math.round(contacts/this.contacts.length);
      _stats.stored = Math.round(stored/this.contacts.length);
      _stats.buckets = Math.round(buckets/this.contacts.length);
    }
    return _stats;
  }
  static resetStatistics() { // Reset statistics to zero.
    const stat = {count:0, elapsed:0, lag:0};
    this._stats = {
      bucket: Object.assign({}, stat), // copy the model
      storage: Object.assign({}, stat),
      rpc: Object.assign({}, stat)
    };
  }
  static noteStatistic(startTimeMS, name) { // Given a startTimeMS, update statistics bucket for name.
    const stat = this._stats?.[name];
    if (!stat) return;
    stat.count++;
    stat.elapsed += Date.now() - startTimeMS;
  }
  // Examination
  report(logger = console.log) { // return logger( a string description of node )
    let report = `Node: ${this.contact?.report || this.name}, ${this.nTransports} transports`;
    function contactsString(contacts) { return contacts.map(contact => contact.report).join(', '); }
    if (this.storage.size) {
      report += `\n  storing ${this.storage.size}: ` +
	Array.from(this.storage.entries()).map(([k, v]) => `${k}n: ${JSON.stringify(v)}`).join(', ');
    }
    if (this.looseTransports.length) {
      report += `\n  transports ${this.looseTransports.map(contact => contact.report).join(', ')}`;
    }
    for (let index = 0; index < Node.keySize; index++) {
      const bucket = this.routingTable.get(index);
      if (!bucket) continue;
      report += `\n  ${index}: ` + (contactsString(bucket.contacts) || '-');
    }
    return logger ? logger(report) : report;
  }
  static reportAll() { // Report every node -- only useful for simulations.
    return Node.contacts?.forEach(c => c.node.report());
  }


  // Storage
  storage = new Map(); // keys must be preserved as bigint, not converted to string.
  fuzzyInterval(target = this.refreshTimeIntervalMS/3, margin = target/3) {
    // Answer a random integer uniformly distributed around target, +/- margin.
    const adjustment = Math.floor(Math.random() * margin);
    return Math.floor(target + margin/2 - adjustment);
  }
  static stopRefresh() { // Stop all repeat timers in all instances the next time they come around.
    this.constructor.refreshTimeIntervalMS = 0;
  }
  stopRefresh() { // Stop repeat timeers in this instance.
    this.refreshTimeIntervalMS = 0;
  }
  probeSerializer = Promise.resolve();
  repeat(thunk, statisticsKey, interval) {
    // Answer a timer that will execute thunk() in interval, and then  repeat.
    // If not specified, interval computes a new fuzzyInterval each time it repeats.
    // Does nothing if interval is zero.
    if (0 === this.refreshTimeIntervalMS || 0 === this.constructor.refreshTimeIntervalMS || 0 === interval) return null;

    // We use repeated setTimer rather than setInterval because it is important in the
    // default case to use a different random interval each time, so that we don't have
    // everything firing at once repeatedly.
    const timeout = (interval === undefined) ?  this.fuzzyInterval() : interval;

    const scheduled = Date.now();
    return setTimeout(async () => {
      const fired = Date.now();
      this.repeat(thunk, statisticsKey, interval); // Set it now, so as to not be further delayed by thunk.
      // Each actual thunk execution is serialized: Each Node executes its OWN various refreshes and probes
      // one at a time. This prevents a node from self-DoS'ing, but of course it does not coordinate across
      // nodes. If the system is bogged down for any reason, then the timeout spacing will get smaller
      // until finally the node is just running flat out.
      await (this.probeSerializer = this.probeSerializer.then(thunk));
      const status = Node._stats?.[statisticsKey];
      if (status) {
	const elapsed = Date.now() - fired; // elapsed in thunk
	const lag = fired - scheduled - timeout;
	status.count++;
	status.elapsed += elapsed;
	status.lag += lag;
      }
    }, timeout);
  }
  storeLocally(key, value) { // Store in memory by a BigInt key (must be already hashed). Not persistent.
    if (this.storage.get(key) === value) return; // If not a new value, no need to change refresh schedule.
    this.storage.set(key, value);
    // TODO: The paper says this can be optimized.
    // Claude.ai suggests just writing to the next in line, but that doesn't work.
    // FIXME: clear old storage timers. Does a node ever take itself out of the storage business for a key?
    this.repeat(() => this.storeValue(key, value), 'storage');
  }
  retrieveLocally(key) {     // Retrieve from memory.
    return this.storage.get(key);
  }
  // TODO: also store/retrievePersistent locally.
  async replicateCloserStorage(contact) { // Replicate to new contact any of our data for which contact is closer than us.
    const ourKey = this.key;
    for (const key in this.storage.keys()) {
      if (this.constructor.distance(contact.key, key) <= this.constructor.distance(ourKey, key)) {
	contact.store(key, this.retrieveLocally(key)); // Not awaiting.
      }
    }
  }

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

  // The four methods we recevieve through RPCs:
  ping(key) { // Respond with 'pong'. (RPC mechanism doesn't call unless connected.)
    return 'pong';
  }
  store(key, value) { // Tell Entry node to store identifier => value.
    this.storeLocally(key, value);
    return 'pong';
  }
  findNodes(key) { // Return k closest Contacts from routingTable.
    // TODO: Currently, this answers a list of Helpers. For security, it should be changed to a list of serialized Contacts.
    // I.e., send back a list of verifiable signatures and let the receiver verify and then compute the distances.
    return this.findClosestHelpers(key);
  }
  findValue(key) { // Like findNodes, but if other has identifier stored, reject {value} instead.
    let value = this.retrieveLocally(key);
    if (value !== undefined) return {value};
    return this.findClosestHelpers(key);
  }
}
