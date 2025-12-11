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
  static async create(properties, host = undefined) {
    return this.fromNode(await Node.create(properties), host);
  }
  static fromKey(key, host) {
    const node = Node.fromKey(key);
    return this.fromNode(node, host || node);
  }
  clone(hostNode, searchHost = true) { // Answer a Contact that is set up for hostNode - either this instance or a new one.
    // Unless searchHost is null, any existing contact on hostNode will be returned.
    if (this.host === hostNode) return this; // All good.

    // Reuse existing contact in hostNode -- if still connected.
    let existing = searchHost && hostNode.findContactByKey(this.key);
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
    Node.assert(sender instanceof Contact, 'no sender', sender);
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
