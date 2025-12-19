const { BigInt } = globalThis; // For linters.
import { v4 as uuidv4 } from 'uuid';
import { Node } from '../dht/node.js';
import { Helper } from '../dht/helper.js';
import { Contact } from './contact.js';
import { WebRTC } from '@yz-social/webrtc';


export class WebContact extends Contact {
  // Can this set all be done more simply?
  get name() { return this.node.name; }
  get key() { return this.node.key; }
  get isServerNode() { return this.node.isServerNode; }
  get isRunning() { return this.node.isRunning; }

  checkResponse(response) {
    if (!response.ok) throw new Error(`fetch ${response.url} failed ${response.status}: ${response.statusText}.`);
  }
  async fetchSignals(url, signalsToSend) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signalsToSend)
    });
    this.checkResponse(response);
    return await response.json();
  }
  async fetchBootstrap(label = 'random') {
    const url = `http://localhost:3000/kdht/name/${label}`;
    const response = await fetch(url);
    this.checkResponse(response);
    return await response.json();
  }
  get webrtcLabel() {
    return `@${this.host.contact.sname} ==> ${this.sname}`;
  }
  ensureWebRTC(initialSignals, timeoutMS = 5e3) { // If not already configured, sets up contacbt to have properties:
    // - connection - a promise for an open webrtc data channel:
    //   this.send(string) puts data on the channel
    //   incomming messages are dispatched to receiveWebRTC(string)
    // - closed - resolves when webrtc closes.
    // - webrtc - an instance of WebRTC (which may be used for webrtc.respond()
    //
    // initialSignals should be a list, or null for the creator of the offer.
    // If timeoutMS is non-zero and a connection is not established within that time, connection and closed resolve to null.
    //
    // This can be called in 'offer' mode (with null initialSignals), or 'answer' mode (with signals from the other side).
    // If already in answer mode, there will have been established this.webrtc and this.connection immediately with the first signals:
    // - If more signals received, just continue giving new signals to this.webrtc.respond().
    // - If we subsequently try to connect(), just answer existing this.connection and wait for that.
    // However, if in offer mode:
    // - A new attempt to connect() should just answer existing this.connection.
    // - The initial connection will be engaged in a specific call-response pattern, such that new signals for this exchange will
    //   come as responses to POST or overlay requests managed by this.webrtc.connectVia, and thus NOT appear through this.signals().
    // - A new signals() method represents the other side attempting offer to us even as we are offering to them.
    //   FIXME How to resolve? Do promises get reset on either side?

    // All side-effects (assignments to this) happen synchronously/immediately.
    const mode = initialSignals ? 'receive' : 'connect';
    this.host.log('starting connection', this.sname, mode, this.connection ? 'exists!!!' : 'fresh', this.counter); const start = Date.now();
    let {promise, resolve} = Promise.withResolvers();
    this.closed = promise;
    const webrtc = this.webrtc = new WebRTC({label: this.webrtcLabel, multiplex: true});
    const onclose = () => { // Does NOT mean that the far side has gone away. It could just be over maxTransports.
      this.host.log('connection closed');
      resolve(null); // closed promise
      this.connection = this.webrtc = this.overlay = null;
    };
    let timeout;
    webrtc.abandonConnection = () => {
      clearTimeout(timeout);
      webrtc.close();
      this.webrtc = this.connection = this.overlay = null;
    };
    const channelPromise = webrtc.ensureDataChannel('kdht', {}, initialSignals)
	  .then(async dataChannel => {
	    this.host.log('data channel open', this.sname, mode, Date.now() - start, this.counter);
	    clearTimeout(timeout);
	    dataChannel.addEventListener('close', onclose);
	    dataChannel.addEventListener('message', event => this.receiveWebRTC(event.data));
	    await webrtc.reportConnection(this.host.debug); // TODO: make this asymchronous?
	    if (webrtc.statsElapsed > 500) console.log(`** slow connection to ${this.sname} took ${webrtc.statsElapsed.toLocaleString()} ms. **`);
	    return dataChannel;
	  });
    const overlayPromise = webrtc.ensureDataChannel('overlay').then(async overlay => {
      overlay.addEventListener('message', event => this.host.messageHandler(event.data));
      return overlay;
    });
    if (!timeoutMS) {
      this.connection = channelPromise;
      this.overlay = overlayPromise;
      return;
    }
    const timerPromise = new Promise(expired => {
      timeout = setTimeout(async () => {
	this.host.xlog('**** connection timeout', this.sname, mode, Date.now() - start, '****');
	onclose();
	await this.host.removeContact(this); // fixme?
	expired(null);
      }, timeoutMS);
    });
    this.connection = Promise.race([channelPromise, timerPromise]);
    this.overlay = Promise.race([overlayPromise, timerPromise]);
  }
  get winsSimultaneousOffer() { // Do we win if host and node both make offers at the same time?
    return this.host.key > this.node.key;
  }
  async connect() { // Connect from host to node, promising a possibly cloned contact that has been noted.
    // Creates a WebRTC instance and uses it's connectVia to to signal.
    const contact = this.host.noteContactForTransport(this);
    ///if (contact.connection) contact.host.xlog('connect existing', contact.sname, contact.counter);
    if (contact.connection) return contact.connection;
    const { host, node, isServerNode, bootstrapHost } = contact;
    // Anyone can connect to a server node using the server's connect endpoint.
    // Anyone in the DHT can connect to another DHT node through a sponsor.
    contact.ensureWebRTC(null);
    const ready = this.webrtc?.signalsReady; // Immediately after ensureWebRTC, without yielding.
    if (!ready) return null; // It has already come and gone.
    await ready;
    const checking = response => {
      if (!response) contact.host.xlog('Falsy response from connect', contact.sname, response);
      else if (!response.length) contact.host.xlog('Empty response from connect', contact.sname);
      //if (!response || !response.some(item => item === 'abandon')) return response;
      // if (!response?.length) {
      // 	contact.host.xlog('abandoning conflicting connection', contact.sname);
      // 	contact.webrtc?.close();
      // 	contact.webrtc = contact.connection = contact.overlay = null;
      // }
      return response;
    };
    if (bootstrapHost || isServerNode) {
      const url = `${bootstrapHost || 'http://localhost:3000/kdht'}/join/${this.host.contact.sname}/${contact.sname}`;
      await contact.webrtc.connectVia(async signals => checking(await contact.fetchSignals(url, signals)));
    } else {
      if (!contact.webrtc) return null; // Conflict while waiting for signalsReady.
      //contact.host.xlog('messaging connection signals to', contact.sname, contact.key);
      await contact.webrtc.connectVia(async signals => checking(await host.message({targetKey: contact.key, targetSname: contact.sname, payload: ['signal', host.contact.sname, ...signals]})));
    }
    await Promise.all([this.connection, this.overlay]);
    return this.connection;
  }
  async signals(senderSname, ...signals) { // Accept directed WebRTC signals from a sender sname, creating if necessary the
    // new contact on host to receive them, and promising a response.
    let contact = await this.ensureRemoteContact(senderSname);
    //if (contact.webrtc?.peer.signalingState === 'have-local-offer' && signals[0]?.[0] === 'offer') return [];
    if (contact.webrtc && signals?.length && signals[0][0] === 'offer' && contact.webrtc.peer.signalingState === 'have-local-offer') {
      if (contact.winsSimultaneousOffer) {
	contact.host.xlog('**** Ignoring offer from', contact.sname, 'while in', contact.webrtc.peer.signalingState);
	return []; // Our connect will continue with it's thing.
      } else { // Shut down our connection, and treat the given signals like a cold offer.
	contact.host.xlog('**** Abandoning connection to accept offer from', contact.sname, 'while in', contact.webrtc.peer.signalingState);
	contact.webrtc.abandonConnection();
      }
    }
    if (contact.webrtc) return await contact.webrtc.respond(signals); 

    this.host.noteContactForTransport(contact);
    contact.ensureWebRTC(signals);
    return await contact.webrtc.respond([]);
  }
  async send(message) { // Promise to send through previously opened connection promise.
    const channel = await this.connection;
    if (!['open', 'connecting'].includes(channel?.readyState)) return;
    channel.send(JSON.stringify(message));
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
  receiveRPC(method, sender, key, ...rest) { // Receive an RPC from sender, dispatch, and return that value, which will be awaited and sent back to sender.
    if (method === 'forwardSignals') { // Can't be handled by Node, because 'forwardSignals' is specific to WebContact.
      const [sendingSname, ...signals] = rest;
      if (key === this.host.key) { // for us!
	return this.signals(...rest);
      } else { // Forward to the target.
	const target = this.host.findContactByKey(key);
	if (!target) {
	  console.log(this.host.contact.sname, 'does not have contact to', sendingSname);
	  return null;
	}
	return target.sendRPC('forwardSignals', key, ...rest);
      }
    }
    return super.receiveRPC(method, sender, key, ...rest);
  }
  inFlight = new Map();
  async transmitRPC(method, key, ...rest) { // Must return a promise.
    // this.host.log('transmit to', this.sname, this.connection ? 'with connection' : 'WITHOUT connection');
    if (!await this.connect()) return null;
    const sender = this.host.contact.sname;
    // uuid so that the two sides don't send a request with the same id to each other.
    // Alternatively, we could concatenate a counter to our host.name.
    const messageTag = uuidv4();
    const responsePromise = new Promise(resolve => this.inFlight.set(messageTag, resolve));
    const message = [messageTag, method, sender, key.toString(), ...rest];
    this.send(message);
    const response = await Promise.race([responsePromise,
					 Node.delay(1.5e3, null), // Faster than waiting for webrtc to observe a close
					 this.closed]);
    return response;
  }
  async receiveWebRTC(dataString) { // Handle receipt of a WebRTC data channel message that was sent to this contact.
    // The message could the start of an RPC sent from the peer, or it could be a response to an RPC that we made.
    // As we do the latter, we generate and note (in transmitRPC) a message tag included in the message.
    // If we find that in our inFlight tags, then the message is a response.
    if (dataString === '"bye"') { // Special messsage that the other side is disconnecting, so we can clean up early.
      this.webrtc.close();
      await this.host.removeContact(this);  // TODO: Make sure we're not invoking this in maxTransports cases.
      return;
    }
    const [messageTag, ...data] = JSON.parse(dataString);
    const responder = this.inFlight.get(messageTag);
    if (responder) { // A response to something we sent and are waiting for.
      let [result] = data;
      this.inFlight.delete(messageTag);
      if (Array.isArray(result)) {
	if (!result.length) responder(result);
	const first = result[0];
	const isSignal = Array.isArray(first) && ['offer', 'answer', 'icecandidate'].includes(first[0]);
	if (isSignal) {
	  responder(result); // This could be the sponsor or the original sender. Either way, it will know what to do.
	} else {
	  responder(await Promise.all(result.map(async ([sname, distance]) =>
	    new Helper(await this.ensureRemoteContact(sname, this), BigInt(distance)))));
	}
      } else {
	responder(result);
      }
    } else { // An incoming request.
      const [method, senderLabel, key, ...rest] = data;
      const sender = await this.ensureRemoteContact(senderLabel);
      let response = await this.receiveRPC(method, sender, BigInt(key), ...rest);
      if ((method !== 'forwardSignals') && this.host.constructor.isContactsResult(response)) {
	response = response.map(helper => [helper.contact.sname, helper.distance.toString()]);
      }
      this.send([messageTag, response]);
    }
  }
  async disconnectTransport() {
    await this.send('bye'); await Node.delay(50); // FIXME: Hack: We'll need to be able to pass tests without this, too.

    this.webrtc?.close();
    this.connection = this.webrtc = this.initiating = null;
  }
}
