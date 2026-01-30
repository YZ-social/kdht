import { NodeStorage } from './nodeStorage.js';
import { WebRTC } from '@yz-social/webrtc';

// Management of Contacts that have a limited number of connections that can transport messages.
export class NodeTransports extends NodeStorage {
  looseContacts = [];
  get nConnections() {
    let count = this.looseContacts.length;
    this.forEachBucket(bucket => (count += bucket.nConnections, true));
    return count;
  }
  removeLooseContact(key) { // Remove the contact for key from looseContacts, and return boolean indicating whether it had been present.
    const looseIndex = this.looseContacts.findIndex(c => c.key === key);
    if (looseIndex >= 0) {
      this.looseContacts.splice(looseIndex, 1);
      return true;
    }
    return false;
  }
  static maxTransports = WebRTC.suggestedInstancesLimit;
  noteContactForTransport(contact) { // We're about to use this contact for a message, so keep track of it.
    // Requires: if we later addToRoutingTable successfully, it should be removed from looseContacts.
    // Requires: if we later remove contact because of a failed send, it should be removed from looseContacts.
    const assert = this.constructor.assert;
    assert(contact.key !== this.key, 'noting contact for self transport', this, contact);
    assert(contact.host.key === this.key, 'Contact', contact.report, 'is not hosted by', this.contact.report);
    let existing = this.findContactByKey(contact.key);
    if (existing) return existing;
    
    if (this.nConnections >= this.constructor.maxTransports) { // Determine if we have to drop one first, and do so.
      //console.log(this.name, 'needs to drop a transport');
      function removeLast(list) { // Remove and return the last element of list that has connection and is NOT sponsor.
	// I have observed cases where a bunch of nodes run over as someone joins, and they all then try to remove the same
	// most-recently added contact. So here instead of taking the last valid contact from the last, we take the last but [0..3].
	let randomizer = Math.floor(Math.random() * 4);
	const index = list.findLastIndex(element => element.connection && !contact.hasSponsor(element.key) && randomizer-- <= 0 );
	if (index < 0) return null;
	const sub = list.splice(index, 1);
	return sub[0];
      }
      let dropped = removeLast(this.looseContacts);
      if (dropped) {
	this.xlog('dropping loose transport', dropped.name);
      } else { // Find the bucket with the most connections.
	let bestBucket = null, bestCount = 0;
	this.forEachBucket(bucket => {
	  const count = bucket.nConnections;
	  if (count < bestCount) return true;
	  bestBucket = bucket;
	  bestCount = count;
	  return true;
	});
	dropped = removeLast(bestBucket.contacts);
	if (!dropped) this.xlog('Unable to find something to drop in', this.report(null));
	else this.xlog('dropping transport', dropped.name, 'in bucket', bestBucket.index, 'among', bestCount, 'contacts.');
      }
      dropped.disconnectTransport();
    }

    this.looseContacts.push(contact); // Now add it as loose. If we later addToRoutingTable, it will then be moved from looseContacts.
    return contact;
  }
}
