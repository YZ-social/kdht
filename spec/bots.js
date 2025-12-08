import cluster from 'node:cluster';
import process from 'node:process';
import { v4 as uuidv4 } from 'uuid';
import { WebRTC } from '@yz-social/webrtc';
const nBots = 10;

const host = uuidv4();
process.title = 'kdhtbot-' + host;

if (cluster.isPrimary) {
  for (let i = 1; i < nBots; i++) {
    cluster.fork();
  }
}
async function fetchSignals(url, signalsToSend) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signalsToSend)
  });
  return await response.json();
}

await new Promise(resolve => setTimeout(resolve, 2e3));

const connection = new WebRTC({label: 'client-' + host});
const ready = connection.signalsReady;
const dataChannelPromise = connection.ensureDataChannel('kdht');
let target = 'random';
await ready;
connection.connectVia(async signals => {
  const response = await fetchSignals(`http://localhost:3000/kdht/join/${host}/${target}`, signals);
  const [method, data] = response[0];
  if (method === 'tag') { // We were told the target tag in a pseudo-signal. Use it going forward.
    target = data;
    response.shift();
  }
  return response;
});
const dataChannel = await dataChannelPromise;
connection.reportConnection(true);
dataChannel.addEventListener('close', () => console.log(host, 'closed connection to', target));
