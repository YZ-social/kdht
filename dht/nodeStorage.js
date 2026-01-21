import { NodeRefresh } from './nodeRefresh.js';

// Keeping application data.
export class NodeStorage extends NodeRefresh {
  storage = new Map(); // keys must be preserved as bigint, not converted to string.
  // TODO: store across sessions
  storeLocally(key, value) { // Store in memory by a BigInt key (must be already hashed). Not persistent.
    const hadValue = this.storage.has(key);
    this.storage.set(key, value);
    if (this.constructor.diagnosticTrace) {
      this.log(`storeLocally(${key}, ${value}) - ${hadValue ? 'updated' : 'NEW'}`);
    }
    // TODO: The paper says this can be optimized.
    // Claude.ai suggests just writing to the next in line, but that doesn't work.
    this.schedule(key, 'storage', () => {
      this.ilog('refresh value', value, 'at key', key);
      this.storeValue(key, value);
    });
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
