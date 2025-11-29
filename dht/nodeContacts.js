import { NodeRefresh } from './nodeRefresh.js';
import { Helper } from './helper.js';
import { KBucket } from './kbucket.js';
const { BigInt } = globalThis; // For linters.

// Management of Contacts (but see nodeTransports, too)
export class NodeContacts extends NodeRefresh {
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
    const distance = this.constructor.distance(this.key, key);
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
    this.forEachBucket(bucket => contacts.push(...bucket.contacts));
    return contacts;
  }
  findClosestHelpers(targetKey, count = this.constructor.k) { // Answer count closest Helpers to targetKey, including ourself.
    const contacts = this.contacts; // Always a fresh copy.
    contacts.push(this.contact); // We are a candidate, too!
    return Helper.findClosest(targetKey, contacts, count);
  }
}
