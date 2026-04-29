import { NodeRefresh } from './nodeRefresh.js';
import { StorageBag } from './storageBag.js';

// Keeping application data.
export class NodeStorage extends NodeRefresh {
  storage = new Map(); // keys must be preserved as bigint, not converted to string.
  clearStorageExpirations() {
    this.storage.values().forEach(bag => bag.clearStorageExpirations());
  }
  // TODO: store across sessions

  // These two accept and produce a list of StorageItems.
  storeLocally(key, value) { // Store in memory by a BigInt key (must be already hashed). Not persistent.
    let existingValue = this.storage.get(key);
    value = StorageBag.ensureItems(value);
    value = (existingValue ||= new StorageBag()).merge(value, this, key);

    if (!Object.keys(value).length) { // Empty bag after merging.
      this.storage.delete(key);
      return;
    }

    this.storage.set(key, value);
    if (this.constructor.diagnosticTrace) {
      this.log(`storeLocally(${key}, ${value}) - ${existingValue ? 'updated' : 'NEW'}`);
    }
    // TODO: The paper says this can be optimized.
    // Claude.ai suggests just writing to the next in line, but that doesn't work.
    this.schedule(key, 'storage', () => {
      const found = this.storage.get(key);
      if (found === undefined) {
	this.log('undefined (expired?) value for refresh, was', value);
	return; // expired
      }
      // IF storeValue determines we are one of the nodes to store, then it will get scheduled again.
      this.storeValue(key, found);
    });
  }
  retrieveLocally(key) {     // Retrieve from memory.
    const stored = this.storage.get(key);
    if (stored === undefined) return stored;

    // Comment out if the above does not create StorageBag.
    this.constructor.assert(stored instanceof StorageBag, 'Not a StorageBag', stored);

    return stored.toJSON();
  }
  removeLocally(key) { // Not our problem any more.
    this.storage.get(key)?.clearStorageExpirations();
    this.storage.delete(key);
    // Defensive programming. The caller will not have actually scheduled the next timer yet.
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
  }

  async replicateStorage() { // Replicate all of our data.
    if (!this.storage.size) return;
    this.ilog('Copying', this.storage.size, 'stored values');
    await Promise.all(this.storage.entries().map(async ([key, value]) => {
      this.constructor.assert(value !== undefined, 'disconnect/copy of undefined stored value', this.storage);
      await this.storeValue(key, value);
    }));
  }
  async replicateCloserStorage(contact) { // Replicate to new contact any of our data for which contact is closer than us.
    for (const key in this.storage.keys()) {
      if (contact.connection && (contact.distance(key) <= this.distance(key))) {
	await contact.sentRPC('store', key, this.retrieveLocally(key));
      }
    }
  }
}
