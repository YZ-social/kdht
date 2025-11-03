const { BigInt, TextEncoder, crypto } = globalThis; // For linters.

// See spec/*.js for API examples.

/*
  A Node is an actor in the DHT, and it has a key:
  - A typical client will have one Node instance through which it interacts with one DHT.
  - A server or simulation might have many Node instances to interact with the same DHT.
  A Node has a Connection object to represent itself.
  A Node maintains KBuckets, which each have a list of Connections to other Nodes.

  A Connection is the means through which a Node interacts with another Node instance:
  - When send an RPC request, the Connection will "serialize" the sender Nodes's connection.
  - When receiving an RPC response, the sender "deserializes" a string (maybe using a cache) to produce the Connection instance for the KBuckets.
  - In classic UDP Kademlia, a Connection would serialize as {ip, port}.
  - In a simulation, a Connection could "serialize" as just itself.
  
 */
  

export class KBucket {  // Bucket in a RoutingTable: a list of up to k Node keys, plus a lastUpdated timestamp, as enforced by addKey().
  static k = 20; // System constant.

  keys = [];
  get length() { return this.keys.length; } // How many do we have (not capacity, which is k.)
  get isFull() { return this.length >= this.constructor.k; } // Are we at capacity?

  addKey(key) { // Returns true if it was added to end within capacity, and timestamp updated. (Existing is moreved to end.)
    const exists = this.removeKey(key);
    if (this.isFull) return false; // FIXME: before returning, we should remove head of bucket (and add key) if it doesn't respond to a ping.
    this.keys.push(key);
    this.lastUpdated = Date.now();
    return true;
  }

  removeKey(key) { // Return true if it was there and removed.
    const index = this.keys.findIndex(item => item === key);
    if (index !== -1) {
      this.keys.splice(index, 1);
      return true;
    }
    return false;
  }
  replacementCache = [];
}

export class Node { // An actor within thin DHT.
  static alpha = 3;
  // TODDO: Let's make this as small as possible without flooding network. How do we determine that?
  static republishMS = 15e3; // Original paper for desktop filesharing was 60 minutes.
  // TODO: Original k=20 was chosen based on Gnutella desktop data. How do we figure out ours?
  static k = 20; // Chosen so that for any k nodes, it is highly likely that at least one is still up after republishMS.
  static keySize = 128; // Number of bits in a key. Must be multiple of 8 and <= sha256.
  constructor(properties) { Object.assign(this, properties); }

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
  get keys() { // Answer a fresh copy of all keys.
    const allKeys = [];
    for (const bucket of this.routingTable.values()) {
      allKeys.push(...bucket.keys);
    }
    return allKeys;
  }
  report(logger = console.log) { // return logger( a string description of node )
    let report = `Node: ${this.name}`;
    function keysString(keys) { return keys.map(key => key.toString() + 'n').join(', '); }
    for (let index = 0; index < Node.keySize; index++) {
      const bucket = this.routingTable.get(index);
      if (!bucket) continue;
      report += `\n  ${index}: ` + keysString(bucket.keys);
      const replacements = bucket.replacementCache;
      if (!replacements.length) continue;
      report += ' replacements: ' + keysString(replacements);
    }
    return logger(report);
  }
  static compare = (a, b) => { // Sort expects a number, so bigIntA - bigIntB won't do.
    if (a.distance < b.distance) return -1;
    if (a.distance > b.distance) return 1;
    return 0;
  }
  // FIXME: answer Contacts
  findClosestNodes(target, count = KBucket.k) { // Answer count closest {contact, distance} to target.
    const allKeys = this.keys;
    const keysWithDistance = allKeys.map(key => ({
      contact: key,
      distance: Node.distance(target, key)
    }));
    keysWithDistance.sort(this.constructor.compare);
    return keysWithDistance.slice(0, count);
  }
  findClosestKeys(target, count = KBucket.k) { // Answer count closest keys to target.
    return this.findClosestNodes(target, count).map(item => item.contact);
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
    // Bucket 0 is for closest key, 127 for farthest.
    const distance = this.constructor.distance(this.key, key);
    const prefixLength = this.constructor.commonPrefixLength(distance);
    return 128 - prefixLength - 1;
  }
  // Discovery
  canSplitBucket(bucketIndex) { // True if adaptive routing bucket can be split.
    // A bucket can only be split if it's in the range of our own node ID's prefix
    // This handles unbalanced trees by only splitting buckets we care about
    const bucket = this.routingTable.get(bucketIndex);
    if (!bucket || !bucket.isFull) return false;
    
    // Check if any keys in the bucket would remain after split
    const subBuckets = new Map();
    for (const key of bucket.keys) {
      const newIndex = this.getBucketIndex(key);
      if (newIndex !== bucketIndex) {
        if (!subBuckets.has(newIndex)) {
          subBuckets.set(newIndex, []);
        }
        subBuckets.get(newIndex).push(key);
      }
    }
    
    // Can split if keys would be distributed to different buckets
    return subBuckets.size > 0;
  }
  splitBucket(bucketIndex) { // Split a bucket into multiple smaller buckets
    const bucket = this.routingTable.get(bucketIndex);
    if (!bucket) return;
    this.routingTable.delete(bucketIndex);
    // Re-add all keys, which will place them in new buckets
    for (const key of bucket.keys) {
      this.addToRoutingTable(key);
    }
    for (const key of bucket.replacementCache) {
      this.addToRoutingTable(key);
    }
  }
  addToRoutingTable(key) { // Return true and key to the routing table if room, using adaptive bucket sizing.
    if (key === this.key) return false; // Don't add self

    const bucketIndex = this.getBucketIndex(key);
    
    // Get or create bucket
    if (!this.routingTable.has(bucketIndex)) {
      this.routingTable.set(bucketIndex, new KBucket());
    }
    const bucket = this.routingTable.get(bucketIndex);
    
    // Try to add to bucket
    if (bucket.addKey(key)) return true;
    
    // Bucket is full - handle adaptive splitting for unbalanced trees
    // Split only if this bucket contains keys that should be in our routing table
    if (bucketIndex >= 0 && this.canSplitBucket(bucketIndex)) {
      this.splitBucket(bucketIndex);
      // Try adding again after split
      return this.addToRoutingTable(key);
    }

    const replacements = bucket.replacementCache; // TODO? (in-order) dictionary instead of list?
    if (!replacements.includes(key)) replacements.push(key);
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
  locateNode(targetKey) { // Promise up to k best entries for targetKey (sorted closest first).
    if (targetKey === this.key) return this.connection;
    // Side effect is to discover other nodes (and they us).
    return this.iterate(targetKey, 'sendFindNodes');
  }
  async locateValue(targetKey) { // Promise value stored for targetKey, or undefined.
    // Side effect is to discover other nodes (and they us).
    const found = this.retrieveLocally(targetKey);
    if (found !== undefined) return found;
    return this.iterate(targetKey, 'sendFindValue') // Throws {value} if found.
      .then(ignoredEntries => undefined, ({value}) => value);
  }
  refresh() { // Refresh the buckets at the farthest distance from us
    // e.g., us: 101100
    // target:   010011 // Made up to produce maximum distance
    // xor:      111111
    //FIXME: see last key spec. Bring truncating op into here and use it.
    this.locationNode(~this.key); // Side effect discovers along the way.
  }
  static join(otherNode) {
    this.discover(otherNode);
    this.locateNode(otherNode.key); // Discovers between us and otherNode.
    this.refresh();
  }
}
