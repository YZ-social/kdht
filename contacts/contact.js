const { URL, Request } = globalThis; // For linters.
import { v4 as uuidv4 } from 'uuid';
import { Node } from '../nodes/node.js';

export class Contact {
  // Represents an abstract contact from a host (a Node) to another node.
  // The host calls aContact.sendRpc(...messageParameters) to send the message to node and promises the response.
  // This could be by wire, by passing the message through some overlay network, or for just calling a method directly on node in a simulation.

  // Creation
  // host should be a dht Node.
  // node is the far end of the contact, and could be Node (for in-process simulation) or a serialization of a key.
  static counter = 0;
  static fromNode(node, host = node) {
    // host only differs from node in simulation
    let contact = host.existingContact(node.name);
    if (contact) Node.assert(contact.host === host, 'Existing contact host', contact.host.name, 'does not match specified host', host.name, 'for', node.name);
    const reusingContact = !!contact;
    //if (!contact) host.log('Creating contact', node.name);
    contact ||= new this();
    // Every Contact is unique to a host Node, from which it sends messages to a specific "far" node.
    contact.node = node;
    contact.host = host; // In whose buckets (or looseContacts) does this contact live?
    if (!reusingContact) contact.counter = this.counter++;
    host.addExistingContact(contact); // After contact.node (and thus contact.name) is set.

    if (host !== node) return contact;

    // Every Node caches a contact property for that Node as it's own host, and from which Contacts for other hosts may be cloned.
    // [st]: TODO: is it guaranteed that if node.contact already exists it'll be the same as the contact found above?  otherwise we'll be putting the one we just found into the dictionary but the node will have the old one.
    node.contact ||= contact;

    // This "home" contact is often what the application is operating on, and it has two promises to indicate the overall
    // connection to the network. E.g., publish and subscribe await attachment, because they're not very useful before that.
    const {promise:attachment, resolve:attached} = Promise.withResolvers(); // Resolves to home contact when join completes.
    const {promise:detachment, resolve:detached} = Promise.withResolvers(); // Resolves to home contact when completely disconnected.
    Object.assign(contact, {attachment, detachment, attached, detached});
    return contact;
  }
  static async create(properties = {}, host = undefined) {
    if (typeof(properties) === 'object' && properties.name === undefined) properties = {...properties, name: this.generateName()};
    return this.fromNode(await Node.create(properties), host);
  }
  static fromKey(key, host) {
    const node = Node.fromKey(key);
    return this.fromNode(node, host || node);
  }
  clone(hostNode, searchHost = true) { // Answer a Contact that is set up for hostNode - either this instance or a new one.
    // I.e., a Contact with node: this.node and host: hostNode.
    // Unless searchHost is null, a matching existing contact on hostNode will be returned.
    // In normal running (as opposed to a simulation that runs multiple hosts in the same process, for testing purposes), the following test will always be true; clone() _never_ creates a new node.
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
  isDeadToMe = false; // Do WE think the far node is dead?
  get isRunning() { // Is the far node running. Non-simulations are never falsy unless we have other info such as from 'bye'.
    // Can't set this.node.isRunning = false because that collapses simulations where this.node is not a copy.
    return !this.isDeadToMe && this.node.isRunning;
  }
  get anyOpen() {
    return this.host.connections.find(c => c.isOpen);
  }
  checkResponse(response) { // Return a fetch response, or throw error if response is not a 200 series.
    if (response?.ok) return true;
    this.host.flog(`*** Unable to reach portal ${response?.url || this.sname}, ${response?.status || 'failed fetch'}: ${response?.statusText || 'Unknown reason'}. ***`);
    return false;
  }
  async fetchBootstrap(baseURL, label = 'random') { // Promise to ask portal (over http(s)) to convert a portal
    // worker index or the string 'random' to an available sname to which we can connect().
    const url = `${baseURL}/name/${label}`;
    // connection:close is far more robust against pooling issues common to some implementations (e.g., NodeJS).
    // https://github.com/nodejs/undici/issues/3492
    const response = await fetch(new Request(url, {
      method: 'POST',
      cache: 'no-store',
      body: null,
      headers: { 'Connection': 'close' }
    })).catch(() => {});
    if (!this.checkResponse(response)) { // The portal webserver is not available.
      return '';
    }
    return await response.json();
  }

  // Home contact operations
  publish(properties) { return this.attachment.then(home => home.host.publish(properties)); }
  subscribe(properties) { return this.attachment.then(home => home.host.subscribe(properties)); }
  storeValue(key, value) { return this.attachment.then(home => home.host.storeValue(key, value)); }
  join(other) { return this.host.join(other).then(home => home.attached(home)); }
  replicateStorage() { return this.host.replicateStorage(); }
  disconnectTransports() { // Send polite termination message to each open contact, with no await.
    for (const contact of this.host.connections) {
      contact.disconnectTransport('bye');
    }
  }
  async bootstrapJoin(...baseURLs) { // Find a contact to bootstrap, and join it.
    let bootstrapName = '', baseURL = '';
    if (!baseURLs.length) baseURLs = [new URL('/kdht', globalThis.location).href];
    for (const candidate of baseURLs) {
      bootstrapName = await this.fetchBootstrap(candidate);
      if (bootstrapName) {
	baseURL = candidate;
	break;
      }
    }
    if (!bootstrapName) throw new Error(`Unable to find an open portal.`);
    this.host.ilog('entering network through', baseURL, bootstrapName);
    const bootstrapContact = await this.ensureRemoteContact(bootstrapName, baseURL);
    await this.join(bootstrapContact);
    return this;
  }

  connectionQueue = Promise.resolve();
  async connect(...baseURLs) { // Connect and promise self when connected
    // If this is the home contact of node, bootstrapJoin();
    // Otherwise (a contact for a remote node), connect from host to node.
    let { host, node, connection } = this;
    if (host.key === node.key) { // Home contact
      if (this.connection) return this.connection;
      await this.bootstrapJoin(...baseURLs);
      this.host.contact.detachment.then(() => this.host.contact.connection = this.host.isRunning = null);
      return await this.connection;
    }
    Node.assert(host.key !== node.key, 'connecting to self', host, node);
    if (connection) return this;
    const start = Date.now();
    this.connection =
      this.host.contact.connectionQueue = this.host.contact.connectionQueue.then(() =>
         this.createConnection()
      );
    await this.connection;
    this.noteConnection(start);
    return this.connection;
  }
  noteConnection(start) { // Log and not statistic
    this.host.noteStatistic('connection', start);
    this.host.ilog(this.isOpen ? 'connected to' : 'failed connecting to', this.sname, 'in', Date.now() - start, 'ms.');
  }

  async disconnect(replicateStorage = !this.host.isStopped()) { // Disconnect host node and all it's connections. Stages are:
    // (0: Testing only - Test cleanup globally sets Node.refreshTimeIntervalMS to zero.)
    // 1. Refresh all value storage.
    // 2. Stop refreshes at this host by setting host.refreshTimeIntervalMS to zero.
    // 3. For each connected contact, send 'bye' and disconnectTransport
    // 4. Stop any other activity by setting host.isRunning to false.
    Node.assert(this.host === this.node, "Disconnect", this.name, "not invoked on home contact", this.host.name);
    // Attempt to ensure that there are other copies.
    if (this.host.refreshTimeIntervalMS) this.host.ilog('disconnecting from network');
    if (replicateStorage) {
      await this.replicateStorage(); // Included in following stats.
      await this.host.publishStatistics(); // Stored in nodes as understood from the replication above.
    }
    this.host.stopRefresh();
    this.host.clearRefreshTimers();
    this.host.clearStorageExpirations();
    this.host.clearRenewals();
    for (const contact of this.host.connections) {
      const far = await contact.connection;
      if (!far) return;
      contact.synchronousSend(['-', 'bye']); // May have already been closed by other side.
      await contact.disconnectTransport(false); // no need to send 'close' after 'bye'
    }
    this.host.clearContactDictionaryExpirations();
    this.host.isRunning = false;
  }
  disconnectTransport(notification = 'close') { // There are asynchronous things that happen, but they each get triggered synchronously
    if (notification && this.connection) this.synchronousSend(['-', notification]);  // May have already sent "bye" and closed.
  }
  close() { // The sender is closing their connection, but not necessarilly disconnected entirely (e.g., maybe maxTransports)
    this.host.ilog('closing disconnected contact', this.sname);
    this.host.removeLooseContact(this.key); // If any.
    this.disconnectTransport(false); // The sender told us, so we don't need to send a notification back.
  }
  bye() { // The sender is disconnecting from the network
    this.host.ilog('removing disconnected contact', this.sname);
    this.host.removeSubscriber(this.name);
    const bucket = this.host.removeContact(this);
    this.disconnectTransport(false);
    bucket?.refresh(); // Accelerate the bucket refresh
  }
  distance(key) { return this.host.constructor.distance(this.key, key); }

  // RPC
  static maxPingMS = 3e3; // Not including connect time. These are single-hop WebRTC data channels.
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
  static recursiveHopsLimit = 15;
  rpcTimeout(method, nChunks, ...rest) { // Promise to resolve to null at appriate timeout for RPC method
    let hops = 1;
    if (method === 'signals') hops = rest[3] ? Contact.recursiveHopsLimit : 2;
    const delay = hops * Contact.maxPingMS * (1 + Math.log(nChunks));
    return Node.delay(delay, null);
  }
  async sendRPC(method, ...rest) { // Promise the result of a network call to node, or null if not possible.
    const sender = this.host.contact;

    if (!sender.isRunning) return null; // Sender closed before call.
    if (!this.isRunning) return null;   // We've marked this node dead.
    if (sender.key === this.key) { // self-send short-circuit
      const result = this.host.receiveRPC(method, sender, ...rest);
      if (!result) this.host.flog('no local result for method', method, ...rest);
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
      .finally(() => this.host.noteStatistic('rpc', start));
  }
  getResponsePromise(messageTag) { // Get a promise that will resolve when a response comes in as messageTag.
    return new Promise(resolve => this.host.messageResolvers.set(messageTag, resolve));
  }
  async receiveRPC(messageTag, methodOrResult, ...data) { // Handle a message from another node.
    if (!this.host.isRunning) return this.disconnectTransport(); // contact is already dead
    // Messages handled directly by the connection, rather than the node.
    if (methodOrResult === 'close') return this.close();
    if (methodOrResult === 'bye') return this.bye();

    // See if this is a response to something we sent and are waiting for.
    const responder = this.host.messageResolvers.get(messageTag);
    if (responder) {
      this.host.messageResolvers.delete(messageTag);
      return responder(await this.deserializeResponse(methodOrResult));
    }

    // An incoming request.
    const deserialized = await this.deserializeRequest(methodOrResult, ...data);
    let response = await this.host.receiveRPC(...deserialized);
    response = this.serializeResponse(response);
    return this.send([messageTag, response]); // async call
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
    if (this.host.isStopped()) return [];

    // sendRPC('signals', key, payload, optional) answers {result, forwardingExclusions} or null.
    // result may be null if the target could not be reached.
    // forwardingExclusions is a list of everything we tried, whether successful or not.
    const payload = [this.host.contact.sname, ...signals]; //

    // Try sponsors first. (Just two round trips if connected.)
    const sponsors = Array.from(this._sponsors.values());
    //this.host.flog('messageSignals payload/sponsors', this.sname, payload, sponsors.length);
    const trySponsors = async () => {
      for (const sponsor of sponsors) {
	if (!sponsor.isOpen) continue;
	const response = await sponsor.sendRPC('signals', this.key, payload);
	//this.host.flog('sponsor:', sponsor.sname, 'response:', response);
	if (response) return response;
	//this._sponsors.delete(sponsor.key); // FIXME: but it might be ok next time.
      }
      return null;
    };
    const try1 = await trySponsors();
    if (try1) return try1.result || [];
    await Node.delay(100); // TODO: Why is this necessary, and how long is enough?
    const try2 = await trySponsors();
    if (try2) { this.host.flog('Sponsored result from', this.sname, 'on second try.'); return try2.result || []; } // TODO: why does this ever fire?

    if (this.host.isStopped()) return [];

    const reportEmpty = this.isRunning; // Of course, this is only ever false in simulations.
    if (reportEmpty) this.host.log('Using recursive signal routing to', this.sname, 'after trying', sponsors.length, 'sponsors.'); // No result yet to see if it is empty, but useful in debugging.
    const start = Date.now();
    const expiration = start + this.constructor.maxPingMS * this.constructor.recursiveHopsLimit / 2;
    const response = await this.host.recursiveSignals(this.key, payload, [], expiration, this.sname);

    if (!response && reportEmpty) {
      this.host.flog('No recursive response from', this.sname, 'after', (Date.now() - start).toLocaleString(), 'ms and', sponsors.length, 'sponsors', sponsors.filter(c => c.isOpen).length, 'open.');
      return this.checkSignals(null);
    }

    const {forwardingExclusions, result} = response || {};
    if (!result && reportEmpty) {
      this.host.flog('Empty recursive response from', this.sname, 'after', Date.now() - start, 'ms,', forwardingExclusions?.length, 'sends, and', sponsors.length, 'sponsors', sponsors.filter(c => c.isOpen).length, 'open.');
    }
    return this.checkSignals(result);
  }
  async checkSignals(signals) {
    if (!signals) {
      this.host.removeContact(this);
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
  static pingTimeMS = 40; // ms to consume each RPC in simulations
  static async ensureTime(thunk, ms = this.pingTimeMS) { // Promise that thunk takes at least ms to execute.
    const start = Date.now();
    const result = await thunk();
    const elapsed = Date.now() - start;
    await Node.delay(ms - elapsed);
    return result;
  }
}
