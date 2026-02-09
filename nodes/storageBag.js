// A StorageBag instance is the in-memory storage for a specific DHT key.
//
// The DHT replicates this instance among the closest nodes to the key.
// The DHT does this by determining the appropriate Contacts (via locateNodes)
// and sending the store(key, storageBag) RPC to each of those Contacts.
// Sending the RPC will involve JSON.stringify(storageBag) for transport on the wire.
//
// (An application might produce this key as a hash of some string - perhaps a
// string of multiple parts such as "scope:event". Or it might be a key of multiple
// parts so as to be located within a region of the DHT address space.)
//
// Each storageBag may have several values added (or cancelled) at different times.
// We refer to each item in a storageBag collection as a storageItem.
// At any given moment, a storing nodes's copy of the storageBag might have an
// incomplete picture of all the storageItems, and thus the receiving node merges
// the new bag item-by-item with any existing items.
// Each item can be created by the application with three properties that
// go along with the item payload: type, subject, and issuedTime.
// - Different types can have different merge rules. E.g., corresponding to
//   mutable vs immutable, or by smart contract, etc.
//   A single bag might have items of multiple types that appear togther in the same
//   storageBag, such as published messages and subscriptions.
// - Each storageItem is individually expired, based on when it was created
//   and the expiration time for that type of storageItem.
// - A storageItem's expiration can be extended for the same or for a different
//   payload, by specifying a new issuedTime or a new payload on the same subject.
//   The subject can be specified so that we know which item to moddify. 
//   The subject defaults to be the same as the payload, but applications might
//   use a per-user or per-message GUID.

export class StorageBag {

  types = {}; // {[type]: {[subject]: storageItem, ...}, ...}
  items = null; // caches [{type, subject, issuedTime, payload}, ...]

  // Recall that toJSON() does not return a string, but rather a replacement object to be further stringified.
  toJSON() { // Answer [ pojo, ...], where each pojo are the properties of a StorageItem
    if (this.items) return this.items;
    let list = this.items = [];
    Object.values(this.types).forEach(typeStorageItems => 
      Object.values(typeStorageItems).forEach(storageItem => storageItem.isCancelled || list.push(storageItem.toJSON())));
    return list;
  }
  toString() {
    const rawSubjects = Object.values(this.types.raw || this.types.pub || {});
    if (!rawSubjects) return undefined;
    if (rawSubjects.length === 1) return JSON.stringify(rawSubjects[0].payload);
    return super.toString();
  }
  merge(storageItems, node, key) { // Add each allowed storageItem of serialized to the organized types if allowed, including any side-effects.
    // Returns merged storageBag.
    const now = Date.now();
    for (const storageItem of storageItems) {
      const proposed = StorageItem.create({now, ...storageItem});
      if (!proposed.merge1(now, this, node, key)) this.items = null;
    }
    return this;
  }
  delete(node, key, type, subject) { // Delete this.types[type][subject], and any empty parents through node.storage.
    const subjects = this.types[type];
    delete subjects[subject];
    if (Object.keys(subjects).length) return;
    delete this.types[type];
    if (!node || Object.keys(this.types).length) return;
    node.storage.delete(key);
  }
}

// Example merge rules:
// Don't allow times in the future.
// Require signature issuer to match existing. (When we have JWS storageItems)
// Require subject to match hash of payload (or default it).
// Keep only the newest of a subject.
// Keep only the oldest of a subject.
// Keep all unexpired of a subject.

export class StorageItem {
  constructor({payload, subject = payload.toString(), now, issuedTime = now, type = this.constructor.type, expiration = Infinity, ...rest}) {
    // TODO: accept and cache a JWS and have getters that extract these same three parts.
    expiration = Math.min(expiration, this.constructor.expiration);
    Object.assign(this, {subject, issuedTime, payload, type, expiration, ...rest});
  }
  static type = 'raw';
  static expiration = 5 * 60e3; // five minutes for development
  // Applications can extend the set of recognized types, although there is not YET a mechanism for nodes to dynamically load defs on-demand.
  static storageItems = {}; // Maps type => class
  static register() { // Add to storageItems.
    this.storageItems[this.type] = this;
  }
  static create(storageItemProperties) {
    const kind = StorageItem.storageItems[storageItemProperties.type || 'raw'];
    return new kind(storageItemProperties);
  }
  get isCancelled() {
    // Note: There can be type-specific "removed" markers, but we don't actually delete those,
    // because a merge would add them back.
    return this.payload === null;
  }
  toJSON() {
    if (this.isCancelled) return undefined;
    const {type, subject, issuedTime, payload} = this;
    return {type, subject, issuedTime, payload};
  }
  merge1(now, bag, node, key) { // Add this into subjects if allowed and return this, else null.

    const {type, subject, payload, issuedTime, expiration, debug} = this;
    let {issuedTime:existingTime = 0, timer} = bag.types[type]?.[subject] || {};

    const allowed = this.allowedTime(existingTime, now, issuedTime);
    if (debug) console.log('merging', {type, subject, existingTime, issuedTime, now, expiration,
				       staticExpiration: this.constructor.expiration,
				       isFuture: issuedTime > now, isEarlier: issuedTime <= existingTime, allowed, self:this});
    if (!allowed) return null;
        
    const timeout = issuedTime + expiration - now;
    clearTimeout(timer);
    this.timer = timeout < Infinity && setTimeout(() => this.delete(bag, node, key, type, subject), timeout);

    const subjects = bag.types[type] ||= {};
    subjects[subject] = this;
    return this;
  }
  allowedTime(existingTime, now, issuedTime) { // Keep only the latest unexpired
    if (issuedTime > now) return false; // Cannot stake out the future. TODO: allow some clock skew.
    if (issuedTime <= existingTime) return false;
    return true;
  }
  delete(bag, node, key, type, subject) {
    bag.delete(node, key, type, subject);
  }
}
StorageItem.register();


