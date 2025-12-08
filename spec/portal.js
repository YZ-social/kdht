import cluster from 'node:cluster';
import process from 'node:process';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { WebRTC } from '@yz-social/webrtc';
const nBots = 10;

// NodeJS cluster forks a group of process that each communicate with the primary via send/message.
// Each fork is a stateful kdht node that can each handle multiple WebRTC connections. The parent runs
// a Web server that handles Post request by sending the data to the specific fork.
// 
// (Some other applications using NodeJS cluster handle stateless requests, so each fork listens directly
// on a shared socket and picks up requests randomly. We do not make use of that shared socket feature.)

if (cluster.isPrimary) {

  // Our job is to launch some kdht nodes to which clients can connect by signaling through
  // a little web server operated here.
  process.title = 'portal-server';
  const bots = {};
  for (let i = 0; i < nBots; i++) cluster.fork();
  const workers = Object.values(cluster.workers);
  for (const worker of workers) {
    worker.on('message', message => {
      if (!worker.tag) {  // The very first message from a worker will identify it's tag.
	bots[message] = worker;
	worker.tag = message;
	worker.conversations = {};
      } else {
	// Each worker can have several simultaneous conversations going. We need to get the message to the correct
	// conversation promise, which we do by calling the resolver that the POST handler is waiting on.
	const [sender, ...signals] = message;
	worker.conversations[sender](signals);
      }
    });
  }
  
  // Router
  const app = express();
  const router = express.Router();
  const connections = {};
  router.post('/join/:from/:to', async (req, res, next) => { // Handler for JSON POST requests.
    // Our WebRTC send [['offer', ...], ['icecandidate', ...], ...]
    // and accept responses of [['answer', ...], ['icecandidate', ...], ...]
    // through multiple POSTS.
    const {params, body} = req;
    // Find the specifed worker, or pick one at random.
    const worker = (params.to === 'random') ? workers[Math.floor(Math.random() * nBots)] : bots[params.to];
    // Each kdht worker node can handle connections from multiple clients. Specify which one.
    body.unshift(params.from);
    const response = new Promise(resolve => worker.conversations[params.from] = resolve);
    worker.send(body);
    let responding = await response;
    delete worker.conversations[params.from];
    // If needed, let the client know who they are talking to so later posts go to the right worker.
    if (params.to === 'random') responding = [['tag', worker.tag], ...responding];
    res.send(responding);
  });

  // Portal server
  const port = 3000;
  app.set('port', port);
  app.use(express.json());
  app.use('/kdht', router);
  app.listen(port);
  console.log('listening on', port);

} else { // A bot through which client's can connect.

  const host = uuidv4();
  process.title = 'portal-' + host;
  const connections = {};
  process.send(host);
  process.on('message', async ([target, ...incomingSignals]) => {
    let connection = connections[target];
    //console.log('bot incoming from', target, 'to', host, connection?.peer.iceGatheringState, incomingSignals.map(s => s[0]));
    if (!connection) {
      connection = connections[target] = new WebRTC({label: 'portal-' + host});
      const timer = setTimeout(() => { connection.close(); delete connections[target]; }, 15e3); // Enough to complete the connection.
      const dataPromise = connection.dataChannelPromise = connection.ensureDataChannel('kdht', {}, incomingSignals);
      incomingSignals = []; // Nothing further to respond() to just yet.
      dataPromise.then(dataChannel => {
	clearTimeout(timer);
	connection.reportConnection(true);
	dataChannel.addEventListener('close', () => {
	  console.log(host, 'closed connection to', target);
	  connection.close();
	  delete connections[target];
	});
	dataChannel.onmessage = event => dataChannel.send(event.data); // FIXME
      });
    }
    const responding = await connection.respond(incomingSignals);
    process.send([target, ...responding]);
  });
}
