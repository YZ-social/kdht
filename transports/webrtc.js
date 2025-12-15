import { v4 as uuidv4 } from 'uuid';
import { Node } from '../dht/node.js';
import { Helper } from '../dht/helper.js';
import { Contact } from './contact.js';
import { WebRTC } from '@yz-social/webrtc';
const { BigInt } = globalThis; // For linters.


export class WebContact extends Contact {
  // Can this set all be done more simply?
  get name() { return this.node.name; }
  get key() { return this.node.key; }
  get isServerNode() { return this.node.isServerNode; }
  get isRunning() { return this.node.isRunning; }

  checkResponse(response) {
    if (!response.ok) throw new Error(`${this.sname} fetch ${response.url} failed ${response.status}: ${response.statusText}.`);
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
  // Within a process, there is only one WebContact.serializer, so each process can only complete one  connection at a time.
  // (It can maintain Node.maxTransports open connections. The serialization is a limit on the connection/signal process.)
  static serializer = Promise.resolve();
  channelName = 'kdht';

  ensureWebRTC(initialSignals) { // If not already configured, sets up contact to have properties:
    // - connection - a promise for an open webrtc data channel:
    //   send(string) puts data on the channel
    //   incomming messages are dispatched to receiveWebRTC(string)
    // - closed - resolves when webrtc closes.
    // - webrtc - an instance of WebRTC (which may be used for webrtc.respond()
    // initialSignals should be a list, or null for the creator of the offer.
    if (this.webrtc) return this.webrtc;

    const webrtc = this.webrtc = new WebRTC({label: this.webrtcLabel});
    let {promise, resolve} = Promise.withResolvers();
    this.closed = promise;
    const dataChannelPromise = webrtc.ensureDataChannel(this.channelName, {}, initialSignals);
    dataChannelPromise.then(dataChannel => {
      webrtc.reportConnection(true);
      dataChannel.addEventListener('close', () => {
	console.log(webrtc.label, 'connection closed');
	this.connection = this.webrtc = null;
	resolve(null);
      });
      dataChannel.addEventListener('message', event => this.receiveWebRTC(event.data));
    });
    return dataChannelPromise;
  }
  connect() { // Connect from host to node, promising a possibly cloned contact that has been noted.
    // Creates a WebRTC instance and uses it's connectVia to to signal.
    const contact = this.host.noteContactForTransport(this);
    //this.host.log('ensuring connection for', contact.sname, contact.connection ? 'exists' : 'must create');
    if (contact.connection) return contact.connection;
    contact.initiating = true;
    //console.log('setting client contact connection promise');
    return contact.connection = contact.constructor.serializer = contact.constructor.serializer.then(async () => { // TODO: do we need this serialization?
      const { host, node, isServerNode, bootstrapHost } = contact;
      // Anyone can connect to a server node using the server's connect endpoint.
      // Anyone in the DHT can connect to another DHT node through a sponsor.
      const dataChannelPromise = contact.ensureWebRTC(null);
      await this.webrtc.signalsReady;
      if (bootstrapHost) {
	const url = `${bootstrapHost || 'http://localhost:3000/kdht'}/join/${this.host.contact.sname}/${this.sname}`;
	await contact.webrtc.connectVia(signals => this.fetchSignals(url, signals))
	  .catch(error => {
	    console.error(contact.webrtc.label, 'failed to connect through server');
	    console.error(error);
	    return null;
	  });
      } else {
	//console.log(host.contact.sname, 'connecting to non-server node', node.name);
	let sponsor = contact.findSponsor(candidate => candidate.connection);
	if (!sponsor) {
	  sponsor = contact.findSponsor(candidate => candidate.isServerNode);
	  if (sponsor) {
	    //console.log(host.contact.sname, 'connecting to server sponsor', sponsor?.sname);
	    await sponsor.connect(); // If it was connected, we would have found it above.
	  }
	}
	if (!sponsor) {
	  console.error(`Cannot reach unsponsored contact ${contact.sname}.`);
	  await contact.host.removeContact(contact);
	  return contact.connection = contact.webrtc = null;
	}
	//console.log(host.contact.sname, 'signaling through', sponsor.sname, 'to', contact.sname, contact.key);
	// All RPCs start with methodName and targetKey.
	// Ultimately, the receiving signals method will then need original senderSname, ...signals.
	await contact.webrtc.connectVia(async signals => sponsor.sendRPC('forwardSignals', contact.key, host.contact.sname, ...signals))
	  .catch(error => {
	    console.error(contact.webrtc.label, 'failed to connect through peer', sponsor.sname);
	    console.error(error);
	    return null;
	  });
      }
      return await dataChannelPromise;
    });
  }
  async signals(senderSname, ...signals) { // Accept directed WebRTC signals from a sender sname, creating if necessary the new contact on
    // host to receive them, and promising a response.
    let contact = await this.ensureRemoteContact(senderSname);
    if (contact.initiating) return []; // TODO: is this the right response?
    if (contact.webrtc) return await contact.webrtc.respond(signals); // TODO: move this and its counterpart on connect to ensureWebRTC?
    this.host.noteContactForTransport(contact);
    contact.connection = contact.ensureWebRTC(signals);
    return await contact.webrtc.respond([]);
  }
  async send(message) { // Promise to send through previously opened connection promise.
    return this.connection.then(channel => channel?.send(JSON.stringify(message))); // Connection could be reset to null
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
      //console.log(this.host.contact.sname, this.host.key, 'received forwardingSignals from', sender.sname, 'on contact', this.sname, this.key, 'concerning', key);
      if (key === this.host.key) { // for us!
	//console.log(this.host.contact.sname, 'processing signals from', sendingSname, signals.map(s => s[0]));
	return this.signals(...rest);
      } else { // Forard to the target.
	const target = this.host.findContactByKey(key);
	if (!target) {
	  //console.log(this.host.contact.same, 'does not have contact to', sendingSname);
	  return null;
	}
	//if (this.debugCounter++ > 3) process.exit(1);
	//console.log(this.host.contact.sname, 'forwarding signals from', sendingSname, signals.map(s => s[0]), 'to target', target.sname, key);
	return target.sendRPC('forwardSignals', key, ...rest);
      }
    }
    return super.receiveRPC(method, sender, key, ...rest);
  }
  //debugCounter = 0;
  inFlight = new Map();
  async transmitRPC(method, key, ...rest) { // Must return a promise.
    // this.host.log('transmit to', this.sname, this.connection ? 'with connection' : 'WITHOUT connection');
    if (!await this.connect()) return null;
    const sender = this.host.contact.sname;
    // uuid so that the two sides don't send a request with the same id to each other.
    // Alternatively, we could concatenate a counter to our host.name.
    const messageTag = uuidv4();
    const responsePromise = new Promise(resolve => this.inFlight.set(messageTag, resolve));
    // this.host.log('sending to', this.sname);
    //console.log(this.host.contact.sname, 'sending', method, key, rest.map(s => Array.isArray(s) ? s[0] : s), 'to', this.sname);
    this.send([messageTag, method, sender, key.toString(), ...rest]);
    const response = await Promise.race([responsePromise, this.closed]);
    // this.host.log('got response from', this.sname);
    return response;
  }
  async receiveWebRTC(dataString) { // Handle receipt of a WebRTC data channel message that was sent to this contact.
    // The message could the start of an RPC sent from the peer, or it could be a response to an RPC that we made.
    // As we do the latter, we generate and note (in transmitRPC) a message tag included in the message.
    // If we find that in our inFlight tags, then the message is a response.
    const [messageTag, ...data] = JSON.parse(dataString);
    const responder = this.inFlight.get(messageTag);
    if (responder) { // A response to something we sent and are waiting for.
      let [result] = data;
      this.inFlight.delete(messageTag);
      //this.host.log('received response', result);
      if (Array.isArray(result)) {
	if (!result.length) responder(result);
	const first = result[0];
	const isSignal = Array.isArray(first) && ['offer', 'answer', 'icecandidate'].includes(first[0]);
	//console.log(this.host.contact.sname, 'got rpc response on contact', this.sname, isSignal, result.map(s => Array.isArray(s) ? s[0] : s));
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
      //this.host.log('dispatched', method, 'from', sender.sname);
      let response = await this.receiveRPC(method, sender, BigInt(key), ...rest);
      //if (method === 'forwardSignals') console.log(this.host.contact.sname, 'incoming signals through', this.sname, 'originating from', rest[0]);
      if ((method !== 'forwardSignals') && this.host.constructor.isContactsResult(response)) {
	response = response.map(helper => [helper.contact.sname, helper.distance.toString()]);
      }
      this.send([messageTag, response]);
    }
  }
  disconnectTransport() {
    this.connection?.close();
  }
}
