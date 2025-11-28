import { Helper } from  './helper.js';
import { KBucket } from './kbucket.js';
const { BigInt, TextEncoder, crypto } = globalThis; // For linters.

/*

  TODO: there are few places where we return a list of Helpers (or Contacts?) that are described in the literature (or method name!) as returning Nodes. Let's do that, since we can get Nodes from Helpers/Contacts, and Contacts from Nodes.
  TODO: It would be convenient for bucket to cache their host and index. This would allow get rid of some/all? uses of contact.host, and move some operations (randomTargetInBucket, refresh) to KBucket.
  TODO: should assers be in the Contact or the Node?
*/


export class Node { // An actor within thin DHT.
  static alpha = 3; // How many lookup requests are initially tried in parallel. If no progress, we repeat with up to k more.
  // TODO: Let's make this as small as possible without flooding network. How do we determine that?
  static refreshTimeIntervalMS = 15e3; // Original paper for desktop filesharing was 60 minutes.
  static k = 20; // Chosen so that for any k nodes, it is highly likely that at least one is still up after refreshTimeIntervalMS.
  static keySize = 128; // Number of bits in a key. Must be multiple of 8 and <= sha256.
  static distinguisher = null; // If set to number, then each Node gets a unique distinguisher that appears in Contact report.
  constructor({refreshTimeIntervalMS = Node.refreshTimeIntervalMS, distinguisher = Node.distinguisher, ...properties}) {
    if (distinguisher !== null) Node.distinguisher = distinguisher + 1;
    Object.assign(this, {refreshTimeIntervalMS, distinguisher, ...properties});
  }
  get distinguishedName() {
    if (this.distinguisher === null) return this.name;
    return `${this.name}-${this.distinguisher}`;
  }
  static debug = false;
  static log(...rest) { if (this.debug) console.log(...rest); }
  log(...rest) { this.constructor.log(this.name, ...rest); }
  static assert(ok, ...rest) { // If !ok, log rests and exit.
    if (ok) return;
    console.error(...rest, new Error("Assert failure").stack); // Not throwing error, because we want to exit. But we are grabbing stack.
    process.exit(1);
  }

  /* Identifiers: A few operations accept string, which are hashed to keySize bits and represented internally as a BigInt. */
  static async sha256(string) { // Promises a Uint8Array.
    const msgBuffer = new TextEncoder().encode(string);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const uint8Array = new Uint8Array(hashBuffer);
    return uint8Array;
  }
  static uint8ArrayToHex(uint8Array) {
    return Array.from(uint8Array)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
  static async key(string) {
    const uint8Array = await this.sha256(string.toString());
    const truncated = uint8Array.slice(0, this.keySize / 8);
    const hex = this.uint8ArrayToHex(truncated);
    const key = BigInt('0x' + hex);
    return key;
  }
  static counter = 0;
  static async create(nameOrProperties = {}) { // Create a node with a simple name and matching key.
    if (['string', 'number'].includes(typeof nameOrProperties)) nameOrProperties = {name: nameOrProperties};
    let {name = this.counter++, ...rest} = nameOrProperties;
    name = name.toString();
    const key = await this.key(name);  
    return new this({name, key, ...rest});
  }
  static fromKey(key) { // Forge specific key for testing.
    if (typeof(key) !== 'bigint') key = BigInt(key);
    return new this({name: key.toString() + 'n', key});
  }

  /* Internal operations that do not talk to other nodes */
  static zero = 0n;
  static one = 1n;
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
  static distance(keyA, keyB) { // xor
    return keyA ^ keyB;
  }
  routingTable = new Map(); // Maps bit prefix length to KBucket
  forEachBucket(iterator, reverse = false) { // Call iterator(bucket) on each non-empty bucket, stopping as soon as iterator(bucket) returns falsy.
    let buckets = this.routingTable.values();
    if (reverse) buckets = buckets.reverse();
    for (const bucket of buckets) {
      if (bucket && !iterator(bucket)) return;
    }
  }
  findContact(key) { // Answer the contact for this key, if any, whether in buckets or looseTransports. Does not remove it.
    const match = contact => contact.key === key;
    let contact = this.looseTransports.find(match);
    if (contact) return contact;
    this.forEachBucket(bucket => !(contact = bucket.contacts.find(match))); // Or we could compute index and look just there.
    return contact;
  }
  looseTransports = [];
  static maxTransports = Infinity;
  get nTransports() {
    let count = this.looseTransports.length;
    this.forEachBucket(bucket => (count += bucket.nTransports, true));
    return count;
  }
  removeLooseTransport(key) { // Remove the contact for key from looseTransports, and return boolean indicating whether it had been present.
    const looseIndex = this.looseTransports.findIndex(c => c.key === key);
    if (looseIndex >= 0) {
      this.looseTransports.splice(looseIndex, 1);
      return true;
    }
    return false;
  }
  noteContactForTransport(contact) { // We're about to use this contact for a message, so keep track of it.
    // Returns the existing contact, if any, else a clone of contact for this node.
    // Requires: if we later addToRoutingTable successfully, it should be removed from looseTransports.
    // Requires: if we later remove contact because of a failed send, it should be removed from looseTransports.
    const key = contact.key;
    let existing = this.findContact(contact.key);
    if (existing) return existing;

    if (false /*fixme this.nTransports >= this.constructor.maxTransports*/) {
      const sponsor = contact.sponsor;
      function removeLast(list) { // Remove and return the last element of list that hasTransport
	const index = list.findLastIndex(element => element.hasTransport && element.key !== sponsor?.key);
	if (index < 0) return null;
	const sub = list.splice(index, 1);
	return sub[0];
      }
      let dropped = removeLast(this.looseTransports);
      if (dropped) {
	//if (dropped.hasTransport.host.name === '265') console.log('dropping loose transport', dropped.name, 'in', this.name);
      } else { // Find the bucket with the most connections.
	//console.log('\n\n*** find best bucket ***\n\n');
	let bestBucket = null, bestCount = 0;
	this.forEachBucket(bucket => {
	  const count = bucket.nTransports;
	  if (count <= bestCount) return true;
	  bestBucket = bucket;
	  bestCount = count;
	  return true;
	});
	dropped = removeLast(bestBucket.contacts);
      }
      // if (dropped) {
      // 	//FIXME? console.log('dropping loose contact', dropped.report, 'from', this.contact.report);
      // } else { // No loose transport. Must drop from a bucket.
      // 	const index = this.getBucketIndex(contact.key); // First try the bucket where we will be placed, so that we stick around.
      // 	const bucket = this.routingTable.get(index);
      // 	dropped = removeLast(bucket.contacts);
      // 	if (dropped) {
      // 	  console.log('\n\n\n**** FIXME', 'dropping bucket contact', dropped.report, 'from', this.contact.report, index);
      // 	} else { // Nothing there. OK, drop from the bucket with the farthest contacts
      // 	  this.forEachBucket(bucket => !(dropped = removeLast(bucket.contacts)), 'reverse');
      // 	  console.log('\n\n\n**** FIXME','dropping bucket contact', dropped.report, 'from', this.contact.report);
      // 	}
      // }
      const farContactForUs = dropped.hasTransport;
      Node.assert(farContactForUs.key === this.key, 'Far contact for us does not point to us.');
      Node.assert(farContactForUs.host.key === dropped.key, 'Far contact for us does is not hosted at contact.');
      farContactForUs.hasTransport = null;
      // if (farContactForUs.sponsor) 
      // else {
      // 	// if (farContactForUs.host.name === '265') {
      // 	//   console.log('\n\n\n**** FIXME', 'removeKey', this.name, 'from', farContactForUs.host.report(null));
      // 	// }
      // 	//fixme farContactForUs.host.removeKey(this.key); // They don't have another path to us because we contacted them directly.
      // 	farContactForUs.hasTransport = null; // fixme: same as above. simplify
      // }
      dropped.hasTransport = null;
    }
    contact = contact.clone(this, null);
    Node.assert(contact.key !== this.key, 'noting contact for self transport', this, contact);
    this.looseTransports.push(contact);
    return contact;
  }
  get contacts() { // Answer a fresh copy of all contacts for this Node.
    const contacts = [];
    this.forEachBucket(bucket => contacts.push(...bucket.contacts));
    return contacts;
  }
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

  static findClosestHelpers(targetKey, contacts, count = KBucket.k) { // Utility, useful for computing and debugging.
    const helpers = contacts.map(contact => new Helper(contact, this.distance(targetKey, contact.key)));
    helpers.sort(Helper.compare);
    return helpers.slice(0, count);
  }
  findClosestHelpers(targetKey, count = KBucket.k) { // Answer count closest Helpers to targetKey, including ourself.
    const contacts = this.contacts; // Always a fresh copy.
    contacts.push(this.contact); // We are a candidate, too!
    return this.constructor.findClosestHelpers(targetKey, contacts, count);
  }
  static commonPrefixLength(distance) { // Number of leading zeros of distance (within fixed keySize).
    if (distance === this.zero) return this.keySize; // I.e., zero distance => our own Node => 128 (i.e., one past the farthest bucket).
    
    let length = 0;
    let mask = this.one << BigInt(this.keySize - 1);
    
    for (let i = 0; i < this.keySize; i++) {
      if ((distance & mask) !== this.zero) {
        return length;
      }
      length++;
      mask >>= this.one;
    }
    
    return this.keySize;
  }
  getBucketIndex(key) { // index of routingTable KBucket that should contain the given Node key.
    // We define bucket 0 for the closest distance, and bucket (keySize - 1) for the farthest,
    // as in the original paper. Note that some implementation and papers number these in the reverse order.
    // Significantly, Wikipedia numbers these in the reverse order, AND it implies that the buckets
    // represent addresses, when in fact they represent a distance from current node's address.
    const distance = this.constructor.distance(this.key, key);
    const prefixLength = this.constructor.commonPrefixLength(distance);
    return 128 - prefixLength - 1;
  }
  randomTargetInBucket(bucketIndex) { // Return a key for which this.getBucketIndex will be the given bucketIndex.
    const keySize = this.constructor.keySize;
    const nLeadingZeros = keySize - 1 - bucketIndex;
    let binary = '0'.repeat(nLeadingZeros);
    binary += '1'; // Next bit must be one to stay in bucket.
    // Now fill the rest (if any) with random bits.
    for (let i = nLeadingZeros + 1; i < keySize; i++) binary += Math.round(Math.random());
    const distance = BigInt('0b' + binary);
    const target = this.constructor.distance(distance, this.key);
    return target;
  }
  // Discovery
  // 
  routingTableSerializer = Promise.resolve();
  addToRoutingTable(contact) { // Promise contact, and add it to the routing table if room.
    return this.routingTableSerializer = this.routingTableSerializer.then(async () => {
      const key = contact.key;
      if (key === this.key) return false; // Don't add self

      const routingTable = this.routingTable;
      const bucketIndex = this.getBucketIndex(key);

      // Get or create bucket
      let bucket = routingTable.get(bucketIndex);
      if (!bucket) {
	bucket = new KBucket(this, bucketIndex);
	routingTable.set(bucketIndex, bucket);
      }

      // Asynchronous so that this doesn't come within our activity.
      if (!bucket.contacts.find(c => c.key === key)) this.replicateCloserStorage(contact);

      // Try to add to bucket
      if (await bucket.addContact(contact)) {
	this.removeLooseTransport(key); // Can't be in two places.
	return contact;
      }
      return false;
    });
  }
  removeKey(key) { // Removes from node entirely ir present, from looseTransports or bucket as necessary.
    if (this.removeLooseTransport(key)) return;
    const bucketIndex = this.getBucketIndex(key);
    const bucket = this.routingTable.get(bucketIndex);
    bucket?.removeKey(key); // Host might not yet have added node or anyone else as contact for that bucket yet.	    
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
  async refresh(bucketIndex) { // Refresh specified bucket using LocateNodes for a random key in the specified bucket's range.
    const targetKey = this.randomTargetInBucket(bucketIndex);
    await this.locateNodes(targetKey); // Side-effect is to update this bucket.
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
      if (!bucket && !started) continue;
      if (!started) started = true;
      else if (!bucket) await this.refresh(index);
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
