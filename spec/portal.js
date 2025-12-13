import cluster from 'node:cluster';
import process from 'node:process';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { WebRTC } from '@yz-social/webrtc';
import { WebContact, Node } from '../index.js';

const nBots = 20;

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
  const bots = {}; // Maps worker sname => worker, for the full lifetime of the program.
  for (let i = 0; i < nBots; i++) cluster.fork();
  const workers = Object.values(cluster.workers);
  for (const worker of workers) {
    worker.on('message', message => { // Message from a worker, in response to a POST.
      if (!worker.tag) {  // The very first message from a worker (during setup) will identify its tag.
	bots[message] = worker;
	worker.tag = message;
	worker.requestResolvers = {}; // Maps sender sname => resolve function of a waiting promise in flight.
	console.log(worker.id - 1, message);
      } else {
	// Each worker can have several simultaneous conversations going. We need to get the message to the correct
	// conversation promise, which we do by calling the resolver that the POST handler is waiting on.
	// Note that requestResolvers are per worker: there can only be one requestResolver pending per worker
	// for each sender.
	const [senderSname, ...signals] = message;
	worker.requestResolvers[senderSname](signals);
      }
    });
  }
  
  // Router
  const app = express();
  const router = express.Router();

  router.get('/name/:label', (req, res, next) => { // Answer the actual sname corresponding to label.
    const label = req.params.label;
    // label can be a worker id, which alas starts from 1.
    const index = (label === 'random') ? Math.floor(Math.random() * nBots) : label - 1;
    const worker =  workers[index];
    res.json(worker.tag);
  });

  router.post('/join/:from/:to', async (req, res, next) => { // Handler for JSON POST requests.
    // Our WebRTC send [['offer', ...], ['icecandidate', ...], ...]
    // and accept responses of [['answer', ...], ['icecandidate', ...], ...]
    // through multiple POSTS.
    const {params, body} = req;
    // Find the specifed worker, or pick one at random.
    const worker = bots[params.to];
    //console.log('post from:', params.from, 'to:', params.to, 'handled by', worker?.id, worker?.tag);
    if (!worker) return res.sendStatus(404);
    if (!worker.tag) return res.sendStatus(403);

    // Each kdht worker node can handle connections from multiple clients. Specify which one.
    body.unshift(params.from); // Adds sender sname at front of body.

    // Pass the POST body to the worker and await the response.
    const promise = new Promise(resolve => worker.requestResolvers[params.from] = resolve);
    worker.send(body);
    let response = await promise;
    delete worker.requestResolvers[params.from]; // Now that we have the response.

    return res.send(response);
  });

  // Portal server
  const port = 3000;
  app.set('port', port);
  app.use(express.json());
  app.use('/kdht', router);
  app.listen(port);
  console.log('listening on', port);

} else { // A bot through which client's can connect.

  const hostName = uuidv4();
  process.title = 'portal-' + hostName;
  const contact = await WebContact.create({name: hostName, isServerNode: true
					   , debug: cluster.worker.id === 1 // id starts from 1
					  });
  // Handle signaling that comes as a message from the server.
  process.on('message', async ([senderSname, ...incomingSignals]) => { // Signals from a sender through the server.
    const response = await contact.signals(senderSname, ...incomingSignals);
    process.send([senderSname, ...response]);
  });

  process.send(contact.sname); // Report in to server.
  if (cluster.worker.id === 1) {
    // TODO: connect to global network
  } else {
    // TODO: Maybe have server support faster startup by remembering posts that it is not yet ready for?
    await new Promise(resolve => setTimeout(resolve, 2e3)); 

    const bootstrapName = await contact.fetchBootstrap(cluster.worker.id - 1);
    const bootstrap = await contact.ensureRemoteContact(bootstrapName);
    contact.join(bootstrap);
  }

}
