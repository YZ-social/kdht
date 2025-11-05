const { BigInt, TextEncoder, crypto } = globalThis; // For linters.

// See spec/*.js for API examples.

/*
  A Node is an actor in the DHT, and it has a key:
  - A typical client will have one Node instance through which it interacts with one DHT.
  - A server or simulation might have many Node instances to interact with the same DHT.
  A Node has a Contact object to represent itself.
  A Node maintains KBuckets, which each have a list of Contacts to other Nodes.
  The key is a BigNum of Node.keySize bits.

  A Contact is the means through which a Node interacts with another Node instance:
  - When send an RPC request, the Contact will "serialize" the sender Nodes's contact.
  - When receiving an RPC response, the sender "deserializes" a string (maybe using a cache)
    to produce the Contact instance for the KBuckets.
  - In classic UDP Kademlia, a Contact would serialize as {key, ip, port}.
  - In a simulation, a Contact could "serialize" as just itself.
  - Ultimately, I imagine that it will serialize as signature so that keys cannot be forged.

  Some operations involve an ephemeral {contact, distance} object, where distance has
  been computed between contact.key and some targetKey. This called a Helper.
  TODO: there are few places where we return a list of Helpers (or Contacts?) that are described in the literature (or method name!) as returning Nodes. Let's do that, since we can get Nodes from Helpers/Contacts, and Contacts from Nodes.  
 */
export class Contact {
  join(other) { return this.node.join(other); }
}
export class SimulatedContact extends Contact {
  get key() { return this.node.key; }
  get name() { return this.node.name; }
  static fromNode(node, host = node) {
    const contact = new this();
    contact.node = node;
    contact.host = host; // In whose buckets does this contact live?
    node.contact = contact;
    return contact;
  }
  static async create(properties) {
    return this.fromNode(await Node.create(properties));
  }
  static fromKey(key) {
    return this.fromNode(Node.fromKey(key));
  }
}
export class SimulatedDirectContact extends SimulatedContact {
  async sendPing(sender) { // Resolve true if still alive
    this.node.addToRoutingTable(sender);
    return !!this.node;
  }
  async sendStore(sender, key, value) { // Tell Entry node to store identifier => value.
    this.node.addToRoutingTable(sender);
    this.node.storeLocally(key, value);
  }
  async sendFindNodes(sender, key) { // Return k closest Contacts from routingTable.
    // TODO: Currently, this answer a list of Helpers. For security, it should be changed to a list of serialized Contacts.
    // I.e., send back a list of verifiable signatures and let the receiver verify and then compute the distances.
    this.node.addToRoutingTable(sender);
    return this.node.findClosestHelpers(key);
  }
  async sendFindValue(sender, key) { // Like sendFindNode, but if other has identifier stored, reject {value} instead.
    this.node.addToRoutingTable(sender);
    let value = this.node.retrieveLocally(key);
    if (value !== undefined) throw {value};
    return this.node.findClosestHelpers(key);
  }
}
export class SimulatedWebRtcContact extends SimulatedContact {
  async sendPing(sender) { // Resolve true if still alive
    this.node.addToRoutingTable(sender);
    return !!this.node;
  }
  async sendStore(sender, key, value) { // Tell Entry node to store identifier => value.
    this.node.addToRoutingTable(sender);
    this.node.storeLocally(key, value);
  }
  async sendFindNodes(sender, key) { // Return k closest Contacts from routingTable.
    // TODO: Currently, this answer a list of Helpers. For security, it should be changed to a list of serialized Contacts.
    // I.e., send back a list of verifiable signatures and let the receiver verify and then compute the distances.
    this.node.addToRoutingTable(sender);
    return this.node.findClosestHelpers(key);
  }
  async sendFindValue(sender, key) { // Like sendFindNode, but if other has identifier stored, reject {value} instead.
    this.node.addToRoutingTable(sender);
    let value = this.node.retrieveLocally(key);
    if (value !== undefined) throw {value};
    return this.node.findClosestHelpers(key);
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

  addContact(contact) { // Returns true if it was added to end within capacity, and timestamp updated. (Existing is moved to end.)
    const exists = this.removeKey(contact.key);
    if (this.isFull) return false; // FIXME: before returning, we should remove head of bucket (and add key) if it doesn't respond to a ping.
    this.contacts.push(contact);
    this.lastUpdated = Date.now();
    return true;
  }

  removeKey(key) { // Removes item specified by key (if present), and return boolean as to whether it was present.
    const index = this.contacts.findIndex(item => item.key === key);
    if (index !== -1) {
      this.contacts.splice(index, 1);
      return true;
    }
    return false;
  }
  replacementCache = [];
}

export class Node { // An actor within thin DHT.
  static alpha = 3; // How many lookup requests are initially tried in parallel. If no progress, we repeat with up to k more.
  // TODDO: Let's make this as small as possible without flooding network. How do we determine that?
  static refreshMS = 15e3; // Original paper for desktop filesharing was 60 minutes.
  // TODO: Original k=20 was chosen based on Gnutella desktop data. How do we figure out ours?
  static k = 20; // Chosen so that for any k nodes, it is highly likely that at least one is still up after refreshMS.
  static keySize = 128; // Number of bits in a key. Must be multiple of 8 and <= sha256.
  constructor(properties) { Object.assign(this, properties); }
  static debug = false;
  static log(...rest) { if (this.debug) console.log(...rest); }
  log(...rest) { this.constructor.log(...rest); }

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
  static async create(name = this.counter++) { // Create a node with a simple name and matching key.
    name = name.toString();
    const key = await this.key(name);  
    return new this({name, key});
  }
  static fromKey(key) { // Forge specific key for testing.
    if (typeof(key) !== 'bigint') key = BigInt(key);
    return new this({name: key.toString() + 'n', key});
  }

  /* Internal operations that do not talk to other nodes */
  static zero = 0n;
  static one = 1n;
  // Examination
  static distance(keyA, keyB) { // xor
    return keyA ^ keyB;
  }
  routingTable = new Map(); // Maps bit prefix length to KBucket
  get contacts() { // Answer a fresh copy of all keys.
    const contacts = [];
    for (const bucket of this.routingTable.values()) {
      contacts.push(...bucket.contacts);
    }
    return contacts;
  }
  report(logger = console.log) { // return logger( a string description of node )
    let report = `Node: ${this.name}`;
    function keyString(key) { return key.toString() + 'n'; }
    function contactsString(contacts) { return contacts.map(contact => contact.name).join(', '); }
    const storedKeys = Object.keys(this.storage);
    if (storedKeys.length) {
      report += '\n  storing: ' + storedKeys.map(k => `${keyString(k)}: ${JSON.stringify(this.storage[k])}`).join(', ');
    }
    for (let index = 0; index < Node.keySize; index++) {
      const bucket = this.routingTable.get(index);
      if (!bucket) continue;
      report += `\n  ${index}: ` + contactsString(bucket.contacts);
      const replacements = bucket.replacementCache;
      if (!replacements.length) continue;
      report += ' replacements: ' + contactsString(replacements);
    }
    return logger ? logger(report) : report;
  }
  findClosestHelpers(targetKey, count = KBucket.k) { // Answer count closest Helpers to targetKey, not including ourself.
    const allContacts = this.contacts;
    allContacts.push(this.contact); // Can include us!
    const helpers = allContacts.map(contact => new Helper(contact, Node.distance(targetKey, contact.key)));
    helpers.sort(Helper.compare);
    return helpers.slice(0, count);
  }
  static commonPrefixLength(distance) { // Number of leading zeros for our keySize
    if (distance === this.zero) return this.keySize;
    
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
    // Bucket 0 is for closest key. Bucket (Node.keySize - 1) for farthest.
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
  splitBucket(bucketIndex) { // Split a bucket into multiple smaller buckets
    const bucket = this.routingTable.get(bucketIndex);
    if (!bucket) return;
    this.routingTable.delete(bucketIndex);
    // Re-add all contacts, which will place them in new buckets
    const add = contact => this.addToRoutingTable(contact);
    bucket.contacts.forEach(add);
    bucket.replacementCache.forEach(add);
  }
  setupContact(contact, bucketIndex) { // Contact may be info, shared with another Node, or from a different bucket. Make/adjust as needed.
    if (contact.host !== this) contact = contact.constructor.fromNode(contact.node, this);
    contact.bucketIndex = bucketIndex;
    return contact;
  }
  addToRoutingTable(contact) { // Return true and contact to the routing table if room, using adaptive bucket sizing.
    const key = contact.key;
    if (key === this.key) return false; // Don't add self

    const bucketIndex = this.getBucketIndex(key);
    
    // Get or create bucket
    if (!this.routingTable.has(bucketIndex)) {
      this.routingTable.set(bucketIndex, new KBucket());
    }
    const bucket = this.routingTable.get(bucketIndex);
    
    // Try to add to bucket
    contact = this.setupContact(contact, bucketIndex);
    if (bucket.addContact(contact)) return true;
    
    // Bucket is full - handle adaptive splitting for unbalanced trees
    // Split only if this bucket contains keys that should be in our routing table
    if (bucketIndex >= 0 && this.canSplitBucket(bucketIndex)) {
      this.splitBucket(bucketIndex);
      // Try adding again after split
      return this.addToRoutingTable(contact);
    }

    const replacements = bucket.replacementCache; // TODO? (in-order) dictionary instead of list?
    if (!replacements.find(contact => contact.key === key)) replacements.push(contact);
    return false;
  }
  // Storage
  storage = {};
  storeLocally(key, value) { // Store in memory by a BigInt key (must be already hashed). Not persistent.
    this.storage[key] = value;
  }
  retrieveLocally(key) {     // Retrieve from memory.
    return this.storage[key];
  }
  // TODO: also store/retrievePersistent locally.

  /* Active operations involving messages to other Nodes. */
  locateNodes(targetKey) { // Promise up to k best Contacts for targetKey (sorted closest first).
    // Side effect is to discover other nodes (and they us).
    return this.iterate(targetKey, 'sendFindNodes');
  }
  async ensureKey(targetKey) {
    if (typeof(targetKey) !== 'bigint') targetKey = await this.constructor.key(targetKey);
    return targetKey;
  }
  async locateValue(targetKey) { // Promise value stored for targetKey, or undefined.
    // Side effect is to discover other nodes (and they us).
    targetKey = await this.ensureKey(targetKey);
    const found = this.retrieveLocally(targetKey);
    if (found !== undefined) return found;
    // TODO: We need to store at the closests node to the key that did NOT return a value.
    // Maybe have iterate track these and stuff them into another property of the {value} object?
    // But doesn't that get thrown immediately and thus there might be a closer one that might fail?
    // And what does not returning the stored value mean? Returning [] indicating none closesr?
    return this.iterate(targetKey, 'sendFindValue') // Throws {value} if found.
      .then(ignoredEntries => ignoredEntries, ({value}) => value);
  }
  async storeValue(targetKey, value) { // Convert targetKey to a bigint if necessary, and store value there.
    targetKey = await this.ensureKey(targetKey);
    const helpers = await this.locateNodes(targetKey);
    await Promise.all(helpers.map(helper => helper.contact.sendStore(this.contact, targetKey, value)));
  }
  async step1(targetKey, finder, helper, keysSeen) {
    // Get up to k previously unseen Helpers from helper, adding results to keysSeen.
    keysSeen.add(helper.key);
    const helpers = await helper.contact[finder](this.contact, targetKey);
    // If it responds at all (no timeout) then it is live.
    if (helpers.length) this.addToRoutingTable(helper.contact); 
    const better = helpers.filter(helper => !keysSeen.has(helper.key) && keysSeen.add(helper.key));
    return better;
  }
    
  async iterate(targetKey, finder) { // Promise the best Contacts known by anyone in the network,
    // sorted by closest-first, by repeatedly trying to improve our closest known by applying
    // finder. If the finder operation rejects (as 'sendFindValue' does), so will we.
    let candidates = this.findClosestHelpers(targetKey);
    const keysSeen = new Set();
    while (candidates.length) {
      // TODO: try with alpha first, and then go to k if needed.
      let helpers = candidates.slice(0, this.constructor.k);
      let requests = helpers.map(helper => this.step1(targetKey, finder, helper, keysSeen));
      let closer = [].concat(... await Promise.all(requests)); // By construction, these are closer than the ones we tried.
      //function frob(helpers) { return helpers.map(h => h.name); }
      //this.log({candidates: frob(candidates), helpers: frob(helpers), closer: frob(closer)});
      // TODO: return list of Contacts, not Helpers.
      if (!closer.length) return candidates.slice(0, this.constructor.k);;
      candidates = [...closer, ...candidates].sort(Helper.compare);
    }
    //fixme remove return [new Helper(this.contact, this.constructor.distance(this.key, targetKey))];
    throw new Error('Unable to find any candidates. This should not happen.');
  }    
  async refresh(bucketIndex) { // Refresh specified bucket using LocateNodes for a random key in the specified bucket's range.
    const found = await this.locateNodes(this.randomTargetInBucket(bucketIndex));
    //console.log(`refresh bucket ${bucketIndex} found ${found.length} items.`);
  }
  async join(contact) {
    this.addToRoutingTable(contact);
    await this.locateNodes(this.key); // Discovers between us and otherNode.
    // Refresh every bucket farther out than our closest neighbor.
    let started = false;
    //console.log(`\n\nNode ${this.name} joining ${contact.name}.`);
    for (let index = 0; index < this.constructor.keySize; index++) {
      const bucket = this.routingTable.get(index);
      if (!bucket && !started) continue;
      if (!started) started = true;
      else if (!bucket) await this.refresh(index);
    }
    // TODO: Every refreshMS, refresh every bucket that has not had a lookup since last time.
  }
}
