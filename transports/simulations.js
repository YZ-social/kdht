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
  async transmitRPC(messageTag, method, sender, ...rest) { // Transmit the call (with sending contact added) to the receiving node's contact.
    return await this.constructor.ensureTime(async () => {
      if (!this.isRunning) return null; // Receiver closed.
      return await this.node.contact.receiveRPC(method, this.node.ensureContact(this.host.contact), ...rest);
    });
  }
}

export class SimulatedConnectionContact extends SimulatedContact {
  connection = null; // The cached connection (to another node's connected contact back to us) over which messages can be directly sent, if any.
  disconnect() {
    // Report if we are the last node to hold a value.
    if (Node.refreshTimeIntervalMS && Node.contacts?.length) { // i.e., not shutting down and in simulation where we track all Contacts.
      for (const key of this.host.storage.keys()) {
	if (!Node.contacts.some(contact => contact?.host.storage.has(key) && (contact?.key !== this.key))) {
	  console.log('\n\n*** removing last storer for ', key, this.host.storage.get(key), '***\n');
	}
      }
    }
    return super.disconnect();
  }
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
    if (isServerNode) {
      // No point in slowing the tests down to actually wait for this. It doesn't change the outcome.
      //await Node.delay(250); // Connect through portal.
    } else {
      let mutualSponsor = null;
      const isConnected = (contact) => { // Is contact already connected to us?
	return contact.connection && contact.node.existingContact(this.node.name)?.connection;
      };
      await Node.delay(100);
      const sponsors = Array.from(this._sponsors.values());
      const target = this.node, targetKey = target.key;
      for (const sponsor of sponsors) {
	if (!isConnected(sponsor)) continue;
	mutualSponsor = sponsor;
	break;
      }
      if (!mutualSponsor) {
	function findPath(contact, excluded) {
	  if (contact.key === targetKey) return true;
	  if (!isConnected(contact)) return false;
	  const closest = contact.node.findClosestHelpers(targetKey)
		.map(helper => helper.contact)
		.filter(contact => !excluded.includes(contact.key));
	  for (const sub of closest) {
	    if (findPath(sub, [sub.node.key, ...excluded])) return true;
	  }
	  return false;
	}
	mutualSponsor = findPath(this.host.contact, [this.host.key]);
      }
      if (!mutualSponsor) {
	//console.log('No connection path from', this.host.contact.report, 'to', this.report, 'sponsors:', sponsors.map(c => c.report), 'contacts:', this.node.findClosestHelpers(targetKey).map(helper => helper.contact.report));
	return null;
      }
    }

    // our sponsors are not transferred to the other side.
    const farContactForUs = node.ensureContact(host.contact);

    contact.connection = farContactForUs;
    host.noteContactForTransport(contact);

    farContactForUs.connection = contact;
    node.noteContactForTransport(farContactForUs);
    
    return contact;
  }
  async transmitRPC(messageTag, method, sender, ...rest) { // "transmit" the call (with sending contact added).
    if (!this.isRunning) return null; // Receiver closed.
    const farContactForUs = this.connection || (await this.connect(method))?.connection;
    if (!farContactForUs) return await Node.delay(this.constructor.maxPingMs, null);
    return await this.constructor.ensureTime(() => farContactForUs.receiveRPC(method, farContactForUs, ...rest));
  }
}
