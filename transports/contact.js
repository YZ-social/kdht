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
  async ensureRemoteContact(sname, sponsor = null) { // Like ensureContact, but through different parameters.
    let contact;
    if (sname === this.host.contact.sname) {
      contact = this.host.contact; // ok, not remote, but contacts can send back us in a list of closest nodes.
    }
    const name = this.getName(sname);
    if (!contact) {
      // Not the final answer. Just an optimization to avoid hashing name.
      contact = this.host.existingContact(name);
    }
    if (!contact) {
      const isServerNode = name !== sname;
      contact = await this.constructor.create({name, isServerNode}, this.host); // checks for existence AFTER creating Node.
    }
    if (sponsor instanceof Contact) contact.noteSponsor(sponsor);
    else if (typeof(sponsor) === 'string') contact.bootstrapHost = sponsor;
    return contact;
  }
  static serverSignifier = 'S';
  get sname() { // Serialized name, indicating whether it is a server node.
    if (this._sname) return this._sname;
    if (this.name.length < 36) return this._sname = this.name; // Kluge: index of portal node.
    if (this.isServerNode) return this._sname = this.constructor.serverSignifier + this.name;
    return this._sname = this.name;
  }
  getName(sname) { // Answer name from sname.
    if (sname.startsWith(this.constructor.serverSignifier)) return sname.slice(1);
    return sname;
  }
  get isRunning() { // Is the far node running. Non-simulations are never falsy unless we have other info such as from 'bye'.
    return this.node.isRunning;
  }

  // Operations
  join(other) { return this.host.join(other); }
  storeValue(key, value) { return this.host.storeValue(key, value); }
  store(key, value) {
    return this.sendRPC('store', key, value);
  }
  async disconnect() { // Simulate a disconnection of node, marking as such and rejecting any RPCs in flight.
    Node.assert(this.host === this.node, "Disconnect", this.name, "not invoked on home contact", this.host.name);
    // Attempt to ensure that there are other copies.
    if (this.host.refreshTimeIntervalMS)
      this.host.ilog('disconnecting from network');
    if (!this.host.isStopped()) {
      if (this.host.storage.size) this.host.log('Copying', this.host.storage.size, 'stored values');
      await Promise.all(this.host.storage.entries().map(([key, value]) => this.storeValue(key, value)));
    }
    this.host.stopRefresh();
    for (const contact of this.host.contacts) {
      const far = await contact.connection;
      if (!far) return;
      contact.synchronousSend(['-', 'bye']); // May have already been closed by other side.
      await contact.disconnectTransport(false);
    }
    this.host.isRunning = false;
  }
  async disconnectTransport(andNotify = true) { // There are asynchronous things that happen, but they each get triggered synchronously
    if (andNotify && await this.connection) this.synchronousSend(['-', 'close']);  // May have already send "bye" and closed.
  }
  close() { // The sender is closing their connection, but not necessarilly disconnected entirely (e.g., maybe maxTransports)
    this.host.log('closing disconnected contact', this.sname, this.xxx++);
    this.disconnectTransport(false);
    this.host.removeLooseTransport(this.key); // If any.
  }
  bye() { // The sender is disconnecting from the network
    this.host.ilog('removing disconnected contact', this.sname);
    this.host.removeContact(this).then(bucket => bucket?.refresh()); // Accelerate the bucket refresh
  }
  distance(key) { return this.host.constructor.distance(this.key, key); }

  // RPC
  static maxPingMs = 330; // Not including connect time. These are single-hop WebRTC data channels.
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
  rpcTimeout(method) { // Promise to resolve to null at appriate timeout for RPC method
    let hops = 15; // recursive calls
    if (method === 'signals') hops = 2;
    else if (['ping', 'findNodes', 'findValue', 'store'].includes(method)) hops = 1;
    return Node.delay(hops * this.constructor.maxPingMs, null);
  }
  async sendRPC(method, ...rest) { // Promise the result of a network call to node, or null if not possible.
    const sender = this.host.contact;

    if (!sender.isRunning) return null; // sender closed before call.
    if (sender.key === this.key) { // self-send short-circuit
      const result = this.host.receiveRPC(method, sender, ...rest);
      if (!result) this.host.xlog('no local result');
      return result;
    }
    if (!await this.connect()) return null;
    // uuid so that the two sides don't send a request with the same id to each other.
    // Alternatively, we could concatenate a counter to our host.name.
    let messageTag = uuidv4();
    const message = this.serializeRequest(messageTag, method, sender, ...rest);

    const start = Date.now();
    return this.transmitRPC(...message)
      .then(result => {
	if (!sender.isRunning) return null; // Sender closed after call.
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
      this.host.messageResolvers.delete(messageTag);
      result = await this.deserializeResponse(result);
      responder(result);
    } else if (!this.host.isRunning) {
      this.disconnectTransport();
      // Kludge: In testing, it is possible for a disconnecting node to send a request that will respond to a new session of the same id.
    } else if (typeof(data[0]) !== 'string' || data[0] === 'pong') {
      ; //this.host.xlog(this.counter, 'received result without responder', messageTag, data, 'at', this.sname);
    } else if (data[0] === 'close') {
      this.close();
    } else if (data[0] === 'bye') {
      this.bye();
    } else { // An incoming request.
      const deserialized = await this.deserializeRequest(...data);
      let response = await this.host.receiveRPC(...deserialized);
      response = this.serializeResponse(response);
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

  // Signaling
  async messageSignals(signals) { // send signals through the network, promising the response signals.
    // If contact cannot be reached, remove it and promise [].

    // sendRPC('signals', key, payload, optional) answers {result, forwardingExclusions} or null.
    // result may be null if the target could not be reached.
    // forwardingExclusions is a list of everything we tried, whether successful or not.
    const payload = [this.host.contact.sname, ...signals]; // 
    
    // Try sponsors first. (Just two round trips if connected.)
    const sponsors = Array.from(this._sponsors.values());
    //this.host.xlog('messageSignals payload/sponsors', this.sname, payload, sponsors.length);
    const trySponsors = async () => {
      for (const sponsor of sponsors) {
	if (!sponsor.connection) continue;
	const response = await sponsor.sendRPC('signals', this.key, payload);
	//this.host.xlog('sponsor:', sponsor.sname, 'response:', response);
	if (response) return response.result || [];
	//this._sponsors.delete(sponsor.key); // FIXME: but it might be ok next time.
      }
      return null;
    };
    const try1 = await trySponsors();
    if (try1) return try1;

    // FIXME: I think we can remove this now?
    // Why does it sometimes work to try sponsors again after a delay?
    // And why is this usually (but always?) when the sponsor is a server node?
    // Node.delay(100);
    // if (!this.host.isRunning) return [];
    // const try2 = await trySponsors();
    // if (try2) this.host.xlog('found', this.sname, 'in second try of sponsors', sponsors.map(c => c.report).join(', '));
    // if (try2) return try2;
    
    if (!this.host.isRunning) return [];
    if (this.node.isRunning)
      this.host.ilog('Using recursive signal routing to', this.sname, 'after trying', sponsors.length, 'sponsors.');

    const start = Date.now();
    const {forwardingExclusions, result} = (await this.host.recursiveSignals(this.key, payload, [], Date.now + this.constructor.forwardingTimeoutMS, this.name)) || {};
    const elapsed = Date.now() - start;
    if (!!this.isRunning !== !!result) // Of course, only simulations can really know isRunning to be false.
      this.host.ilog('Recursive response', !!result, 'to', this.isRunning ? 'running' : 'disconnected', this.sname,
		     'in', forwardingExclusions?.length, 'steps over',
		     elapsed, 'ms, after trying',
		     sponsors.length, 'sponsors.',
		    );
    if (!this.host.isRunning) return [];
    return this.checkSignals(result);
  }
  async checkSignals(signals) {
    if (!signals) {
      await this.host.removeContact(this);
      return [];
    }
    return signals;
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
