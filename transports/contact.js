import { v4 as uuidv4 } from 'uuid';
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
    let contact = host.existingContact(node.name);
    if (contact) Node.assert(contact.host === host, 'Existing contact host', contact.host.name, 'does not match specified host', host.name, 'for', node.name);
    //if (!contact) host.log('Creating contact', node.name);
    contact ||= new this();
    // Every Contact is unique to a host Node, from which it sends messages to a specific "far" node.
    // Every Node caches a contact property for that Node as it's own host, and from which Contacts for other hosts may be cloned.
    node.contact ||= contact;
    contact.node = node;
    contact.host = host; // In whose buckets (or looseTransports) does this contact live?
    contact.counter = this.counter++;
    host.addExistingContact(contact); // After contact.node (and thus contact.namem) is set.
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
    // I.e., a Contact with node: this.node and host: hostNode.
    // Unless searchHost is null, a matching existing contact on hostNode will be returned.
    if (this.host === hostNode) return this; // All good.

    // Reuse existing contact in hostNode -- if still running.
    let existing = searchHost && hostNode.existingContact(this.name);
    if (existing?.isRunning) return existing;

    // Make one.
    Node.assert(this.key !== hostNode.key, 'Cloning self-contact', this, hostNode);
    const clone = this.constructor.fromNode(this.node, hostNode);
    return clone;
  }
  static serverSignifier = 'S';
  get sname() { // Serialized name, indicating whether it is a server node.
    if (this._sname) return this._sname;
    if (this.name.length < 36) return this._sname = this.name; // Kluge: index of portal node.
    if (this.isServerNode) return this._sname = this.constructor.serverSignifier + this.name;
    return this._sname = this.name;
  }

  // Operations
  join(other) { return this.host.join(other); }
  storeValue(key, value) { return this.host.storeValue(key, value); }
  store(key, value) {
    return this.sendRPC('store', key, value);
  }
  async disconnect() { // Simulate a disconnection of node, marking as such and rejecting any RPCs in flight.
    Node.assert(this.host === this.node, "Disconnect", this.name, "not invoked on home contact", this.host.name);
    this.host.isRunning = false;
    this.host.stopRefresh();
    for (const contact of this.host.contacts) {
      const far = contact.connection;
      if (!far) return;
      await contact.disconnectTransport();
    }
  }
  distance(key) { return this.host.constructor.distance(this.key, key); }

  // RPC
  static maxPingMs = 250; // No including connect time. These are single-hop WebRTC data channels.
  serializeRequest(...rest) { // Return the composite datum suitable for transport over the wire.
    return rest; // Non-simulation subclases must override.
  }
  async deserializeRequest(...rest) { // Inverse of serializeRequest. Response object will be spread for Node receiveRPC.
    return rest; // Non-simulation subclases must override.
  }
  serializeResponse(response) { // Like serializeRequest, but specifically for a probe response.
    return response;
  }
  async deserializeResponse(result) { // Inverse of serializeResponse.
    return result;
  }
  async sendRPC(method, ...rest) { // Promise the result of a network call to node, or null if not possible.
    const sender = this.host.contact;

    //this.host.log('sendRPC', method, rest, sender.isRunning ? 'running' : 'stopped', 'sender key:', sender.key, 'to node:', this.sname, this.key);
    if (!sender.isRunning) {this.host.log('not running'); return null;  }// sender closed before call.
    if (sender.key === this.key) { // self-send short-circuit
      const result = this.host.receiveRPC(method, sender, ...rest);
      if (!result) this.host.xlog('no local result');
      return result;
    }
    if (!await this.connect()) return null;
    // uuid so that the two sides don't send a request with the same id to each other.
    // Alternatively, we could concatenate a counter to our host.name.
    let messageTag = uuidv4();
    // if (method === 'signals') {
    //   messageTag = 'X' + messageTag;
    //   this.host.xlog(this.counter, 'requesting', messageTag, method, 'of', this.sname);
    // }
    const message = this.serializeRequest(messageTag, method, sender, ...rest);

    const start = Date.now();
    // FIXME: after we merge st-expts, we can reconsider/remove this timeout
    return Promise.race([this.transmitRPC(...message), Node.delay(3e3, null)])
      .then(result => {
	if (!sender.isRunning) {this.host.log('sender closed'); return null; } // Sender closed after call.
	return result;
      })
      .finally(() => Node.noteStatistic(start, 'rpc'));
  }
  getResponsePromise(messageTag) { // Get a promise that will resolve when a response comes in as messageTag.
    return new Promise(resolve => this.host.messageResolvers.set(messageTag, resolve));
  }
  async receiveRPC(messageTag, ...data) { // Call the message method to act on the 'to' node side.
    const responder = this.host.messageResolvers.get(messageTag);
    if (responder) { // A response to something we sent and are waiting for.
      let [result] = data;
      //fixme restore this.host.messageResolvers.delete(messageTag); 
      result = await this.deserializeResponse(result);
      responder(result);
    } else if (!this.host.isRunning) {
      //this.disconnectTransport();
    } else if (typeof(data[0]) !== 'string') { // Kludge: In testing, it is possible for a disconnecting node to send a request that will come back to a new session of the same id.
      this.host.xlog(this.counter, 'received result without responder', messageTag, data, 'at', this.sname);
    } else { // An incoming request.
      const deserialized = await this.deserializeRequest(...data);
      let response = await this.host.receiveRPC(...deserialized);
      response = this.serializeResponse(response);
      //if (messageTag.startsWith('X')) this.host.xlog(this.counter, 'responding', messageTag, response, 'to', this.sname);
      await this.send([messageTag, response]);
    }
  }
  // Sponsorship
  _sponsors = new Map(); // maps key => contact
  noteSponsor(contact) {
    if (!contact) return;
    this._sponsors.set(contact.key, contact);
  }
  hasSponsor(key) {
    return this._sponsors.get(key);
  }
  async findSponsor(predicate) { // Answer the sponsor contact for which await predicate(contact) is true, else falsy.
    for (const candidate of this._sponsors.values()) {
      if (await predicate(candidate)) return candidate;
    }
    return null;
  }

  // Utilities
  get report() { // Answer string of name, followed by * if disconnected
    //return `${this.connection ? '_' : ''}${this.sname}${this.isRunning ? '' : '*'}@${this.host.contact.sname}v${this.counter}`; // verbose version
    //return `${this.connection ? '_' : ''}${this.sname}v${this.counter}${this.isRunning ? '' : '*'}`;
    return `${this.connection ? '_' : ''}${this.sname}${this.isRunning ? '' : '*'}`; // simpler version
  }
  static pingTimeMS = 40; // ms
  static async ensureTime(thunk, ms = this.pingTimeMS) { // Promise that thunk takes at least ms to execute.
    const start = Date.now();
    const result = await thunk();
    const elapsed = Date.now() - start;
    await Node.delay(ms - elapsed);
    return result;
  }
}
