import { NodeRefresh } from './nodeRefresh.js';

// Keeping application data.
export class NodeStorage extends NodeRefresh {
  storage = new Map(); // keys must be preserved as bigint, not converted to string.
  // TODO: store across sessions
  storeLocally(key, value) { // Store in memory by a BigInt key (must be already hashed). Not persistent.
    if (this.storage.get(key) === value) return; // If not a new value, no need to change refresh schedule.
    this.storage.set(key, value);
    // TODO: The paper says this can be optimized.
    // Claude.ai suggests just writing to the next in line, but that doesn't work.
    this.repeat(() => this.storeValue(key, value), 'storage');
  }
  retrieveLocally(key) {     // Retrieve from memory.
    return this.storage.get(key);
  }
  async replicateCloserStorage(contact) { // Replicate to new contact any of our data for which contact is closer than us.
    for (const key in this.storage.keys()) {
      if (contact.distance(key) <= this.distance(key)) { //fixme define distance on contact
	await contact.store(key, this.retrieveLocally(key));
      }
    }
  }
}
