const { BigInt, TextEncoder, crypto } = globalThis; // For linters.

// See spec/*.js for API examples.

/*
  A Node is an actor in the DHT, and it has a key - a BigNum of Node.keySize bits:
  - A typical client will have one Node instance through which it interacts with one DHT.
  - A server or simulation might have many Node instances to each interact with the same DHT.
  A Node has a Contact object to represent itself to another Node.
  A Node maintains KBuckets, which each have a list of Contacts to other Nodes.

  A Contact is the means through which a Node interacts with another Node instance:
  - When sending an RPC request, the Contact will "serialize" the sender Nodes's contact.
  - When receiving an RPC response, the sender "deserializes" a string (maybe using a cache)
    to produce the Contact instance to be noted in the receiver's KBuckets.
  - In classic UDP Kademlia, a Contact would serialize as {key, ip, port}.
  - In a simulation, a Contact could "serialize" as just itself.
  - In our system, I imagine that it will serialize as signature so that keys cannot be forged.

  Some operations involve an ephemeral {contact, distance} Helper object, where distance has
  been computed between contact.key and some targetKey. 

  TODO: there are few places where we return a list of Helpers (or Contacts?) that are described in the literature (or method name!) as returning Nodes. Let's do that, since we can get Nodes from Helpers/Contacts, and Contacts from Nodes.
  TODO: It would be convenient for bucket to cache their host and index. This would allow get rid of some/all? uses of contact.host, and move some operations (randomTargetInBucket, refresh) to KBucket.
 */

export class Contact {
  // Represents an abstract contact from a host (a Node) to another node.
  // The host calls aContact.sendRpc(...messageParameters) to send the message to node and promises the response.
  // This could be by wire, by passing the message through some overlay network, or for just calling a method directly on node in a simulation.
  static fromNode(node, host = node) {
    const contact = new this();
    // Every Contact is unique to a host Node, from which it sends messages to a specific "far" node.
    // Every Node caches a contact property for that Node as it's own host, and from which Contacts for other hosts may be cloned.
    node.contact ||= contact;
    contact.node = node;
    contact.host = host; // In whose buckets does this contact live?
    return contact;
  }
  static async create(properties) {
    return this.fromNode(await Node.create(properties));
  }
  static fromKey(key, host) {
    const node = Node.fromKey(key);
    return this.fromNode(node, host || node);
  }
  get name() { return this.node.name; }
  get key() { return this.node.key; }
  join(other) { return this.node.join(other); }
  sendCatchingRpc(...rest) {
    return this.sendRpc(...rest)
      .catch(error => {
	return undefined;
      });
  }
  store(key, value) {
    return this.sendCatchingRpc('store', key, value);
  }
}
export class SimulatedContact extends Contact {
  clone(hostNode) { // Contact may be info, shared with another Node, or from a different bucket. Make/adjust as needed.
    if (this.host === hostNode) return this; // All good.
    return this.constructor.fromNode(this.node, hostNode);
  }
  get farHomeContact() { // Answer the canonical home Contact for the node at the far end of this one.
    return this.node.contact;
  }
  inFlight = []; // All 
  _connected = true;
  startRequest(promise) { // Keep track of the request in flight, for use by disconnect()
    this.farHomeContact.inFlight.push(promise);
  }
  endRequest(promise) { // The request has completed.
    this.farHomeContact.inFlight = this.farHomeContact.inFlight.filter(p => p !== promise);
  }
  get isConnected() { // Ask our canonical home contact.
    return this.farHomeContact._connected;
  }
  disconnect() { // Simulate a disconnection of node, marking as such and rejecting any RPCs in flight.
    const { farHomeContact } = this;

    // For debugging, show that disconnects are happening by reporting if the highest number Node.contacts is disconnecting.
    // (The lower number Node.contacts might be bootstrap nodes.)
    if (Node.contacts?.length && this.farHomeContact === Node.contacts[Node.contacts.length - 1]) console.log('disconnect', this.farHomeContact.name);

    farHomeContact._connected = false;
    this.node.stopRefresh();
    const rejection = new Error('disconnected'); // Gathers stack trace.
    try {
      farHomeContact.inFlight.forEach(promise => promise.reject(rejection));
    } catch (error) {
      console.error(`Error during disconnect of ${this.farHomeContact.name}.`, error);
    }

    // For debugging: Report if we're killing the last holder of our data.
    if (!Node.contacts) return;
    for (const key of this.node.storage.keys()) {
      let remaining = [];
      for (const contact of Node.contacts) {
	if (contact.isConnected && contact.node.storage.has(key)) remaining.push(contact.node.name);
      }
      if (!remaining.length) console.log(`Disconnecting ${this.node.name}, last holder of ${key}: ${this.node.storage.get(key)}.`);
    }
  }
  deserialize(requestResponse, sender) { // Set up any serialized contacts for the originating host Node.
    return Node.isArrayResult(requestResponse) ?
      requestResponse.map(h => new Helper(h.contact.clone(sender.host), h.distance)) :
      requestResponse;
  }
  sendRpc(method, ...rest) { // Promise the result of a nework call to node. Rejects if we get disconnected along the way.
    const sender = this.host.contact;
    if (!sender.isConnected) return Promise.reject('RPC from closed sender.');
    
    const start = Date.now();
    let promise = this.transmitRpc(method, sender, ...rest); // The main event.
    this.startRequest(promise);
    return promise
      .catch(rejection => {
	// Note that recipient is gone.
	// TODO: this common code for all implementations needs to be bottlenecked through Node
	let key = this.key;
	let bucketIndex = this.host.getBucketIndex(key);
	let bucket = this.host.routingTable.get(bucketIndex);
	bucket.removeKey(key); // We may have already removed it.
	throw (new Error(rejection));
      })
      .then(result => {
	if (!sender.isConnected) throw (new Error('Sender closed during RPC.')); // No need to remove recipient key from host bucket.
	return this.deserialize(result, sender);
      })
      .finally(() => {
	this.endRequest(promise);
	Node.noteStatistic(start, 'rpc');
      });
  }
  transmitRpc(...rest) {
    return this.receiveRpc(...rest);
  }
  async receiveRpc(method, ...rest) { // Call the message method to act on the 'to' node side.
    return await this.node[method](...rest);
  }
}


export class SimulatedOverlayContact extends SimulatedContact {
  transmitRpc(...rest) { // A message from this.host to this.node. Forward to this.node through overlay connection for bucket.
    //if (!this.node.contact.isConnected) console.log(this.host.name, 'trying to reach disconnected node', this.node.name);
    return this.constructor.forwardThroughOverlay(this.host, this.node.key, rest, this.node.name);
  }
  static async forwardThroughOverlay(node, intendedContactKey, message, debugTargetName) {
    // Pass the rest message through a Node towards the intendedContactKey, and promise the response.

    if (!node.contact.isConnected) return Promise.reject(new Error('overlay through disconnected node'));
    
    // If we are not yet connected or host is who we are intended to contact, then just have the host handle it.
    if (!node.routingTable.size || (intendedContactKey === node.key))
      return await node.contact.receiveRpc(...message); // FIXME .then check if node.contact.isConnected

    // Otherwise find the closest bucket we have to intendedContactKey, and forward through a simulated connection servicing that bucket.
    const bestHelpers = node.findClosestHelpers(intendedContactKey); // Best node knows of in its own data.
    const helpersNotUs = bestHelpers.filter(h => h.key !== node.key);
    //if (node.name === '0')
      // console.log(node.name, node.contact.isConnected, 'to', debugTargetName,
      // 		  bestHelpers.map(h => `${h.name}${h.isConnected ? '' : 'd'}`),
      // 		  node.contacts.map(c => c.name + (c.isConnected ? '' : 'd')));
    for (const helper of helpersNotUs) { // Find the best one that already has a bucket
      const bucketIndex = node.getBucketIndex(helper.key);
      const bucket = node.routingTable.get(bucketIndex);
      if (!bucket) continue;
      // Here we simulate a long lived connection by caching the overlay remote node for this bucket.
      const overlay = await bucket.ensureOverlay();

      if (!overlay) continue;

      // if (node.name === '0') {
      //   console.log(node.name, node.contact.isConnected, 'overlay', overlay.name, 'to', debugTargetName,
      // 		    node.constacts.map(c => c.name + (c.isConnected ? '' : 'd')),
      // 		    bestHelpers.map(h => h.name + (h.isConnected ? '' : 'd')),
      // 		    helpersNotUs.map(h => h.name + (h.isConnected ? '' : 'd')));
      // 	Node.reportAll();
      // }
      const start = Date.now();
      const result = await this.forwardThroughOverlay(overlay, intendedContactKey, message, debugTargetName);
      Node.noteStatistic(start, 'overlay');
      return result;
    }
    Node.assert(true, "No bucket to forward through", node, bestHelpers);
  }
  static maxOverlayConnections = 200;
  async makeOverlay(contact, ourBucket, force) {
    // Make an overlay connection from here to bucket, caching it in the approriate bucket of both sides.
    // See caller for interpretation of force.
    // For WebRTC, this will involve signaling between us and the candidate contact.
    // The signaling may take place through a server or through the network. (We do not distinguish in this simulation.)
    // TODO: WebRTC will know quickly if the overlay has closed. Should we do something on close?
    const { host, node } = contact;

    if (!host.contact.isConnected || !node.contact.isConnected) return undefined;
    const { maxOverlayConnections } = this.constructor;
    const tooManyHost = host.nOverlayConnections > maxOverlayConnections;
    const tooManyNode = node.nOverlayConnections > maxOverlayConnections;
    if (!force && (tooManyHost || tooManyNode)) return undefined;
    // Add contacts to both routing tables, if possible.
    const outBound = await host.addToRoutingTable(contact);
    const inBound = await node.addToRoutingTable(host.contact);
    if (!force && (!outBound || !inBound)) return undefined;

    // It is possible that the other end connected to us while we were awaiting addToRoutingTable.
    const key = c => c.key;
    const ourKeys = ourBucket.overlayContacts.map(key);
    if (!ourKeys.includes(host.key)) {
      if (tooManyHost) host.kickOverlayContact();
      ourBucket.overlayContacts.push(outBound);
    }
    // The other side has a bucket at this point(post node.addToRoutingTable), but we don't which bucket.
    const theirBucket = node.routingTable.get(node.getBucketIndex(host.key));
    const theirKeys = theirBucket.overlayContacts.map(key);
    if (!theirKeys.includes(node.key)) {
      if (tooManyNode) node.kickOverlayContact();
      theirBucket.overlayContacts.push(inBound);
    }
    return node;
  }
}

export class Helper { // A Contact that is some distance from an assumed targetKey.
  constructor(contact, distance) {
    this.contact = contact;
    this.distance = distance;
  }
  get key() { return this.contact.key; }
  get name() { return this.contact.name; }
  get node() { return this.contact.node; }
  get isConnected() { return this.contact.isConnected; }
  static compare = (a, b) => { // For sort, where a,b have a distance property returning a BigInt.
    // Sort expects a number, so bigIntA - bigIntB won't do.
    // This works for elements of a list that have a distance property -- they do not strictly have to be Helper instances.
    if (a.distance < b.distance) return -1;
    if (a.distance > b.distance) return 1;
    return 0;
  }
}
  
export class KBucket {  // Bucket in a RoutingTable: a list of up to k Node keys, plus a lastUpdated timestamp, as enforced by addContact().
  static k = 20; // System constant.

  contacts = [];
  get length() { return this.contacts.length; } // How many do we have (not capacity, which is k.)
  get isFull() { return this.length >= this.constructor.k; } // Are we at capacity?

  async addContact(contact) { // Returns 'present' or 'added' if it was added to end within capacity, and timestamp updated, else false.
    let added = this.removeKey(contact.key) || 'added';
    if (this.isFull) {
      const head = this.contacts[0];
      const {key, host} = head;
      this.removeKey(key);
      if (await head.sendCatchingRpc('ping', key)) { // still alive
	added = false;  // New contact will not be added.
	contact = head; // Add head back and update timestamp, below.
      } // Else dead head, so there's room for the new contact after all.
    }
    this.contacts.push(contact);
    this.lastUpdated = Date.now();
    const { node, host } = contact;
    // Refresh this bucket unless we addContact again before it goes off.
    clearInterval(this.refreshTimer);
    this.refreshTimer = host.repeat(() => host.refresh(host.getBucketIndex(node.key)), 'bucket');
    return added;
  }

  removeKey(key) { // Removes item specified by key (if present), and return 'present' if it was, else false.
    const { contacts, replacementCache } = this;
    let index;
    index = replacementCache.findIndex(item => item.key === key);
    if (index !== -1) {
      replacementCache.splice(index, 1);
      return false; // It was not among contacts.
    }
    index = contacts.findIndex(item => item.key === key);
    if (index !== -1) {
      contacts.splice(index, 1);
      return 'present';
    }
    return false;
  }
  replacementCache = []; // TODO: use these when needed!

  // Overlay connections.
  overlayContacts = []; // There can be several, from other nodes making an overlay connection to us.
  async ensureOverlay() { // Promise a cached working overlay node for this bucket's distance.
    const { overlayContacts } = this;    
    // Get an existing one that is still connected, if any.
    // It doesn't matter if is to one of the k we are tracking in this bucket.
    while (overlayContacts.length) {
      const candidate = overlayContacts[0];
      if (candidate.isConnected) return candidate.node;
      overlayContacts.shift();
      this.removeKey(candidate.key);
    }
    return await this.makeOverlay(false) ||
      await this.makeOverlay(true);
  }
  async makeOverlay(force) { // Create and cache overlay for this bucket, promising the far node, else falsy.
    // Both ends must still be online (isConnected).
    // Unless forced, both ends will attempt to add the other to its routing table, and
    // will fail if there's no room for it, or if either end is at its connection limit.
    // If forced, both ends will kill an existing overlay to stay within our limit.
    for (const candidate of this.contacts.slice()) { // Copy of contacts, as we may be re-adding contacts at the end.
      const overlay = await candidate.host.contact.makeOverlay(candidate, this, force);
      if (overlay) return overlay;
    }
    Node.assert(true, "Unable to makeOverlay for bucket", this);
    return null;
  }
}


export class Node { // An actor within thin DHT.
  static alpha = 3; // How many lookup requests are initially tried in parallel. If no progress, we repeat with up to k more.
  // TODO: Let's make this as small as possible without flooding network. How do we determine that?
  static refreshTimeIntervalMS = 15e3; // Original paper for desktop filesharing was 60 minutes.
  static k = 20; // Chosen so that for any k nodes, it is highly likely that at least one is still up after refreshTimeIntervalMS.
  static keySize = 128; // Number of bits in a key. Must be multiple of 8 and <= sha256.
  constructor({refreshIntervalMS = Node.refreshIntervalMS, ...properties}) {
    Object.assign(this, {refreshIntervalMS, ...properties});
  }
  static debug = false;
  static log(...rest) { if (this.debug) console.log(...rest); }
  log(...rest) { this.constructor.log(this.name, ...rest); }
  static assert(ok, ...rest) { // If !ok, log rests and exit.
    if (ok) return;
    console.error(...rest, new Error("Error").stack);
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
      let buckets = 0, contacts = 0, stored = 0, overlays = 0;
      for (const {node} of this.contacts) {
	stored += node.storage.size;
	for (let i = 0; i < Node.keySize; i++) {
	  const bucket = node.routingTable.get(i);
	  if (!bucket) continue;
	  buckets++;
	  contacts += bucket.contacts.length;
	  overlays += bucket.overlayContacts.length;
	}
      }
      _stats.contacts = Math.round(contacts/this.contacts.length);
      _stats.overlays = Math.round(overlays/this.contacts.length);
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
      rpc: Object.assign({}, stat),
      overlay: Object.assign({}, stat)
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
  forEachBucket(iterator) { // Call iterator(bucket) on each non-empty bucket, stopping as soon as iterator(bucket) returns falsy.
    for (const bucket of this.routingTable.values()) {
      if (bucket && !iterator(bucket)) return;
    }
  }
  get contacts() { // Answer a fresh copy of all keys.
    const contacts = [];
    this.forEachBucket(bucket => contacts.push(...bucket.contacts));
    return contacts;
  }
  get nOverlayContacts() { // How many overlays do we have
    let n = 0;
    this.forEachBucket(bucket => ((n += bucket.overlayContacts.length) || true));
    return n;
  }
  report(logger = console.log) { // return logger( a string description of node )
    let report = `Node: ${this.name}${this.contact?.isConnected ? '' : ' disconnected'}`;
    function keyString(key) { return key.toString() + 'n'; }
    function contactsString(contacts) { return contacts.map(contact => contact.name + (contact.isConnected ? '' : 'd')).join(', '); }
    if (this.storage.size) {
      report += `\n  storing ${this.storage.size}: ` +
	Array.from(this.storage.entries()).map(([k, v]) => `${keyString(k)}: ${JSON.stringify(v)}`).join(', ');
    }
    for (let index = 0; index < Node.keySize; index++) {
      const bucket = this.routingTable.get(index);
      if (!bucket) continue;
      report += `\n  ${index}: ` + contactsString(bucket.contacts);
      const { replacementCache, overlayContacts} = bucket;
      if (overlayContacts.length)  report += ' contacts: ' + contactsString(overlayContacts);
      if (replacementCache.length) report += ' replacements: ' + contactsString(replacementCache);
    }
    return logger ? logger(report) : report;
  }
  static reportAll() { // Report every node -- only useful for simulations.
    Node.contacts?.forEach(c => c.node.report());
  }

  static findClosestHelpers(targetKey, contacts, count) { // Utility, useful for computing and debugging.
    const helpers = contacts.map(contact => new Helper(contact, Node.distance(targetKey, contact.key)));
    helpers.sort(Helper.compare);
    return helpers.slice(0, count);
  }
  findClosestHelpers(targetKey, count = KBucket.k) { // Answer count closest Helpers to targetKey, including ourself.
    if (!this.contact?.isConnected) return [];
    const {contacts} = this;
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
  canSplitBucket(bucketIndex) { // True if adaptive routing bucket can be split.
    // A bucket can only be split if it's in the range of our own node ID's prefix
    // This handles unbalanced trees by only splitting buckets we care about
    const bucket = this.routingTable.get(bucketIndex);
    if (!bucket || !bucket.isFull) return false;
    
    // Check if any keys in the bucket would remain after split
    const subBuckets = new Map();
    for (const contact of bucket.contacts) {
      const newIndex = this.getBucketIndex(contact.key);
      if (newIndex !== bucketIndex) {
        if (!subBuckets.has(newIndex)) {
          subBuckets.set(newIndex, []);
        }
        subBuckets.get(newIndex).push(contact);
      }
    }
    
    // Can split if keys would be distributed to different buckets
    return subBuckets.size > 0;
  }
  async splitBucket(bucketIndex) { // Split a bucket into multiple smaller buckets
    const bucket = this.routingTable.get(bucketIndex);
    if (!bucket) return;
    this.routingTable.delete(bucketIndex);
    // Re-add all contacts, which will place them in new buckets
    const add = contact => this.addToRoutingTable(contact);
    await Promise.all(bucket.contacts.map(add));
    await Promise.all(bucket.replacementCache.forEach(add));
  }  
  async addToRoutingTable(contact) { // Promise true and contact to the routing table if room, using adaptive bucket sizing.
    const key = contact.key;
    if (key === this.key) return false; // Don't add self

    const bucketIndex = this.getBucketIndex(key);
    
    // Get or create bucket
    if (!this.routingTable.has(bucketIndex)) {
      this.routingTable.set(bucketIndex, new KBucket());
    }
    const bucket = this.routingTable.get(bucketIndex);
    
    // Try to add to bucket
    contact = contact.clone(this);
    if (await bucket.addContact(contact)) {
      this.replicateCloserStorage(contact); // Don't bother awaiting
      return contact;
    }
    
    // Bucket is full - handle adaptive splitting for unbalanced trees
    // Split only if this bucket contains keys that should be in our routing table
    if (bucketIndex >= 0 && this.canSplitBucket(bucketIndex)) {
      await this.splitBucket(bucketIndex);
      // Try adding again after split
      return await this.addToRoutingTable(contact);
    }

    const replacements = bucket.replacementCache; // TODO? (in-order) dictionary instead of list?
    if (!replacements.find(contact => contact.key === key)) replacements.push(contact);
    return false;
  }
  kickOverlayContact() { // Remove the oldest from the bucket with the most overlayContacts
    let biggestBucket = null;
    this.forEachBucket(bucket => (bucket.overlayContacts.length > (biggestBucket?.overlayContacts.length ?? 0)) ?
		       (biggestBucket=bucket) :
		       true);
    biggestBucket.overlayCandidates.shift();
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
  repeat(thunk, statisticsKey, interval) {
    // Clear previous, and return a timer that will go off in interval, and repeat.
    // If not specified, interval computes a new fuzzyInterval each time it repeats.
    // Does nothing if interval is zero.
    if (0 === this.refreshTimeIntervalMS || 0 === this.constructor.refreshTimeIntervalMS) return null; // regardless of interval

    // We use repeated setTimer rather than setInterval because it is important in the
    // default case to use a different random interval each time, so that we don't have
    // everything firing at once repeatedly.
    const timeout = (interval === undefined) ?  this.fuzzyInterval() : interval;
    if (!timeout) return null;

    const scheduled = Date.now();
    return setTimeout(async () => {
      const fired = Date.now();
      this.repeat(thunk, statisticsKey, interval); // Set it now, so as to not be further delayed by thunk.
      await thunk();
      const lag = fired - scheduled - timeout;
      //Node.assert(lag < 5, "Cannot keep up with", statisticsKey);
      const status = Node._stats?.[statisticsKey];
      if (status) {
	const elapsed = Date.now() - fired; // elapsed in thunk
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

    // Optimization: Works, but can confuse testing as disconnected nodes will return a value.
    // const found = this.retrieveLocally(targetKey);
    // if (found !== undefined) return found;

    const result = await this.iterate(targetKey, 'findValue');
    if (Node.isValueResult(result)) return result.value;
    return undefined;
  }
  async storeValue(targetKey, value) { // Convert targetKey to a bigint if necessary, and store k copies.
    targetKey = await this.ensureKey(targetKey);
    // Go until we are sure have written k.
    let remaining = this.constructor.k;
    let helpers = await this.locateNodes(targetKey, remaining * 2);
    helpers = helpers.reverse(); // So we can pop off the end.
    // TODO: batches in parallel, if the client and network can handle it. (For now, better to spread it out.)
    while (helpers.length && remaining) {
      const contact = helpers.pop().contact;
      const stored = await contact.store(targetKey, value);
      if (stored) remaining--;
    }
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
    await this.addToRoutingTable(helper.contact); // Live. Update bucket.
    if (Node.isArrayResult(results)) { // Keep only those that we have not seen, and note the new ones we have.
      results = results.filter(helper => !keysSeen.has(helper.key) && keysSeen.add(helper.key));
    }
    return results;
  }
  async iterate(targetKey, finder, k = this.constructor.k * 2) { // Promise a best-first list of k Helpers
    // from the network, by repeatedly trying to improve our closest known by applying finder.
    // But if any finder operation answer isValueResult, answer that instead.

    // Always k
    // let candidates = this.findClosestHelpers(targetKey, k);
    // const keysSeen = new Set(candidates.map(h => h.key));
    // while (candidates.length && this.contact.isConnected) {
    //   let helpers = candidates.slice(0, k);
    //   let requests = helpers.map(helper => this.step(targetKey, finder, helper, keysSeen));
    //   let results = await Promise.all(requests);

    //   let found = results.find(Node.isValueResult);
    //   if (found) {
    // 	// Store at all the others that didn't have it.
    // 	//helpers.forEach(h => h.contact.store(targetKey, found.value));
    // 	return found;
    //   }

    //   let closer = [].concat(...results); // By construction, these are closer than the ones we tried.
    //   if (!closer.length) return candidates.slice(0, this.constructor.k);;
    //   candidates = [...closer, ...candidates].sort(Helper.compare);
    // }
    // return [];

    // We start with more than we need, because some will turn out to be disconnected.
    let pool = this.findClosestHelpers(targetKey, k); // The k best-first Helpers known so far, that we have NOT queried yet.
    const alpha = Math.min(pool.length, this.constructor.alpha);
    const keysSeen = new Set(pool.map(h => h.key));    // Every key we've seen at all (candidates and all responses).
    let toQuery = pool.slice(0, alpha);
    pool = pool.slice(alpha); // Yes, this could be done with splice instead of slice, above, but it makes things hard to trace.
    let best = []; // The accumulated closest-first result.
    let trace = [ [[this.contact], pool, toQuery] ];
    while (toQuery.length && this.contact.isConnected) {
      let requests = toQuery.map(helper => this.step(targetKey, finder, helper, keysSeen));
      let results = await Promise.all(requests);
      
      let found = results.find(Node.isValueResult);
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
      trace.push([toQuery, pool, closer]);
      // closer might not be in order, and one or more toQuery might belong among them.
      best = [...closer, ...toQuery, ...best].sort(Helper.compare).slice(0, k);
      if (!closer.length) {
	if (toQuery.length === alpha && pool.length) {
	  toQuery = pool.slice(0, k);  // Try again with k more. (Interestingly, not k - alpha.)
	  pool = pool.slice(k);
	} else break; // We've tried everything and there's nothing better.
      } else {
	pool = [...closer, ...pool].slice(0, k); // k best-first nodes that we have not queried.
	toQuery = pool.slice(0, alpha);
	pool = pool.slice(alpha);
      }
    }
    // if (finder === 'findValue') {
    //   console.log(this.name, 'failed to find', targetKey);
    //   trace.forEach(([query, pool, result]) =>
    // 	//console.log(query, 'produced', result)
    // 	console.log(query.map(h => h.node.report(null)), `with ${pool.length} remaining, produced`, result.map(h => h.node.report(null)))
    //   );
    // }
    return best;
  }
  async refresh(bucketIndex) { // Refresh specified bucket using LocateNodes for a random key in the specified bucket's range.
    const targetKey = this.randomTargetInBucket(bucketIndex);
    await this.locateNodes(targetKey); // Side-effect is to update this bucket.
  }
  async join(contact) {
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
  async ping(sender, key) { // Respond with 'pong'.
    // If we're disconnected, the RPC machinery will take care of it.
    await this.addToRoutingTable(sender);
    return 'pong';
  }
  async store(sender, key, value) { // Tell Entry node to store identifier => value.
    await this.addToRoutingTable(sender);
    this.storeLocally(key, value);
    return 'pong';
  }
  async findNodes(sender, key) { // Return k closest Contacts from routingTable.
    // TODO: Currently, this answers a list of Helpers. For security, it should be changed to a list of serialized Contacts.
    // I.e., send back a list of verifiable signatures and let the receiver verify and then compute the distances.
    await this.addToRoutingTable(sender);
    return this.findClosestHelpers(key);
  }
  async findValue(sender, key) { // Like sendFindNode, but if other has identifier stored, reject {value} instead.
    await this.addToRoutingTable(sender);
    let value = this.retrieveLocally(key);
    if (value !== undefined) return {value};
    return this.findClosestHelpers(key);
  }
}
