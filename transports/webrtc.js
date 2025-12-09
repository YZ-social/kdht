import { Node } from '../dht/node.js';
import { WebRTC } from '@yz-social/webrtc';


export class WebContact {
  constructor({node, host = node, ...rest}) {
    Object.assign(this, {node, host, ...rest});
  }
  async fetchSignals(url, signalsToSend) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signalsToSend)
    });
    return await response.json();
  }
  static serializer = Promise.resolve();
  async connect(forMethod = 'findNodes') { // Connect from host to node, promising a possibly cloned contact that has been noted.
    // Simulates the setup of a bilateral transport between this host and node, including bookkeeping.
    // TODO: Simulate webrtc signaling.
    let { host, node, isServerNode } = this;
    if (this.webrtc) throw Error('wtf');

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

    await (this.constructor.serializer = this.constructor.serializer.then(async () => {
      const connection = new WebRTC({label: 'client-' + host});
      const ready = connection.signalsReady;
      const dataChannelPromise = connection.ensureDataChannel('kdht');
      let target = 'random';
      await ready;
      connection.connectVia(async signals => {
	const response = await this.fetchSignals(`http://localhost:3000/kdht/join/${host}/${target}`, signals);
	const [method, data] = response[0];
	if (method === 'tag') { // We were told the target tag in a pseudo-signal. Use it going forward.
	  target = data;
	  response.shift();
	}
	return response;
      });
      const dataChannel = await dataChannelPromise;
      connection.reportConnection(true);
      this.webrtc = connection;
      // fixme message
      dataChannel.addEventListener('close', () => {
	console.log(host, 'closed connection to', target);
	this.webrtc = null;
      });
    }));
    return this;
  }
  disconnectTransport() {
    this.webrtc?.close();
  }
}
