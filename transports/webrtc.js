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

  async fetchSignals(url, signalsToSend) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signalsToSend)
    });
    return await response.json();
  }
  async fetchBootstrap(label = 'random') {
    const response = await fetch(`http://localhost:3000/kdht/name/${label}`);
    return await response.json();
  }
  get webrtcLabel() {
    return `@${this.host.contact.sname} ==> ${this.sname}`;
  }
  // Within a process, there is only one WebContact.serializer, so each process can only complete one  connection at a time.
  // (It can maintain Node.maxTransports open connections. The serialization is a limit on the connection/signal process.)
  static serializer = Promise.resolve();
  async connect(forMethod = 'findNodes') { // Connect from host to node, promising a possibly cloned contact that has been noted.
    const contact = this.host.noteContactForTransport(this);
    //this.host.log('ensuring connection for', contact.sname, contact.connection ? 'exists' : 'must create');
    if (contact.connection) return contact.connection;

    //console.log('setting client contact connection promise');
    return contact.connection = contact.constructor.serializer = contact.constructor.serializer.then(async () => {
      const { host, node, isServerNode } = contact;
      // Anyone can connect to a server node using the server's connect endpoint.
      // Anyone in the DHT can connect to another DHT node through a sponsor.
      if (!isServerNode) {
	console.log(`\n\n\n*** non-server node ${node.name} ***\n\n`);
	let mutualSponsor = null;
	for (const sponsor of contact._sponsors.values()) {
	  if (!sponsor.hasConnection || !sponsor.node.findContactByKey(contact.node.key)?.hasConnection) continue;
	  mutualSponsor = sponsor;
	}
	if (!mutualSponsor) return null;
      }
      let target = contact.sname;
      //console.log(`starting client signaling ${host.name} => '${target}' (${node.name})`);
      const connection = new WebRTC({label: contact.webrtcLabel});
      let resolveClosed;
      contact.closed = new Promise(resolve => resolveClosed = resolve);
      const ready = connection.signalsReady;
      const dataChannelPromise = connection.ensureDataChannel('kdht');
      await ready;
      await connection.connectVia(signals => contact.fetchSignals(`http://localhost:3000/kdht/join/${host.contact.sname}/${target}`, signals));

      const dataChannel = await dataChannelPromise;
      connection.reportConnection(true);
      dataChannel.addEventListener('close', () => {
	console.log(host.name, 'closed connection to', target);
	contact.connection = null;
	resolveClosed(null);
      });
      dataChannel.addEventListener('message', event => contact.receiveWebRTC(event.data));
      return dataChannel;
    });
  }
  async send(message) { // Promise to send through previously opened connection promise.
    return this.connection.then(channel => channel?.send(JSON.stringify(message))); // Connection could be reset to null
  }
  getName(sname) { // Answer name from sname.
    if (sname.startsWith(this.constructor.serverSignifier)) return sname.slice(1);
    return sname;
  }
  async ensureRemoteContact(sname) {
    if (sname === this.host.contact.sname) return this.host.contact; // ok, not remote, but contacts can send back us in a list of closest nodes.
    let contact = this.host.findContact(contact => contact.sname === sname);
    if (contact) return contact;
    this.host.log(`ensureRemoteContact is creating contact for ${sname} in ${this.sname}.`);
    const name = this.getName(sname);
    const isServerNode = name !== sname;
    contact = await this.constructor.create({name, isServerNode}, this.host);
    return contact;
  }
  inFlight = new Map();
  async transmitRPC(method, key, ...rest) { // Must return a promise.
    // this.host.log('transmit to', this.sname, this.connection ? 'with connection' : 'WITHOUT connection');
    await this.connect();
    const sender = this.host.contact.sname;
    // uuid so that the two sides don't send a request with the same id to each other.
    // Alternatively, we could concatenate a counter to our host.name.
    const messageTag = uuidv4();
    const responsePromise = new Promise(resolve => this.inFlight.set(messageTag, resolve));
    // this.host.log('sending to', this.sname);
    Node.assert(this.connection, 'Connect failed to leave connection', this.connection, 'to', this.report, 'in', this.host.report(null));
    this.send([messageTag, method, sender, key.toString(), ...rest]);
    const response = await Promise.race([responsePromise, this.closed]);
    // this.host.log('got response from', this.sname);
    return response;
  }
  async receiveWebRTC(dataString) {
    const [messageTag, ...data] = JSON.parse(dataString);
    const responder = this.inFlight.get(messageTag);
    if (responder) { // A response to something we sent.
      let [result] = data;
      this.inFlight.delete(messageTag);
      //this.host.log('received response', result);
      if (this.host.constructor.isArrayResult(result)) {
	responder(await Promise.all(result.map(async ([sname, distance]) =>
	  new Helper(await this.ensureRemoteContact(sname), BigInt(distance)))));
      } else {
	responder(result);
      }
    } else { // An incoming request.
      const [method, senderLabel, key, ...rest] = data;
      const sender = await this.ensureRemoteContact(senderLabel);
      //this.host.log('dispatched', method, 'from', sender.sname);
      let response = await this.receiveRPC(method, sender, BigInt(key), ...rest);
      if (this.host.constructor.isArrayResult(response)) response = response.map(helper => [helper.contact.sname, helper.distance.toString()]);
      this.send([messageTag, response]);
    }
  }
  disconnectTransport() {
    this.connection?.close();
  }
}
