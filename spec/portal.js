import cluster from 'node:cluster';
import process from 'node:process';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { WebRTC } from '@yz-social/webrtc';
import { WebContact, Node } from '../index.js';

const nBots = 3;

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
	console.log('set worker', worker.id, 'tag', message);
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
    const worker = (params.to === 'random') ?
	  workers[Math.floor(Math.random() * nBots)] :
	  (bots[params.to] || workers[params.to - 1]); // to can be a guid, or worker id, which alas, starts from 1.
    console.log('post from:', params.from, 'to:', params.to, 'handled by', worker?.id, worker?.tag);
    // Each kdht worker node can handle connections from multiple clients. Specify which one.
    body.unshift(params.from);
    const response = new Promise(resolve => worker.conversations[params.from] = resolve);
    worker.send(body);
    let responding = await response;
    delete worker.conversations[params.from]; // Now that we have the response.
    // If needed, let the client know who they are talking to so later posts go to the right worker.
    if (params.to !== worker.tag) responding = [['tag', worker.tag], ...responding];
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
  const contact = await WebContact.create({name: host, isServerNode: true, debug: cluster.worker.id === 1});
  process.send(contact.sname); // Report in to server.
  //console.log(cluster.worker.id, contact.sname);

  // Handle signaling that comes as a message from the server.
  const inFlight = {};
  process.on('message', async ([target, ...incomingSignals]) => {
    let webrtc = inFlight[target];
    if (!webrtc) {
      console.log('\n    starting portal connection at', contact.sname, 'from', target);
      webrtc = inFlight[target] = new WebRTC({label: 'portal-' + host});
      const requestingContact = await contact.ensureRemoteContact(target);

      const timer = setTimeout(() => { webrtc.close(); delete inFlight[target]; }, 15e3); // Enough to complete the connection.
      console.log('    setting portal contact connection to promise');
      requestingContact.connection = webrtc.ensureDataChannel('kdht', {}, incomingSignals)
	.then(async dataChannel => {
	  console.log('    portal got data channel');
	  clearTimeout(timer);
	  webrtc.reportConnection(true);
	  dataChannel.addEventListener('close', () => {
	    console.log(host, '    closed connection to', target);
	    webrtc.close();
	  });
	  dataChannel.onmessage = event => requestingContact.receiveWebRTC(event.data);
	  delete inFlight[target];
	  return dataChannel;
	});
      incomingSignals = []; // Nothing further to respond() to just yet.
    }
    // Give signals to webrtc, and send response to server for relaying back to remote node.
    const responding = await webrtc.respond(incomingSignals);
    process.send([target, ...responding]);
  });

  // TODO: if id === 1, connect to global network
  if (cluster.worker.id > 1) {
    await new Promise(resolve => setTimeout(resolve, 2e3));
    const bootstrap = await contact.ensureRemoteContact('S' + (cluster.worker.id - 1));
    //await bootstrap.connect();
    contact.join(bootstrap);
  }

}
