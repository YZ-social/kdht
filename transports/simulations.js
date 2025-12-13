import { Node } from '../dht/node.js';
import { Contact } from './contact.js';

export class SimulatedContact extends Contact {
  get name() { return this.node.name; }
  get key() { return this.node.key; }
  get isServerNode() { return this.node.isServerNode; }

  get isRunning() { // Ask our canonical home contact.
    return this.node.isRunning;
  }
  connection = null;
  async connect() { return this; }
  disconnectTransport() { }
  async transmitRPC(method, ...rest) { // Transmit the call to the receiving node's contact.
    return await this.constructor.ensureTime(async () => {
      if (!this.isRunning) return null; // Receiver closed.
      return await this.node.contact.receiveRPC(method, this.node.ensureContact(this.host.contact), ...rest);
    });
  }
}

export class SimulatedConnectionContact extends SimulatedContact {
  connection = null; // The cached connection (to another node's connected contact back to us) over which messages can be directly sent, if any.
  disconnectTransport() {
    const farContactForUs = this.connection;
    if (!farContactForUs) return;
    Node.assert(farContactForUs.key === this.host.key, 'Far contact backpointer', farContactForUs.node.name, 'does not point to us', this.host.name);
    Node.assert(farContactForUs.host.key === this.key, 'Far contact host', farContactForUs.host.name, 'is not hosted at contact', this.name);
    farContactForUs.connection = null;
    this.connection = null;
  }
  async connect(forMethod = 'findNodes') { // Connect from host to node, promising a possibly cloned contact that has been noted.
    // Simulates the setup of a bilateral transport between this host and node, including bookkeeping.
    // TODO: Simulate webrtc signaling.
    const contact = this;
    let { host, node, isServerNode } = contact;

    // Anyone can connect to a server node using the server's connect endpoint.
    // Anyone in the DHT can connect to another DHT node through a sponsor.
    if (!isServerNode) {
      let mutualSponsor = null;
      for (const sponsor of this._sponsors.values()) {
	if (!sponsor.connection || !sponsor.node.existingContact(this.node.name)?.connection) continue;
	mutualSponsor = sponsor;
      }
      if (!mutualSponsor) return null;
    }
    
    const farContactForUs = node.ensureContact(host.contact, contact.sponsor);

    contact.connection = farContactForUs;
    host.noteContactForTransport(contact);

    farContactForUs.connection = contact;
    node.noteContactForTransport(farContactForUs);
    
    return contact;
  }
  async transmitRPC(method, ...rest) { // A message from this.host to this.node. Forward to this.node through overlay connection for bucket.
    if (!this.isRunning) return null; // Receiver closed.
    const farContactForUs = this.connection || (await this.connect(method))?.connection;
    if (!farContactForUs) return null; // receiver no longer reachable.
    return await this.constructor.ensureTime(() => farContactForUs.receiveRPC(method, farContactForUs, ...rest));
  }
}
