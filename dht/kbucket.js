const { BigInt } = globalThis; // For linters.

// Bucket in a RoutingTable: a list of up to k Contacts as enforced by addContact().
export class KBucket {  
  constructor(node, index) {
    this.node = node;
    this.index = index;

    // Cache the binary prefix used in randomTarget.
    const keySize = node.constructor.keySize;
    const nLeadingZeros = keySize - 1 - this.index;
    // The next bit after the leading zeros must be one to stay in this bucket.
    this.binaryPrefix = '0b' + '0'.repeat(nLeadingZeros) + '1';
  }

  contacts = [];
  get length() { // How many do we have (not capacity, which is k.)
    return this.contacts.length;
  } 
  get isFull() {  // Are we at capacity?
    return this.length >= this.node.constructor.k;
  }
  get nTransports() { // How many of our contacts have their own transport connection?
    return this.contacts.reduce((accumulator, contact) => contact.hasTransport ? accumulator + 1 : accumulator, 0);
  }
  get randomTarget() { // Return a key for which this.getBucketIndex will be the given bucketIndex.
    const nodeClass = this.node.constructor;
    const keySize = nodeClass.keySize;
    let binary = this.binaryPrefix;
    // Now fill the rest (if any) with random bits. -2 for the '0b' prefix.
    for (let i = binary.length - 2; i < keySize; i++) binary += Math.round(Math.random());
    const distance = BigInt(binary);
    // Quirk of xor distance that it works backwards like this.
    const target = nodeClass.distance(distance, this.node.key);
    return target;
  }
  async refresh() { // Refresh specified bucket using LocateNodes for a random key in the specified bucket's range.
    const targetKey = this.randomTarget;
    await this.node.locateNodes(targetKey); // Side-effect is to update this bucket.
  }

  removeKey(key) { // Removes item specified by key (if present) from bucket and return 'present' if it was, else false.
    const { contacts } = this;
    let index = contacts.findIndex(item => item.key === key);
    if (index !== -1) {
      contacts.splice(index, 1);
      return 'present';
    }
    return false;
  }

  async addContact(contact) { // Returns 'present' or 'added' if it was added to end within capacity, else false.
    // Resets refresh timer.
    this.node.constructor.assert(contact.node.key !== this.node.key, 'attempt to add self contact to bucket');
    let added = this.removeKey(contact.key) || 'added';
    if (this.isFull) {
      const head = this.contacts[0];
      if (await head.sendCatchingRpc('ping', head.key)) { // still alive
	added = false;  // New contact will not be added.
	contact = head; // Add head back and update timestamp, below.
      } 
      // In either case (whether re-adding head to tail, or making room from a dead head), remove head now.
      // Don't remove before waiting for the ping, as there can be overlap with other activity that could
      // think there's room and thus add it twice.
      this.removeKey(head.key);
    }
    this.contacts.push(contact);
    // Refresh this bucket unless we addContact again before it goes off.
    clearInterval(this.refreshTimer);
    this.refreshTimer = this.node.repeat(() => this.refresh(this.index), 'bucket');
    return added;
  }
}
