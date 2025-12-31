const { BigInt } = globalThis; // For linters.
import { v4 as uuidv4 } from 'uuid';
import { Node } from '../dht/node.js';
import { Helper } from '../dht/helper.js';
import { Contact } from './contact.js';
import { WebRTC } from '@yz-social/webrtc';


export class WebContact extends Contact { // Our wrapper for the means of contacting a remote node.
  // Can this set all be done more simply?
  get name() { return this.node.name; } // Key of remote node as a string (e.g., as a guid).
  get key() { return this.node.key; }   // Key of remote node as a BigInt.
  get isServerNode() { return this.node.isServerNode; } // It it reachable through a server.
  get isRunning() { return this.node.isRunning; } // Have we marked at is no longer running.

  checkResponse(response) { // Return a fetch response, or throw error if response is not a 200 series.
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
  async fetchBootstrap(label = 'random') { // Promise to ask portal (over http(s)) to convert a portal
    // worker index or the string 'random' to an available sname to which we can connect().
    const url = `http://localhost:3000/kdht/name/${label}`;
    const response = await fetch(url);
    this.checkResponse(response);
    return await response.json();
  }
  get webrtcLabel() {
    return `@${this.host.contact.sname} ==> ${this.sname}`;
  }

  ensureWebRTC(initiate = false, timeoutMS = this.host.timeoutMS || 5e3) { // If not already configured, sets up contact to have properties:
    // - connection - a promise for an open webrtc data channel:
    //   this.send(string) puts data on the channel
    //   incomming messages are dispatched to receiveWebRTC(string)
    // - closed - resolves when webrtc closes.
    // - webrtc - an instance of WebRTC (which may be used for webrtc.respond()
    //
    // If timeoutMS is non-zero and a connection is not established within that time, connection and closed resolve to null.
    //
    // This is synchronous: all side-effects (assignments to this) happen immediately.
    const start = Date.now();
    const { host, node, isServerNode, bootstrapHost } = this;
    this.host.log('starting connection', this.sname, this.connection ? 'exists!!!' : 'fresh', this.counter);
    let {promise, resolve} = Promise.withResolvers();
    this.closed = promise;
    const webrtc = this.webrtc = new WebRTC({name: this.webrtcLabel,
					     debug: host.debug,
					     polite: this.host.key < this.node.key});
    const onclose = () => { // Does NOT mean that the far side has gone away. It could just be over maxTransports.
      this.host.log('connection closed');
      resolve(null); // closed promise
      this.webrtc = this.connection = this.overlay = null;
    };
    if (initiate) {
      if (bootstrapHost || isServerNode) {
	const url = `${bootstrapHost || 'http://localhost:3000/kdht'}/join/${host.contact.sname}/${this.sname}`;
	this.webrtc.transferSignals = signals => this.fetchSignals(url, signals);
      } else {
	this.webrtc.transferSignals = signals => host.message({targetKey: this.key, targetSname: this.sname,
							       payload: ['signal', host.contact.sname, ...signals]});
      }
    } // Otherwise, we just hang on to signals until we're asked to respond().

    let timeout;
    const kdhtChannelName = 'kdht';
    const channelPromise = webrtc.getDataChannelPromise(kdhtChannelName);
    webrtc.createChannel(kdhtChannelName, {negotiated: true});
    channelPromise.then(async dataChannel => {
      this.host.log('data channel open', this.sname, Date.now() - start, this.counter);
      clearTimeout(timeout);
      dataChannel.addEventListener('close', onclose);
      dataChannel.addEventListener('message', event => this.receiveWebRTC(event.data));
      //if  (this.host.debug)
	await webrtc.reportConnection(true); // TODO: make this asymchronous?
      if (webrtc.statsElapsed > 500) this.host.xlog(`** slow connection to ${this.sname} took ${webrtc.statsElapsed.toLocaleString()} ms. **`);
      return dataChannel;
    });
    const overlayChannelName = 'overlay';
    const overlayPromise = webrtc.getDataChannelPromise(overlayChannelName);
    webrtc.createChannel(overlayChannelName, {negotiated: true});
    overlayPromise.then(async overlay => {
      overlay.addEventListener('message', event => host.messageHandler(event.data));
      return overlay;
    });
    if (!timeoutMS) {
      this.connection = channelPromise;
      this.overlay = overlayPromise;
      return;
    }
    const timerPromise = new Promise(expired => {
      timeout = setTimeout(async () => {
	const now = Date.now();
	this.host.xlog('**** connection timeout', this.sname, now - start,
		       'status:', webrtc.pc.connectionState, 'signaling:', webrtc.pc.signalingState,
		       'last signal:', now - webrtc.lastOutboundSignal,
		       'last send:', now - webrtc.lastOutboundSend,
		       'last response:', now - webrtc.lastResponse,
		       '****');
	onclose();
	await this.host.removeContact(this); // fixme?
	expired(null);
      }, timeoutMS);
    });
    this.connection = Promise.race([channelPromise, timerPromise]);
    this.overlay = Promise.race([overlayPromise, timerPromise]);
  }
  async connect() { // Connect from host to node, promising a possibly cloned contact that has been noted.
    // Creates a WebRTC instance and uses it's connectVia to to signal.
    const contact = this.host.noteContactForTransport(this);
    ///if (contact.connection) contact.host.xlog('connect existing', contact.sname, contact.counter);

    const { host, node, isServerNode, bootstrapHost } = contact;
    // Anyone can connect to a server node using the server's connect endpoint.
    // Anyone in the DHT can connect to another DHT node through a sponsor.
    if (contact.connection) return contact.connection;
    contact.ensureWebRTC(true);
    await Promise.all([this.connection, this.overlay]);
    return this.connection;
  }
  async signals(senderSname, ...signals) { // Accept directed WebRTC signals from a sender sname, creating if necessary the
    // new contact on host to receive them, and promising a response.
    let contact = await this.ensureRemoteContact(senderSname);

    if (contact.webrtc) return await contact.webrtc.respond(signals); 

    this.host.noteContactForTransport(contact);
    contact.ensureWebRTC();
    return await contact.webrtc.respond(signals);
  }

  async send(message) { // Promise to send through previously opened connection promise.
    let channel = await this.connection;
    if (channel) channel.send(JSON.stringify(message));
    else this.host.xlog('Unable to open channel');
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
    const MAX_PING_MS = 250; // No including connect time. These are single-hop WebRTC data channels.
    // this.host.log('transmit to', this.sname, this.connection ? 'with connection' : 'WITHOUT connection');
    if (!await this.connect()) return null;
    const sender = this.host.contact.sname;
    // uuid so that the two sides don't send a request with the same id to each other.
    // Alternatively, we could concatenate a counter to our host.name.
    const messageTag = uuidv4();
    const responsePromise = new Promise(resolve => this.inFlight.set(messageTag, resolve));
    const message = [messageTag, method, sender, key.toString(), ...rest];
    this.send(message);
    const timeout = Node.delay(MAX_PING_MS, null); // Faster than waiting for webrtc to observe a close
    return await Promise.race([responsePromise, timeout, this.closed]);
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
