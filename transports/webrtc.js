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
    if (!response) return;
    if (!response.ok) throw new Error(`fetch ${response.url} failed ${response.status}: ${response.statusText}.`);
  }
  // connection:close is far more robust against pooling issues common to some implementations (e.g., NodeJS).
  // https://github.com/nodejs/undici/issues/3492
  async fetchBootstrap(baseURL, label = 'random') { // Promise to ask portal (over http(s)) to convert a portal
    // worker index or the string 'random' to an available sname to which we can connect().
    const url = `${baseURL}/name/${label}`;
    const response = await fetch(url, {headers: { 'Connection': 'close' } }).catch(e => this.host.xlog(e));
    this.checkResponse(response);
    return await response.json();
  }
  async fetchSignals(url, signalsToSend) { 
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body: JSON.stringify(signalsToSend)
    }).catch(e => this.host.xlog(e));
    this.checkResponse(response);
    return this.checkSignals(await response?.json());
  }
  async signals(senderSname, ...signals) { // Accept directed WebRTC signals from a sender sname, creating if necessary the
    // new contact on host to receive them, and promising a response.
    //this.host.xlog('contact signals', senderSname, signals);
    let contact = await this.ensureRemoteContact(senderSname);

    if (contact.webrtc) return await contact.webrtc.respond(signals);

    this.host.noteContactForTransport(contact);
    contact.ensureWebRTC();
    return await contact.webrtc.respond(signals);
  }
  get webrtcLabel() {
    return `@${this.host.contact.sname} ==> ${this.sname}`;
  }

  ensureWebRTC(initiate = false, timeoutMS = this.host.timeoutMS || 30e3) { // Ensure we are connected, if possible.
    // If not already configured, sets up contact to have properties:
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
      this.webrtc = this.connection = this.unsafeData = null;
    };
    if (initiate) {
      if (bootstrapHost/* || isServerNode*/) {
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
      this.host.log('data channel open', this.sname, Date.now() - start, this.counter);
      clearTimeout(timeout);
      dataChannel.addEventListener('close', onclose);
      dataChannel.addEventListener('message', event => this.receiveWebRTC(event.data));
      await webrtc.reportConnection(true);
      if (webrtc.statsElapsed > 500) this.host.xlog(`** slow connection to ${this.sname} took ${webrtc.statsElapsed.toLocaleString()} ms. **`);
      this.unsafeData = dataChannel;
      return dataChannel;
    });
    if (!timeoutMS) {
      this.connection = channelPromise;
      return;
    }
    const timerPromise = new Promise(expired => {
      timeout = setTimeout(async () => {
	const now = Date.now();
	this.host.ilog('Unable to connect to', this.sname);
	// this.host.xlog('**** connection timeout', this.sname, now - start,
	// 	       'status:', webrtc.pc.connectionState, 'signaling:', webrtc.pc.signalingState,
	// 	       'last signal:', now - webrtc.lastOutboundSignal,
	// 	       'last send:', now - webrtc.lastOutboundSend,
	// 	       'last response:', now - webrtc.lastResponse,
	// 	       '****');
	onclose();
	await this.host.removeContact(this); // fixme?
	expired(null);
      }, timeoutMS);
    });
    this.connection = Promise.race([channelPromise, timerPromise]);
  }
  async connect() { // Connect from host to node, promising a possibly cloned contact that has been noted.
    // Creates a connected WebRTC instance.
    const contact = this.host.noteContactForTransport(this);
    ///if (contact.connection) contact.host.xlog('connect existing', contact.sname, contact.counter);

    const { host, node, isServerNode, bootstrapHost } = contact;
    // Anyone can connect to a server node using the server's connect endpoint.
    // Anyone in the DHT can connect to another DHT node through a sponsor.
    if (contact.connection) return contact.connection;
    contact.ensureWebRTC(true);
    await this.connection;
    return this.connection;
  }

  async send(message) { // Promise to send through previously opened connection promise.
    let channel = await this.connection;
    if (channel?.readyState === 'open') channel.send(JSON.stringify(message));
    else this.host.xlog('Tried to send on unopen channel on', this.sname, message);
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
  async transmitRPC(messageTag, method, ...rest) { // Must return a promise.
    // this.host.log('transmit to', this.sname, this.connection ? 'with connection' : 'WITHOUT connection');
    const responsePromise = this.getResponsePromise(messageTag);
    await this.send([messageTag, method, ...rest]);
    return await Promise.race([responsePromise, this.rpcTimeout(method), this.closed]);
  }

  async receiveWebRTC(dataString) { // Handle receipt of a WebRTC data channel message that was sent to this contact.
    // The message could the start of an RPC sent from the peer, or it could be a response to an RPC that we made.
    // As we do the latter, we generate and note (in transmitRPC) a message tag included in the message.
    // If we find that in our messageResolvers tags, then the message is a response.
    const [messageTag, ...data] = JSON.parse(dataString);
    await this.receiveRPC(messageTag, ...data);
  }
  async disconnectTransport() {
    if (!this.connection) return;
    super.disconnectTransport();
    Node.delay(100).then(() => { // Allow time for super to send close/bye message.
      this.webrtc?.close();
      this.connection = this.webrtc = this.initiating = null;
    });
  }
}
