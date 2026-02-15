import { Node } from '../nodes/node.js';
import { Contact } from './contact.js';

export class SimulatedContact extends Contact {
  get name() { return this.node.name; }
  get key() { return this.node.key; }
  get isServerNode() { return this.node.isServerNode; }

  connection = null;
  async createConnection() {
    return this.isOpen = this.connection = this.node.contact;
  }
  disconnectTransport(andNotify = true) {
    super.disconnectTransport(andNotify);
    this.connection = null;
  }
  async send(message) {
    const other = await this.connection;
    await Node.delay(10);
    other?.receiveRPC(...message);
  }
  async synchronousSend(message) {
    const other = await this.connection;
    other?.receiveRPC(...message);
  }
  // Dispatch directly on the node, returning the response. This is different than the send to and from with messageTag used by
  // SimulatedConnectionContact and WebContact.
  async transmitRPC(messageTag, method, sender, ...rest) {
    // Use delay from the destination node if set, representing a laggy VM/connection
    const delayMs = this.node.delayMs;
    return await this.constructor.ensureTime(async () => {
      if (!this.isRunning) return null; // Receiver closed.
      return await this.node.receiveRPC(method, this.node.ensureContact(this.host.contact), ...rest);
    }, delayMs);
  }
}

export class SimulatedConnectionContact extends SimulatedContact {
  connection = null; // The cached connection (to another node's connected contact back to us) over which messages can be directly sent, if any.
  async disconnectTransport(andNotify = true) {
    const farContactForUs = await this.connection;
    if (!farContactForUs) return;
    this.disconnectTime = Date.now();
    Node.assert(farContactForUs.key === this.host.key, 'Far contact backpointer', farContactForUs.node.name, 'does not point to us', this.host.name);
    Node.assert(farContactForUs.host.key === this.key, 'Far contact host', farContactForUs.host.name, 'is not hosted at contact', this.name);
    super.disconnectTransport(andNotify);
    this.isOpen = farContactForUs.isOpen = false;
    this.connection = farContactForUs.connection = null;
  }
    
  createConnection() {
    return new Promise(resolveHere => {
      const contact = this;
      let { host, node, isServerNode, connection } = contact;
      const farContactForUs = node.ensureContact(host.contact);
      farContactForUs.connection = new Promise(async resolveFar => {
	if (isServerNode) {
	  await Node.delay(200); // Connect through portal.
	} else {
	  // WebRTC typically requires two rounds of signals.
	  const batch1 = await this.messageSignals(['dummy offer', 'dummy candidate']);
	  const batch2 = batch1.length && await this.messageSignals(['dummy offer', 'dummy candidate']); 
	  if (!batch2.length) {
	    resolveHere(null);
	    resolveFar(null);
	    this.connection = farContactForUs.connection = null;
	    return;
	  }
	}

	resolveHere(farContactForUs);
	host.noteContactForTransport(contact);

	resolveFar(contact);
	node.noteContactForTransport(farContactForUs);
	farContactForUs.isOpen = contact.isOpen = true;
      });
    });
  }
  async signals(senderSname, ...signals) { // Accept directed WebRTC signals from a sender sname, creating if necessary the
    // new contact on host to receive them, and promising a response.
    let contact = await this.ensureRemoteContact(senderSname);
    this.host.log('returning signals from', senderSname);
    return ['dummy answer', 'dummy candidate'];
  }
  async transmitRPC(messageTag, method, sender, ...rest) { // "transmit" the call (with sending contact added).
    if (!this.isRunning) return null; // Receiver closed.
    const farContactForUs = await this.connection;
    if (!farContactForUs) return await Node.delay(this.constructor.maxPingMs, null);
    // Use delay from the destination node if set, representing a laggy VM/connection
    const delayMs = this.node.delayMs;
    const responsePromise = Promise.race([this.getResponsePromise(messageTag), this.rpcTimeout(method, ...rest)]);
    this.constructor.ensureTime(async () => (await farContactForUs).receiveRPC(messageTag, method, farContactForUs, ...rest), delayMs);
    return await responsePromise;
  }
}
