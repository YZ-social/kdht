import { Node } from '../dht/node.js';

export class Contact {
  // Represents an abstract contact from a host (a Node) to another node.
  // The host calls aContact.sendRpc(...messageParameters) to send the message to node and promises the response.
  // This could be by wire, by passing the message through some overlay network, or for just calling a method directly on node in a simulation.

  // Creation
  // host should be a dht Node.
  // node is the far end of the contact, and could be Node (for in-process simulation) or a serialization of a key.
  static counter = 0;
  static fromNode(node, host = node) {
    const contact = new this();
    // Every Contact is unique to a host Node, from which it sends messages to a specific "far" node.
    // Every Node caches a contact property for that Node as it's own host, and from which Contacts for other hosts may be cloned.
    node.contact ||= contact;
    contact.node = node;
    contact.host = host; // In whose buckets (or looseTransports) does this contact live?
    contact.counter = this.counter++;
    return contact;
  }
  static async create(properties) {
    return this.fromNode(await Node.create(properties));
  }
  static fromKey(key, host) {
    const node = Node.fromKey(key);
    return this.fromNode(node, host || node);
  }
  clone(hostNode, searchHost = true) { // Answer a Contact that is set up for hostNode - either this instance or a new one.
    // Unless searchHost is null, any existing contact on hostNode will be returned.
    if (this.host === hostNode) return this; // All good.

    // Reuse existing contact in hostNode -- if still connected.
    let existing = searchHost && hostNode.findContact(this.key);
    if (existing?.isRunning) return existing;

    // Make one.
    Node.assert(this.key !== hostNode.key, 'Cloning self-contact', this, hostNode);
    const clone = this.constructor.fromNode(this.node, hostNode);
    return clone;
  }

  // Operations
  join(other) { return this.host.join(other); }
  store(key, value) {
    return this.sendRPC('store', key, value);
  }
  disconnect() { // Simulate a disconnection of node, marking as such and rejecting any RPCs in flight.
    Node.assert(this.host === this.node, "Disconnect", this.name, "not invoked on home contact", this.host.name);
    this.host.isRunning = false;
    this.host.stopRefresh();
    this.host.contacts.forEach(async contact => {
      const far = contact.connection;
      if (!far) return;
      contact.disconnectTransport();
    });
  }
  distance(key) { return this.host.constructor.distance(this.key, key); }

  // RPC
  sendRPC(method, ...rest) { // Promise the result of a nework call to node. Rejects if we get disconnected along the way.
    const sender = this.host.contact;
    if (!sender.isRunning) return null; // sender closed before call.
    if (sender.key === this.key) return this.receiveRPC(method, sender, ...rest);

    const start = Date.now();
    return this.transmitRPC(method, ...rest) // The main event.
      .then(result => {
	if (!sender.isRunning) return null; // Sender closed after call.
	return result;
      })
      .finally(() => Node.noteStatistic(start, 'rpc'));
  }
  async receiveRPC(method, sender, ...rest) { // Call the message method to act on the 'to' node side.
    Node.assert(typeof(method)==='string', 'no method', method);
    Node.assert(sender instanceof SimulatedContact, 'no sender', sender);
    return this.host.receiveRPC(method, sender, ...rest);
  }
  // Sponsorship
  _sponsors = new Map();
  noteSponsor(contact) {
    if (!contact) return;
    this._sponsors.set(contact.key, contact);
  }
  hasSponsor(key) {
    return this._sponsors.get(key);
  }

  // Utilities
  get report() { // Answer string of name, followed by * if disconnected
    //return `${this.connection ? '_' : ''}${this.node.name}${this.isRunning ? '' : '*'}@${this.host.name}v${this.counter}`; // verbose version
    return `${this.connection ? '_' : ''}${this.name}${this.isRunning ? '' : '*'}`; // simpler version
  }
  static pingTimeMS = 30; // ms
  static async ensureTime(thunk, ms = this.pingTimeMS) { // Promise that thunk takes at least ms to execute.
    const start = Date.now();
    const result = await thunk();
    const elapsed = Date.now() - start;
    if (elapsed > ms) return result;
    await new Promise(resolve => setTimeout(resolve, ms - elapsed));
    return result;
  }
}
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
	if (!sponsor.connection || !sponsor.node.findContact(this.node.key)?.connection) continue;
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
