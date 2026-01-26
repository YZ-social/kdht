import { Node } from '../dht/node.js';
import { Contact } from './contact.js';

export class SimulatedContact extends Contact {
  get name() { return this.node.name; }
  get key() { return this.node.key; }
  get isServerNode() { return this.node.isServerNode; }

  connection = null;
  async connect() { return this; }
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
    this.connection = farContactForUs.connection = null;
  }
    
  async connect(forMethod = 'findNodes') { // Connect from host to node, promising a possibly cloned contact that has been noted.
    // Simulates the setup of a bilateral transport between this host and node, including bookkeeping.
    // TODO: Simulate webrtc signaling.
    const contact = this;
    let { host, node, isServerNode, connection } = contact;
    Node.assert(host.key !== node.key, 'connecting to self', host, node);
    if (connection) return connection;
    const start = Date.now();

    return this.connection = new Promise(resolveHere => {
      const farContactForUs = node.ensureContact(host.contact);
      farContactForUs.connection = new Promise(async resolveFar => {

	// Anyone can connect to a server node using the server's connect endpoint.
	// Anyone in the DHT can connect to another DHT node through a sponsor.
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
	  this.host.ilog('connected to', this.sname, 'in', (Date.now() - start).toLocaleString(), 'ms.');
	}

	resolveHere(farContactForUs);
	host.noteContactForTransport(contact);

	resolveFar(contact);
	node.noteContactForTransport(farContactForUs);
      });
    });
  }
  async signals(senderSname, ...signals) { // Accept directed WebRTC signals from a sender sname, creating if necessary the
    // new contact on host to receive them, and promising a response.
    let contact = await this.ensureRemoteContact(senderSname);
    this.host.log('returning signals from', senderSname);
    return ['dummy answer', 'dummy candidate'];
  }
  async send(message) {
    const other = await this.connection;
    await Node.delay(10);
    other?.receiveRPC(...message);
  }
  async synchronousSend(message) {
    const other = await this.connection;
    //await Node.delay(1);
    other?.receiveRPC(...message);
  }
  async transmitRPC(messageTag, method, sender, ...rest) { // "transmit" the call (with sending contact added).
    if (!this.isRunning) return null; // Receiver closed.
    const farContactForUs = await this.connection;
    if (!farContactForUs) return await Node.delay(this.constructor.maxPingMs, null);
    // Use delay from the destination node if set, representing a laggy VM/connection
    const delayMs = this.node.delayMs;
    const responsePromise = Promise.race([this.getResponsePromise(messageTag), this.rpcTimeout(method)]);
    this.constructor.ensureTime(async () => (await farContactForUs).receiveRPC(messageTag, method, farContactForUs, ...rest), delayMs);
    return await responsePromise;
  }
}
