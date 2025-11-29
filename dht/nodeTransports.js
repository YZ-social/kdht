import { NodeRefresh } from './nodeRefresh.js';
import { Node } from './node.js';

// Management of Contacts that have a limited number of connections that can transport messages.
export class NodeTransports extends NodeRefresh {
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
}
