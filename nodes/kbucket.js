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
    this.resetRefresh();
  }

  contacts = [];
  get length() { // How many do we have (not capacity, which is k.)
    return this.contacts.length;
  } 
  get isFull() {  // Are we at capacity?
    return this.length >= this.node.constructor.k;
  }
  get nTransports() { // How many of our contacts have their own transport connection?
    return this.contacts.reduce((accumulator, contact) => contact.connection ? accumulator + 1 : accumulator, 0);
  }
  get randomTarget() { // Return a key for which this.getBucketIndex will be the given bucketIndex.
    const nodeClass = this.node.constructor;
    const keySize = nodeClass.keySize;
    let binary = this.binaryPrefix;
    // Now fill the rest (if any) with random bits. -2 for the '0b' prefix.
    for (let i = binary.length - 2; i < keySize; i++) binary += Math.round(Math.random());
    const distance = BigInt(binary);
    // Quirk of xor distance that it works backwards like this.
    return this.node.distance(distance);
  }
  async refresh() { // Refresh specified bucket using LocateNodes for a random key in the specified bucket's range.
    if (this.node.isStopped() || !this.contacts.length) return false; // fixme skip isStopped?
    const targetKey = this.randomTarget;
    await this.node.locateNodes(targetKey); // Side-effect is to update this bucket.
    return true;
  }
  resetRefresh(now = false) { // We are organically performing a lookup in this bucket. Reset the timer.
    // clearInterval(this.refreshTimer);
    // this.refreshTimer = this.node.repeat(() => this.refresh(), 'bucket');
    this.node.schedule(this.index, 'bucket', () => this.refresh(), now ? 1 : undefined); // Not zero.
  }

  removeKey(key, deleteIfEmpty = true) { // Removes item specified by key (if present) from bucket and return 'present' if it was, else false.
    const { contacts } = this;
    let index = contacts.findIndex(item => item.key === key);
    if (index !== -1) {
      contacts.splice(index, 1);
      // Subtle: ensures that if contact is later added, it will resetRefresh.
      if (deleteIfEmpty && !contacts.length) this.node.routingTable.delete(this.index);
      return 'present';
    }
    return false;
  }

  addContact(contact) { // Returns 'present' or 'added' if it was added to end within capacity, else false.
    // Resets refresh timer.
    this.node.constructor.assert(contact.node.key !== this.node.key, 'attempt to add self contact to bucket');
    let added = this.removeKey(contact.key, false) || 'added';
    //this.node.log('addContact', contact.name, this.index, added, this.isFull ? 'full' : '');
    if (this.isFull) {
      if (added === 'present') this.node.looseTransports.push(contact); // So no findContact will fail during ping. Should we instead serialize findContact?
      const head = this.contacts[0];
      if (head.connection) { // still alive
	added = false;  // New contact will not be added.
	contact = head; // Add head back, below.
      }
      if (added === 'present') this.node.removeLooseTransport(contact.key);
      // In either case (whether re-adding head to tail, or making room from a dead head), remove head now.
      // Subtle: Don't remove before waiting for the ping, as there can be overlap with other activity that could
      // think there's room and thus add it twice.
      this.removeKey(head.key);
    }
    this.contacts.push(contact);
    return added;
  }
}
