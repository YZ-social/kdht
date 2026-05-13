const { BigInt, URL } = globalThis; // For linters.
import { v4 as uuidv4 } from 'uuid';
import { Node } from '../nodes/node.js';
import { Helper } from '../nodes/helper.js';
import { Contact } from './contact.js';
import { WebRTC } from '@yz-social/webrtc';

export class WebContact extends Contact { // Our wrapper for the means of contacting a remote node.
  // Can this set all be done more simply?
  get name() { return this.node.name; } // Key of remote node as a string (e.g., as a guid).
  get key() { return this.node.key; }   // Key of remote node as a BigInt.
  get isServerNode() { return this.node.isServerNode; } // It it reachable through a server.
  get webrtcLabel() {
    return `@${this.host.contact.sname} => ${this.sname}`;
  }
  static generateName() { return uuidv4(); }

  async fetchSignals(url, signalsToSend) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body: JSON.stringify(signalsToSend)
    }).catch(e => this.host.flog(e));
    if (!this.checkResponse(response)) return [];
    return await this.checkSignals(await response?.json());
  }
  async signals(senderSname, ...signals) { // Accept directed WebRTC signals from a sender sname, creating if necessary the
    // new contact on host to receive them, and promising a response.
    //this.host.flog('contact signals', senderSname, signals);
    let contact = await this.ensureRemoteContact(senderSname);

    if (contact.webrtc?.pc) return await contact.webrtc.respond(signals);

    const start = Date.now();
    const resolver = contact.earlyConnectResolver;
    const connection = contact.createConnection(false).finally(() => contact.noteConnection(start));
    if (resolver) connection.then(channel => resolver(channel));
    else contact.connection = connection;
    return await contact.webrtc?.respond(signals);
  }
  static async configure(baseURL = new URL('/kdht/', globalThis.location || 'http://localhost:3000')) {
    // Ask the portal for the turnURL with specific IP address, rather than using location.hostname.
    WebContact.iceConfiguration = {
      iceServers: [{
	urls: 'stun:stun.l.google.com:19302'
      }, {
	urls: await fetch(new URL('./turnURL', baseURL).href).then(response => response.json()),
	// WebRTC will generally fail to parse an empty credential, despite what the spec says.
	// However, the actual value is ignored if the username is "anonymous" and the TURN server has no auth.
	// (I have not gotten Firefox or Node/wrtc to work at all with anonymous.)
	username: "anonymous", credential: "none"
	//username: "dummy@yz", credential: "junk"
      }],
      //iceTransportPolicy: 'relay' // Use this to test that the TURN server actually works.
    };
  }
  static async create(...rest) {
    if (!this.iceConfiguration) await this.configure();
    return super.create(...rest);
  }
  createConnection(initiate = true, timeoutMS = this.host.timeoutMS || 50e3) { // Ensure we are connected, if possible.
    // Return a promise for an open webrtc data channel:
    //   this.send(string) puts data on the channel
    //   incomming messages are dispatched to receiveWebRTC(string)
    // Sets up contact to have properties:
    // - closed - resolves when webrtc closes.
    // - webrtc - an instance of WebRTC (which may be used for webrtc.respond()
    //
    // If timeoutMS is non-zero and a connection is not established within that time, connection and closed resolve to null.
    //
    // This is synchronous: all side-effects (assignments to this) happen immediately.
    if (this.webrtc) return new Promise(resolve => {}); // We received signals while we were queued. Those signals will resolve our queue promise which is racing against the promise we return now.

    this.host.log('=>', this.sname, 'starting connection', this.counter, 'initiate:', initiate, 'webrtc:', !!this.webrtc, 'connection:', !!this.connection);
    this.host.noteContactForTransport(this);
    const { host, node, bootstrapHost } = this;
    let {promise, resolve} = Promise.withResolvers(); // That this specific contact has closed. Commpare host.contact.detachment.
    this.closed = promise;

    let pinger;
    const conf = this.constructor.iceConfiguration;
    const webrtc = this.webrtc = new WebRTC({name: this.webrtcLabel,
					     debug: host.debug,
					     configuration: conf,
					     polite: this.host.key < this.node.key});
    const onmessage = event => this.receiveWebRTC(event.data);
    const ondatachannelclose = async normalClosure => { // Does NOT mean that the far side has gone away. It could just be over maxTransports.
      this.host.log('connection closed to', this.sname, 'normal:', !!normalClosure);
      clearInterval(pinger);
      if (this.webrtc && !this.host.isStopped()) {
	// If called by timeout, normalClosure is falsy.
	if (normalClosure && this.isRunning) this.host.ilog('=>', this.sname, 'was not politely closed. Removing contact.');
	this.host.removeContact(this);
      }
      this.unsafeData?.removeEventListener('close', ondatachannelclose);
      this.unsafeData?.removeEventListener('message', onmessage);
      await this.webrtc?.close();
      webrtc.closed = this.webrtc = this.connection = this.unsafeData = null;
      resolve('CLOSED'); // closed promise
      if (!this.anyOpen) this.host.contact.detached(!this.host.isStopped() ? this.host.contact : false);
    };
    if (initiate) {
      if (bootstrapHost && !this.anyOpen) {
	const url = `${bootstrapHost || 'http://localhost:3000/kdht'}/join/${host.contact.sname}/${this.sname}`;
	this.webrtc.transferSignals = signals => this.fetchSignals(url, signals);
      } else {
	this.webrtc.transferSignals = signals => this.messageSignals(signals);
      }
    } // Otherwise, we just hang on to signals until we're asked to respond().

    let timeout;
    const kdhtChannelName = 'kdht';
    const channelPromise = webrtc.getDataChannelPromise(kdhtChannelName);
    webrtc.createChannel(kdhtChannelName, {negotiated: true});
    channelPromise.then(async dataChannel => {
      clearTimeout(timeout);
      this.unsafeData = dataChannel;
      dataChannel.addEventListener('close', ondatachannelclose);
      dataChannel.addEventListener('message', onmessage);
      if (host.info || host.debug) await webrtc.reportConnection(true);
      if (webrtc.statsElapsed > 500) this.host.flog(`** slow connection to ${this.sname} took ${webrtc.statsElapsed.toLocaleString()} ms. **`);

      pinger = setInterval(async () => {
	const pong = await this.sendRPC('ping', this.key);
	this.host.log('=>', this.sname, 'ping', pong);
      }, 2e3);
    });
    if (!timeoutMS) return channelPromise;
    const timerPromise = new Promise(expired => {
      timeout = setTimeout(async () => {
	this.host.flog('=>', this.sname, '*************** timeout expiration');
	if (this.host.isStopped()) return expired(null);
	ondatachannelclose();
	this.host.removeContact(this); // fixme?
	return expired(null);
      }, timeoutMS);
    });
    return Promise.race([channelPromise, timerPromise]);
  }

  synchronousSend(message) { // this.send awaits channel open promise. This is if we know it has been opened.
    if (this.unsafeData?.readyState !== 'open') return; // But it may have since been closed.
    this.host.log('sending', message, 'to', this.sname, this.unsafeData?.readyState);
    try {
      this.unsafeData.send(JSON.stringify(message));
    } catch (e) { // Some webrtc can change readyState in background.
      this.host.log(e);
    }
  }
  get isOpen() {
    return this.unsafeData?.readyState === 'open';
  }
  serializeRequest(messageTag, method, sender, targetKey, ...rest) { // Stringify sender and targetKey.
    Node.assert(sender instanceof Contact, 'no sender', sender);
    return [messageTag, method, sender.sname, targetKey.toString(), ...rest];
  }
  async deserializeRequest(method, sender, targetKey, ...rest) { // Inverse of serializeRequest. Response object will be spread for Node receiveRPC.
    // TODO: Currently, parameters do NOT include messageTag! (Because of how receiveRPC is called without it.)
    return [method, await this.ensureRemoteContact(sender), BigInt(targetKey), ...rest];
  }
  isSignalResponse(response) {
    const first = response[0];
    if (!first) return false;
    if (('description' in first) || ('candidate' in first)) return true;
    return false;
  }
  serializeResponse(response) {
    if (!this.host.constructor.isContactsResult(response)) return response;
    if (this.isSignalResponse(response)) return response;
    return response.map(helper => [helper.contact.sname, helper.distance.toString()]);
  }
  async deserializeResponse(result) {
    let response;
    if (!Node.isContactsResult(result)) return result;
    if (!result.length) return result;
    if (this.isSignalResponse(result)) return result;
    return await Promise.all(result.map(async ([sname, distance]) =>
      new Helper(await this.ensureRemoteContact(sname, this), BigInt(distance))));
  }
  async transmitRPC(messageTag, method, sender, ...rest) { // Must return a promise.
    // this.host.log('transmit to', this.sname, this.connection ? 'with connection' : 'WITHOUT connection');
    if (!this.webrtc) return 0;
    const responsePromise = this.getResponsePromise(messageTag);
    const closed = this.closed;
    const nChunks = await this.send([messageTag, method, sender, ...rest]);
    const timeout = this.rpcTimeout(method, nChunks, ...rest);
    return await Promise.race([responsePromise, timeout, closed]);
  }

  static fragmentId = 0;
  pendingFragments = {};
  async send(message) { // Promise to send through previously opened connection promise and resolve to the number of chunks sent.
    let channel = await this.connection;
    // null channel implies no connection
    if (!channel || channel.readyState !== 'open') {
      this.host.ilog('Tried to send on', channel?.readyState, 'channel on', this.sname, this.host.isRunning, this.host.isStopped());
      // Likely an impolite disconnect, or a stale helper/contact that was in-process.  Count this contact as dead.
      this.host.removeContact(this);
      await this.disconnectTransport(false);
      return 0;
    }
    try {
      const payload = JSON.stringify(message);
      let sctp = this.webrtc?.pc?.sctp; // We might be renogitating.
      const size = sctp ? (sctp.maxMessageSize ? (sctp.maxMessageSize - 100) : Infinity) : 16e3;
      if (payload.length < size) {
	channel.send(payload);
	return 1;
      }
      // break up long messages. (As a practical matter, 16 KiB is the longest that can reliably be sent across different wrtc implementations.)
      // See https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels#concerns_with_large_messages
      const numChunks = Math.ceil(payload.length / size);
      const id = this.constructor.fragmentId++;
      const meta = ['fragments', id, numChunks];
      this.host.ilog(`Fragmenting large message ${id} into ${numChunks} chunks of ${size}.`, meta);
      channel.send(JSON.stringify(meta));
      // Optimization opportunity: rely on messages being ordered and skip redundant info. Is it worth it?
      for (let i = 0, o = 0; i < numChunks; ++i, o += size) {
	const frag = ['frag', id, i, payload.substr(o, size)];
	const sub = JSON.stringify(frag);
	//this.host.ilog('send', sub.slice(0, 200), 'to', this.name);
	channel.send(sub);
      }
      this.host.flog('chunks', numChunks, id, meta);
      return numChunks;
    } catch (e) { // Some webrtc can change readyState in background.
      this.host.flog(e);
      return 0;
    }
  }
  async receiveWebRTC(dataString) { // Handle receipt of a WebRTC data channel message that was sent to this contact.
    // The message could the start of an RPC sent from the peer, or it could be a response to an RPC that we made.
    // As we do the latter, we generate and note (in transmitRPC) a message tag included in the message.
    // If we find that in our messageResolvers tags, then the message is a response.
    const [messageTag, ...data] = JSON.parse(dataString);
    switch (messageTag) {
    case 'fragments':
      const [id, numChunks] = data;
      let fragments = this.pendingFragments[id] ||= {message: Array(numChunks)}; // Might have been set by an early frag.
      fragments.message.length = fragments.remaining = numChunks;
      //console.log('receiving', this.pendingFragments[id]);
      break;
    case 'frag':
      const [fid, i, fragment] = data;
      let frag = this.pendingFragments[fid];
      // Even though the messages should arrive in order, it is possible that the message handler
      // won't be called in order.
      if (!frag) frag = this.pendingFragments[fid] = {message: Array(i + 1)};
      frag.message[i] = fragment;
      //console.log('got fragment', i, 'of', fid, 'size', fragment.length, fragment.slice(0, 200));
      if ((frag.remaining === undefined) || (0 !== --frag.remaining)) return;
      const combined = frag.message.join('');
      this.host.ilog('dispatching large message', combined.slice(0, 200), '...', combined.slice(-50));
      delete this.pendingFragments[fid];
      await this.receiveWebRTC(combined);
      break;
    default:
      await this.receiveRPC(messageTag, ...data);
    }
  }
  disconnectTransport(notification = 'close') {
    const webrtc = this.webrtc;
    const dataChannel = this.unsafeData;
    super.disconnectTransport(notification);
    this.connection = this.webrtc = null;
    dataChannel?.close();
    return webrtc?.close();
  }
}
