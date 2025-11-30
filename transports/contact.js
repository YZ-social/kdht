import { Node } from '../dht/node.js';

export class Contact {
  // Represents an abstract contact from a host (a Node) to another node.
  // The host calls aContact.sendRpc(...messageParameters) to send the message to node and promises the response.
  // This could be by wire, by passing the message through some overlay network, or for just calling a method directly on node in a simulation.
  store(key, value) {
    return this.sendRPC('store', key, value);
  }
}
export class SimulatedContact extends Contact {
  static fromNode(node, host = node) {
    const contact = new this();
    // Every Contact is unique to a host Node, from which it sends messages to a specific "far" node.
    // Every Node caches a contact property for that Node as it's own host, and from which Contacts for other hosts may be cloned.
    node.contact ||= contact;
    contact.node = node;
    contact.host = host; // In whose buckets does this contact live?
    return contact;
  }
  static async create(properties) {
    return this.fromNode(await Node.create(properties));
  }
  static fromKey(key, host) {
    const node = Node.fromKey(key);
    return this.fromNode(node, host || node);
  }
  get name() { return this.node.name; }
  get key() { return this.node.key; }
  join(other) { return this.node.join(other); }
  distance(key) { return this.node.distance(key); }

  get farHomeContact() { // Answer the canonical home Contact for the node at the far end of this one.
    return this.node.contact;
  }
  clone(hostNode, searchHost = true) { // Answer a Contact that is set up for hostNode - either this instance or a new one.
    // Unless searchHost is null, any existing contact on hostNode will be returned.
    if (this.host === hostNode) return this; // All good.

    // Reuse existing contact in hostNode -- if still connected.
    let existing = searchHost && hostNode.findContact(this.key);
    if (existing?.isConnected) return existing;

    // Make one.
    Node.assert(this.key !== hostNode.key, 'Cloning self-contact', this, hostNode);
    const clone = this.constructor.fromNode(this.node, hostNode);
    return clone;
  }
  _connected = true;
  get isConnected() { // Ask our canonical home contact.
    return this.farHomeContact._connected;
  }
  get report() { // Answer string of name, followed by * if disconnected
    return `${this.hasTransport ? '_' : ''}${this.node.name}${this.isConnected ? '' : '*'}`;
  }
  disconnect() { // Simulate a disconnection of node, marking as such and rejecting any RPCs in flight.
    const { farHomeContact } = this;
    farHomeContact._connected = false;
    this.node.stopRefresh();
  }
  sendRPC(method, ...rest) { // Promise the result of a nework call to node. Rejects if we get disconnected along the way.
    const sender = this.host.contact;
    if (!sender.isConnected) return null; // sender closed before call.
    if (sender.key === this.key) return this.receiveRpc(method, sender, ...rest);

    const start = Date.now();
    return this.transmitRpc(method, sender, ...rest) // The main event.
      .then(result => {
	if (!sender.isConnected) return null; // Sender closed after call.
	return result;
      })
      .finally(() => Node.noteStatistic(start, 'rpc'));
  }
  async transmitRpc(...rest) {
    if (!this.isConnected) return null; // Receiver closed.
    return await this.receiveRpc(...rest);
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
  async receiveRpc(method, sender, ...rest) { // Call the message method to act on the 'to' node side.
    return await this.constructor.ensureTime(() => {
      sender = sender.clone(this.node);
      return this.node.receiveRPC(method, sender, ...rest);
    });
  }
}

export class SimulatedConnectionContact extends SimulatedContact {
  hasTransport = null;
  // There is no special behavior on disconnect, because we do not know if it is other end shutting down,
  // or simply dropping the connection to make room for more.
  findPath(contact) { // For now, just checking that there is a path, rather than producing the path.
    if (!contact) return false;
    if (this.host.findContact(contact.key)?.hasTransport) return true;
    return this.findPath(contact.sponsor);
  }
  connect(method) {
    let { host, node, sponsor } = this;
    //console.log(`connect ${host.contact.report} to ${node.contact.report} through ${sponsor?.report || null}.`);
    // if (sponsor) {
      //if (!this.findPath(sponsor)) console.log('ruh roh', host.contact.report, '\nto reach', node.contact.report);

      // // Confirm that we have transport to some sponsor...
      // let inHost = host.findContact(sponsor.key);
      // if (!inHost) {
      // 	console.warn(`Attempt to connect from ${host.contact.name} to ${this.name} through missing sponsor ${sponsor.report}.`);
      // 	host.noteContactForTransport(this);
      // 	return false;
    //}
      //Node.assert(inHost?.hasTransport, "Host", host.contact.report, "does not have transport to", sponsor.report, "to reach", node.contact.report);
      // ...and that sponsor has transport to node.
      // let inSponsor = sponsor.node.findContact(node.key);
      // Node.assert(inSponsor?.hasTransport, "Sponsor", sponsor.report, "does not have transport to", node.contact.report);
    // } else if (!this.node.isServerNode) {
    //   //if (!this.node.isServerNode) console.log("No sponsor for connection from", host.report(null), "\nto", node.report(null));
    //   Node.assert(method === 'ping', "No sponsor for connection from", host.contact.report, "to", node.contact.report, method);
    //   return false; // ping
    // }
    // Simulate the setup of a bilateral transport between this host and node, including bookkeeping.
    // TODO: Simulate webrtc signaling.
    const farContactForUs = node.noteContactForTransport(this.host.contact);
    farContactForUs.hasTransport = this;
    farContactForUs.sponsor ||= sponsor;

    host.noteContactForTransport(this);
    this.hasTransport = farContactForUs;
    return true;
  }
  async transmitRpc(...rest) { // A message from this.host to this.node. Forward to this.node through overlay connection for bucket.
    if (!this.isConnected) return null; // Receiver closed.
    Node.assert(this.key !== rest[1].key, 'senderRpc should have presented self-transmission', this, rest);
    if (!this.hasTransport && !this.connect(rest[0])) return null; // receiver no longer reachable.
    return await this.receiveRpc(...rest);
  }
}
