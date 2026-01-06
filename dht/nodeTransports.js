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
  static maxTransports = 62; // FIXME: try 124
  noteContactForTransport(contact) { // We're about to use this contact for a message, so keep track of it.
    // Requires: if we later addToRoutingTable successfully, it should be removed from looseTransports.
    // Requires: if we later remove contact because of a failed send, it should be removed from looseTransports.
    const assert = this.constructor.assert;
    assert(contact.key !== this.key, 'noting contact for self transport', this, contact);
    assert(contact.host.key === this.key, 'Contact', contact.report, 'is not hosted by', this.contact.report);
    let existing = this.findContactByKey(contact.key);
    if (existing) return existing;
    
    if (this.nTransports >= this.constructor.maxTransports) { // Determine if we have to drop one first, and do so.
      //console.log(this.name, 'needs to drop a transport');
      function removeLast(list) { // Remove and return the last element of list that has connction and is NOT sponsor.
	const index = list.findLastIndex(element => element.connection && !contact.hasSponsor(element.key));
	if (index < 0) return null;
	const sub = list.splice(index, 1);
	return sub[0];
      }
      let dropped = removeLast(this.looseTransports);
      if (dropped) {
	//console.log(this.name, 'dropping loose transport', dropped.name);
      } else { // Find the bucket with the most connections.
	let bestBucket = null, bestCount = 0;
	this.forEachBucket(bucket => {
	  const count = bucket.nTransports;
	  if (count < bestCount) return true;
	  bestBucket = bucket;
	  bestCount = count;
	  return true;
	});
	dropped = removeLast(bestBucket.contacts);
	if (!dropped) console.log('Unable to find something to drop in', this.report(null));
	//else console.log(this.name, 'dropping transport', dropped.name, 'in', bestBucket.index, 'among', bestCount);
      }
      dropped.disconnectTransport();
    }

    this.looseTransports.push(contact); // Now add it as loose. If we later addToRoutingTable, it will then be moved from looseTransports.
    return contact;
  }
}
