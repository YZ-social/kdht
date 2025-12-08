import { Node } from '../dht/node.js';
import { Contact, SimulatedContact, SimulatedConnectionContact } from './contact.js';
import { WebRTC } from '@yz-social/webrtc';

export class InProcessWebContact extends SimulatedConnectionContact {
  // Still a SimulatedContacConnection, but does create the real bidirectional webrtc connection.
  // Of course, testing requires that there be very few nodes, because:
  // - Each node is running in one instance, so the limited number of WebRTC instances gets used up per process instead of per node.
  // - Each connection takes two in-process WebRTC instances - one for each end.
  static count = 0;
  static serializer = Promise.resolve();
  async connect(forMethod = 'findNodes') { // Connect from host to node, promising a possibly cloned contact that has been noted.
    // Simulates the setup of a bilateral transport between this host and node, including bookkeeping.
    // TODO: Simulate webrtc signaling.
    const contact = this;
    let { host, node, isServerNode } = contact;
    if (contact.webrtc) throw Error('wtf');

    // Anyone can connect to a server node using the server's connect endpoint.
    // Anyone in the DHT can connect to another DHT node through a sponsor.
    if (!isServerNode) {
      let mutualSponsor = null;
      for (const sponsor of this._sponsors.values()) {
	if (!sponsor.hasConnection || !sponsor.node.findContact(this.node.key)?.hasConnection) continue;
	mutualSponsor = sponsor;
      }
      if (!mutualSponsor) return null;
    }
    const farContactForUs = node.ensureContact(host.contact, contact.sponsor);

    // FIXME
    // Just makes the connection and bashes it into place at both ends.
    // Only works because the contact has access to both ends.
    await (this.constructor.serializer = this.constructor.serializer.then(async () => {
      const a = new WebRTC({label: 'initiator' + host.name + '/' + node.name});
      const b = new WebRTC({label: 'contacted' + node.name + '/' + host.name});
      const channelName = 'kdht';
      this.constructor.count += 2;
      const aDataChannelPromise = a.ensureDataChannel(channelName);
      await a.signalsReady;
      const bDataChannelPromise = b.ensureDataChannel(channelName, {}, a.signals);
      await b.signalsReady;
      await a.connectVia(signals => b.respond(signals));
      const aDataChannel = await aDataChannelPromise;
      const bDataChannel = await bDataChannelPromise;
      let onclose = contact => {
	this.constructor.count--;
	//console.log('disconnect', contact.host.name, 'to', contact.node.name, this.constructor.count);
	contact.webrtc = null;
      };
      aDataChannel.addEventListener('close', () => onclose(contact));
      bDataChannel.addEventListener('close', () => onclose(farContactForUs));
      contact.webrtc = a;
      farContactForUs.webrtc = b;
      //console.log(`${host.name}->${node.name}, ${this.constructor.count} webrtc peers`);
    }));

    contact.hasTransport = farContactForUs;
    host.noteContactForTransport(contact);

    farContactForUs.hasTransport = contact;
    node.noteContactForTransport(farContactForUs);
    
    return contact;
  }
  disconnectTransport() {
    this.webrtc?.close();
    super.disconnectTransport();
  }
}
