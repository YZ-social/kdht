import { NodeStorage } from './nodeStorage.js';

// Management of Contacts that have a limited number of connections that can transport messages.
export class NodeTransports extends NodeStorage {
  looseTransports = [];
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
  static maxTransports = Infinity; //fixme 95;
  // FIXME: this is a mess. (And not used just yet.)
  noteContactForTransport(contact) { // We're about to use this contact for a message, so keep track of it.
    // Returns the existing contact, if any, else a clone of contact for this node.
    // Requires: if we later addToRoutingTable successfully, it should be removed from looseTransports.
    // Requires: if we later remove contact because of a failed send, it should be removed from looseTransports.
    const assert = this.constructor.assert;
    assert(contact.key !== this.key, 'noting contact for self transport', this, contact);
    const key = contact.key;
    const sponsor = contact.sponsor;
    let existing = this.findContact(contact.key);
    if (existing) {
      existing.sponsor ||= sponsor;
      return existing;
    }
    
    if (this.nTransports >= this.constructor.maxTransports) {
      function removeLast(list) { // Remove and return the last element of list that hasTransport and is NOT sponsor.
	const index = list.findLastIndex(element => element.hasTransport && element.key !== sponsor?.key);
	if (index < 0) return null;
	const sub = list.splice(index, 1);
	return sub[0];
      }
      let dropped = removeLast(this.looseTransports);
      if (dropped) {
	console.log('dropping loose transport', dropped.name, 'in', this.name);
      } else { // Find the bucket with the most connections.
	let bestBucket = null, bestCount = 0;
	this.forEachBucket(bucket => {
	  const count = bucket.nTransports;
	  if (count <= bestCount) return true;
	  bestBucket = bucket;
	  bestCount = count;
	  return true;
	});
	dropped = removeLast(bestBucket.contacts);
	console.log('dropping transport in contact', dropped.name, 'in', this.name, bestBucket.index, 'among', bestCount);
      }
      const farContactForUs = dropped.hasTransport;
      assert(farContactForUs.key === this.key, 'Far contact for us does not point to us.');
      assert(farContactForUs.host.key === dropped.key, 'Far contact for us does is not hosted at contact.');
      farContactForUs.hasTransport = null;
      dropped.hasTransport = null;
    }

    const cloned = contact.clone(this, null);
    cloned.sponsor ||= sponsor;
    this.looseTransports.push(cloned);
    return cloned;
  }
}
