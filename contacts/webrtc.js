const { BigInt } = globalThis; // For linters.
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
    return `@${this.host.contact.sname} ==> ${this.sname}`;
  }
  static generateName() { return uuidv4(); }

  async fetchSignals(url, signalsToSend) { 
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body: JSON.stringify(signalsToSend)
    }).catch(e => this.host.flog(e));
    if (!this.checkResponse(response)) return this.fetchSignals(url, signalsToSend);
    return this.checkSignals(await response?.json());
  }
  async signals(senderSname, ...signals) { // Accept directed WebRTC signals from a sender sname, creating if necessary the
    // new contact on host to receive them, and promising a response.
    //this.host.flog('contact signals', senderSname, signals);
    let contact = await this.ensureRemoteContact(senderSname);

    if (contact.webrtc?.pc) return await contact.webrtc.respond(signals);

    const start = Date.now();
    contact.connection = contact.createConnection(false)
      .finally(() => contact.noteConnection(start));
    return await contact.webrtc?.respond(signals);
  }
  createConnection(initiate = true, timeoutMS = this.host.timeoutMS || 30e3) { // Ensure we are connected, if possible.
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
    this.host.log('starting connection', this.sname, this.counter);
    this.host.noteContactForTransport(this);
    const { host, node, bootstrapHost } = this;
    let {promise, resolve} = Promise.withResolvers();
    this.closed = promise;
    const webrtc = this.webrtc = new WebRTC({name: this.webrtcLabel,
					     debug: host.debug,
					     configuration: {iceServers: [
					       {urls: [
						 'stun:stun1.l.google.com:19302',
						 'stun:stun2.l.google.com:19302',
						 'stun:stun3.l.google.com:19302',
						 'stun:stun4.l.google.com:19302'
					       ]},
					     ]},
					     polite: this.host.key < this.node.key});
    const onmessage = event => this.receiveWebRTC(event.data);
    const onclose = normalClosure => { // Does NOT mean that the far side has gone away. It could just be over maxTransports.
      this.host.log('connection closed to', this.sname, 'normal:', !!normalClosure);
      if (this.webrtc && !this.host.isStopped()) {
	// If called by timeout, normalClosure is falsy.
	if (normalClosure) this.host.ilog('connection to', this.sname, 'was not politely closed. Removing contact.');
	this.host.removeContact(this, false);
      }
      this.unsafeData?.removeEventListener('close', onclose);
      this.unsafeData?.removeEventListener('message', onmessage);
      this.webrtc = this.connection = this.unsafeData = null;
      resolve(null); // closed promise
    };
    if (initiate) {
      if (bootstrapHost && !host.connections.find(c => c.isOpen)) {
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
      dataChannel.addEventListener('close', onclose);
      dataChannel.addEventListener('message', onmessage);
      if (this.info || this.debug) await webrtc.reportConnection(true);
      if (webrtc.statsElapsed > 500) this.host.flog(`** slow connection to ${this.sname} took ${webrtc.statsElapsed.toLocaleString()} ms. **`);
    });
    if (!timeoutMS) return channelPromise;
    const timerPromise = new Promise(expired => {
      timeout = setTimeout(async () => {
	if (this.host.isStopped()) return expired(null);
	onclose();
	this.host.removeContact(this); // fixme?
	return expired(null);
      }, timeoutMS);
    });
    return Promise.race([channelPromise, timerPromise]);
  }

  async send(message) { // Promise to send through previously opened connection promise.
    let channel = await this.connection;
    if (!channel) this.host.ilog('Tried to send without connection on', this.sname, message);
    if (!channel) return;
    if (channel.readyState !== 'open') {
      this.host.ilog('Tried to send on unopen channel on', this.sname, message);
      this.bye(); // Likely an impolite disconnect.
      return;
    }
    try {
      channel.send(JSON.stringify(message));
    } catch (e) { // Some webrtc can change readyState in background.
      this.host.log(e);
    }
  }
  synchronousSend(message) { // this.send awaits channel open promise. This is if we know it has been opened.
    if (this.unsafeData?.readyState !== 'open') return; // But it may have since been closed.
    this.host.log('sending', message, 'to', this.sname);
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
    const responsePromise = this.getResponsePromise(messageTag);
    await this.send([messageTag, method, sender, ...rest]);
    return await Promise.race([responsePromise, this.rpcTimeout(method, ...rest), this.closed]);
  }

  async receiveWebRTC(dataString) { // Handle receipt of a WebRTC data channel message that was sent to this contact.
    // The message could the start of an RPC sent from the peer, or it could be a response to an RPC that we made.
    // As we do the latter, we generate and note (in transmitRPC) a message tag included in the message.
    // If we find that in our messageResolvers tags, then the message is a response.
    const [messageTag, ...data] = JSON.parse(dataString);
    await this.receiveRPC(messageTag, ...data);
  }
  async disconnectTransport(andNotify = true) {
    if (!this.connection) return;
    super.disconnectTransport(andNotify);
    const webrtc = this.webrtc;
    this.connection = this.webrtc = null;
    webrtc?.close();
  }
}
