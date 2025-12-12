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
  get webrtcLabel() {
    return `@${this.host.contact.sname} ==> ${this.sname}`;
  }
  static serializer = Promise.resolve();
  async connect(forMethod = 'findNodes') { // Connect from host to node, promising a possibly cloned contact that has been noted.
    // Simulates the setup of a bilateral transport between this host and node, including bookkeeping.
    // TODO: Simulate webrtc signaling.
    const contact = this.host.noteContactForTransport(this);
    this.host.log('ensuring connection for', contact.sname, contact.connection ? 'exists' : 'must create');
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
      const ready = connection.signalsReady;
      const dataChannelPromise = connection.ensureDataChannel('kdht');
      await ready;
      connection.connectVia(async signals => {
	const response = await contact.fetchSignals(`http://localhost:3000/kdht/join/${host.contact.sname}/${target || 'random'}`, signals);
	const [method, data] = response[0];
	if (method === 'tag') { // We were told the target tag in a pseudo-signal. Use it going forward.
	  console.warn(`${host.name} connected to target '${data}' instead of '${target}'.`);
	  // KLUGE: When we connect through a portal, we don't yet know the name of the node to which we will connect, but
	  // we do have to keep the contact (in bucket or loose transports). So now that we know the true name, we re-add it.
	  // Note that should not be two overlapping connections in flight to the same target name, including an empty name.
	  const oldKey = contact.node.key;
	  await this.host.removeKey(oldKey); // Serialized operation.
	  target = data;
	  delete contact._sname; // So that it gets re-cached.
	  contact.node.name = data.slice(1); // Name from server always has a leading 'S'.
	  contact.node.key = await Node.key(contact.node.name); // Hashes name.
	  connection.label = contact.webrtcLabel;
	  await this.host.addToRoutingTable(contact); // Serialized operation.
	  response.shift();
	}
	return response;
      });
      const dataChannel = await dataChannelPromise;
      connection.reportConnection(true);
      dataChannel.addEventListener('close', () => {
	console.log(host.name, 'closed connection to', target);
	contact.connection = null;
      });
      dataChannel.addEventListener('message', event => contact.receiveWebRTC(event.data));
      return dataChannel;
    });
  }
  send(message) {
    return this.connection.then(channel => channel.send(JSON.stringify(message)));
  }
  async ensureRemoteContact(sname, connection = null, forceServer = false) {
    if (sname === this.host.contact.sname) return this.host.contact; // ok, not remote, but contacts can send back us in a list of closest nodes.
    let contact = this.host.findContact(contact => contact.sname === sname);
    if (contact) return contact;
    this.host.log(`ensureRemoteContact is creating contact for ${sname} in (${this.sname}) ${this.host.report(null)}.`); // fixme report()
    const isServerNode = sname.startsWith(this.constructor.serverSignifier);
    const name = isServerNode ? sname.slice(1) : sname;
    contact = await this.constructor.create({name, isServerNode}, this.host);
    //if (connection) contact.connection = connection;
    return contact;
  }
  messageTag = 0;
  inFlight = new Map();
  async transmitRPC(method, key, ...rest) { // Must return a promise.
    this.host.log('transmit to', this.sname, this.connection ? 'with connection' : 'WITHOUT connection');
    await this.connect();
    const sender = this.host.contact.sname;
    const messageTag = this.messageTag++;
    const responsePromise = new Promise(resolve => this.inFlight.set(messageTag, resolve));
    this.send([messageTag, method, sender, key.toString(), ...rest]);
    const response = await responsePromise;
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
