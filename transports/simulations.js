import { Node } from '../dht/node.js';
import { Contact } from './contact.js';

export class SimulatedContact extends Contact {
  get name() { return this.node.name; }
  get key() { return this.node.key; }
  get isServerNode() { return this.node.isServerNode; }

  get isRunning() { // Is the far node running.
    return this.node.isRunning;
  }
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
    Node.assert(farContactForUs.key === this.host.key, 'Far contact backpointer', farContactForUs.node.name, 'does not point to us', this.host.name);
    Node.assert(farContactForUs.host.key === this.key, 'Far contact host', farContactForUs.host.name, 'is not hosted at contact', this.name);
    super.disconnectTransport(andNotify);
    this.connection = farContactForUs.connection = null;
  }

  async checkSignals(signals) {
    if (!signals) {
      await this.host.removeContact(this);
      return [];
    }
    return signals;
  }
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
    Node.delay(100);
    if (!this.host.isRunning) return [];
    const try2 = await trySponsors();
    //if (try2) this.host.xlog('found', this.sname, 'in second try of sponsors', sponsors.map(c => c.report).join(', '));
    if (try2) return try2;
    
    if (!this.host.isRunning) return [];
    // if (this.node.isRunning)
    //   this.host.xlog('Using recursive signal routing to', this.sname, 'after trying', sponsors.length, 'sponsors.');
    // Node.delay(100); // Why do we spin without this delay? fixme remove?
    const start = Date.now();
    const {forwardingExclusions, result} = (await this.host.recursiveSignals(this.key, payload, [], this.name)) || {};
    if (this.isRunning && !result) // Of course, only simulations know if this is false.
      this.host.xlog('Recursive response', !!result, 'to', this.isRunning ? 'running' : 'disconnected', this.sname,
		     'in', forwardingExclusions?.length, 'steps over',
		     Date.now() - start, 'ms, after trying',
		     sponsors.length, 'sponsors.',
		    );
    if (!this.host.isRunning) return []; // fixme remove
    return this.checkSignals(result);
  }
  getName(sname) { // Answer name from sname.
    if (sname.startsWith(this.constructor.serverSignifier)) return sname.slice(1);
    return sname;
  }
  async ensureRemoteContact(sname, sponsor = null) {
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
  async signals(senderSname, ...signals) { // Accept directed WebRTC signals from a sender sname, creating if necessary the
    // new contact on host to receive them, and promising a response.
    //this.host.xlog('contact signals', senderSname, signals);
    let contact = await this.ensureRemoteContact(senderSname);
    this.host.xlog('returning signals from', senderSname);
    return ['dummy answer', 'dummy candidate'];
  }
    
  async connect(forMethod = 'findNodes') { // Connect from host to node, promising a possibly cloned contact that has been noted.
    // Simulates the setup of a bilateral transport between this host and node, including bookkeeping.
    // TODO: Simulate webrtc signaling.
    const contact = this;
    let { host, node, isServerNode, connection } = contact;
    Node.assert(host.key !== node.key, 'connecting to self', host, node);
    if (connection) return connection;

    return this.connection = new Promise(resolveHere => {
      const farContactForUs = node.ensureContact(host.contact);
      farContactForUs.connection = new Promise(async resolveFar => {

	// Anyone can connect to a server node using the server's connect endpoint.
	// Anyone in the DHT can connect to another DHT node through a sponsor.
	if (isServerNode) {
	  await Node.delay(200); // Connect through portal.
	} else {
	  this.host.ilog('connecting', this.sname);
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
      });
    });
  }
  signals(...rest) {
    return [this.name]; // Just a simulation
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
