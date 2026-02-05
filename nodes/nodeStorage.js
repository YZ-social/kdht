import { NodeRefresh } from './nodeRefresh.js';
import { StorageBag } from './storageBag.js';

// Keeping application data.
export class NodeStorage extends NodeRefresh {
  storage = new Map(); // keys must be preserved as bigint, not converted to string.
  // TODO: store across sessions

  // These two accept and produce a list of StorageItems.
  storeLocally(key, value) { // Store in memory by a BigInt key (must be already hashed). Not persistent.
    let existingValue = this.storage.get(key);

    // Follow the rules to merge against any existing values and perform any needed side-effects.
    // This section can be commented out for development, to just use raw values directly
    //
    // Begin by converting value if it is not already a StorageItem POJO.
    if (!value?.every?.(element => element.payload !== undefined)) {
      this.constructor.assert((typeof(value) === 'number') ||
			      ((typeof(value) === 'string') && !value.startsWith('[') && !value.startsWith('{')),
			      'wrapping weird data into a storage item', typeof(value), value);
      value = [{payload: value}]; // fixme: not here
    }
    value = (existingValue ||= new StorageBag()).merge(value, this, key);


    this.storage.set(key, value);
    if (this.constructor.diagnosticTrace) {
      this.log(`storeLocally(${key}, ${value}) - ${existingValue ? 'updated' : 'NEW'}`);
    }
    // TODO: The paper says this can be optimized.
    // Claude.ai suggests just writing to the next in line, but that doesn't work.
    this.schedule(key, 'storage', () => {
      const found = this.retrieveLocally(key);
      this.ilog('refresh value', key, found);
      // IF storeValue determines we are one of the nodes to store, then it will get scheduled again.
      this.storeValue(key, found);
    });
  }
  retrieveLocally(key) {     // Retrieve from memory.
    const stored = this.storage.get(key);

    // Comment out if the above does not create StorageBag.
    this.constructor.assert((stored === undefined) || stored instanceof StorageBag, 'Not a StorageBag', stored);

    return this.constructor.transportValue(stored);
  }

  static transportValue(storedValue) {
    // storage value is a StorageBag that we want to convert to list of StorageItems POJOS.
    // For development, it is convenient to allow other values to be used as is (i.e. if they do not have a toJSON).
    // (See comment in storeLocally.)
    // And this gives us something greppable.
    return storedValue?.toJSON?.() || storedValue;
  }
  async replicateCloserStorage(contact) { // Replicate to new contact any of our data for which contact is closer than us.
    for (const key in this.storage.keys()) {
      if (contact.connection && (contact.distance(key) <= this.distance(key))) {
	await contact.store(key, this.retrieveLocally(key));
      }
    }
  }
}
