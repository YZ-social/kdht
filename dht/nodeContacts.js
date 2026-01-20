import { NodeTransports } from './nodeTransports.js';
import { Helper } from './helper.js';
import { KBucket } from './kbucket.js';
const { BigInt } = globalThis; // For linters.

// Management of Contacts (but see nodeTransports, too)
export class NodeContacts extends NodeTransports {
  static k = 20; // Chosen so that for any k nodes, it is highly likely that at least one is still up after refreshTimeIntervalMS.
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
  routingTable = new Map(); // Maps bit prefix length to KBucket
  getBucketIndex(key) { // index of routingTable KBucket that should contain the given Node key.
    // We define bucket 0 for the closest distance, and bucket (keySize - 1) for the farthest,
    // as in the original paper. Note that some implementation and papers number these in the reverse order.
    // Significantly, Wikipedia numbers these in the reverse order, AND it implies that the buckets
    // represent addresses, when in fact they represent a distance from current node's address.
    const distance = this.distance(key);
    const prefixLength = this.constructor.commonPrefixLength(distance);
    return 128 - prefixLength - 1;
  }
  ensureBucket(index) { // Return bucket at index, creating it if necessary.
    const routingTable = this.routingTable;
    let bucket = routingTable.get(index);
    if (!bucket) {
      bucket = new KBucket(this, index);
      routingTable.set(index, bucket);
    }
    return bucket;
  }
  forEachBucket(iterator, reverse = false) { // Call iterator(bucket) on each non-empty bucket, stopping as soon as iterator(bucket) returns falsy.
    let buckets = this.routingTable.values();
    if (reverse) buckets = buckets.reverse();
    for (const bucket of buckets) {
      if (bucket && !iterator(bucket)) return;
    }
  }
  get contacts() { // Answer a fresh copy of all contacts for this Node.
    const contacts = [];
    this.forEachBucket(bucket => {
      contacts.push(...bucket.contacts);
      return true;  // Subtle: an empty bucket will return 0 from push(), which will stop iteration and miss later buckets.
    });
    return contacts;
  }
  contactDictionary = {}; // maps name => contact for lifetime of Node instance until removeContact.
  existingContact(name) { // Returns contact with the given name for this node, without searching buckets or looseTransports.
    return this.contactDictionary[name];
  }
  addExistingContact(contact) { // Adds to set of contactDictionary.
    this.contactDictionary[contact.name] = contact;
  }
  findContact(match) { // Answer the contact for which match predicate is true, if any, whether in buckets or looseTransports. Does not remove it.
    let contact = this.looseTransports.find(match);
    if (contact) return contact;
    this.forEachBucket(bucket => !(contact = bucket.contacts.find(match))); // Or we could compute index and look just there.
    return contact;
  }
  findContactByKey(key) { // findContact matching the specified key. To be found, contact must be in routingTable or looseTransports (which is different from existingContact()).
    return this.findContact(contact => contact.key === key);
  }
  ensureContact(contact, sponsor) { // Return existing contact, if any (including looseTransports), else clone a new one for this host. Set sponsor.
    // I.e., a Contact with node: contact.node and host: this.
    // Subtle: Contact clone uses existingContact (above) to reuse an existing contact on the host, if possible.
    // This is vital for bookkeeping through connections and sponsorship.
    contact = contact.clone(this);
    if (sponsor) contact.noteSponsor(sponsor);
    return contact;
  }
  routingTableSerializer = Promise.resolve();
  queueRoutingTableChange(thunk) { // Promise to resolve thunk() -- after all previous queued thunks have resolved.
    return this.routingTableSerializer = this.routingTableSerializer.then(thunk);
  }
  removeContact(contact) { // Removes from node entirely if present, from looseTransports or bucket as necessary, returning bucket if that's where it was, else null.
    return this.queueRoutingTableChange(() => {
      delete this.contactDictionary[contact.name];
      const key = contact.key;
      if (this.removeLooseTransport(key)) return null;
      const bucketIndex = this.getBucketIndex(key);
      const bucket = this.routingTable.get(bucketIndex);
      // Host might not yet have added node or anyone else as contact for that bucket yet, so maybe no bucket.
      return bucket?.removeKey(key) ? bucket : null;
    });
  }
  addToRoutingTable(contact) { // Promise contact, and add it to the routing table if room.
    if (contact.key === this.key) return null; // Do not add self.

    // In most cases there should be a connection, but it sometimes happens that by the time we get here,
    // we have already dropped the connection.
    //this.constructor.assert(contact.connection, 'Adding contact without connection', contact.report, 'in', this.contact.report);

    return this.queueRoutingTableChange(async () => {
      const bucketIndex = this.getBucketIndex(contact.key);
      const bucket = this.ensureBucket(bucketIndex);

      // Try to add to bucket
      const added = await bucket.addContact(contact);
      if (added !== 'present') { // Not already tracked in bucket.
	this.removeLooseTransport(contact.key); // Can't be in two places.
	this.queueWork(() => this.replicateCloserStorage(contact));
      }
      return added;
    });
  }
  findClosestHelpers(targetKey, count = this.constructor.k) { // Answer count closest Helpers to targetKey, including ourself.
    if (!this.contact) return []; // Can happen while we are shutting down during a probe.
    const contacts = this.contacts; // Always a fresh copy.
    contacts.push(this.contact); // We are a candidate, too! TODO: Handle this separately in iterate so that we don't have to marshal our contacts.
    return Helper.findClosest(targetKey, contacts, count);
  }
}
