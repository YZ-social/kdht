import cluster from 'node:cluster';
import process from 'node:process';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { WebRTC } from '@yz-social/webrtc';
import { WebContact, Node } from '../index.js';

const nBots = 1;

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
  router.post('/join/:from/:to', async (req, res, next) => { // Handler for JSON POST requests.
    // Our WebRTC send [['offer', ...], ['icecandidate', ...], ...]
    // and accept responses of [['answer', ...], ['icecandidate', ...], ...]
    // through multiple POSTS.
    const {params, body} = req;

    // Find the specifed worker, or pick one at random.
    const worker = (params.to === 'random') ?
	  workers[Math.floor(Math.random() * nBots)] :
	  (bots[params.to] || workers[params.to - 1]); // 'to' can be a guid, or worker id, which alas, starts from 1.
    //console.log('post from:', params.from, 'to:', params.to, 'handled by', worker?.id, worker?.tag);

    // Each kdht worker node can handle connections from multiple clients. Specify which one.
    body.unshift(params.from); // Adds sender sname at front of body, so that the worker can direct the message.

    // Pass the POST body to the worker and await the response.
    const response = new Promise(resolve => worker.requestResolvers[params.from] = resolve);
    worker.send(body);
    let responding = await response;
    delete worker.requestResolvers[params.from]; // Now that we have the response.

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

  const hostName = uuidv4();
  process.title = 'portal-' + hostName;
  const contact = await WebContact.create({name: hostName, isServerNode: true
					   , debug: cluster.worker.id === 1 // id starts from 1
					  });
  process.send(contact.sname); // Report in to server.

  // Handle signaling that comes as a message from the server.
  const inFlight = {}; // maps sender sname => WebRTC instance during signaling (i.e., until connected).
  process.on('message', async ([senderSname, ...incomingSignals]) => { // Signals from a sender through the server.
    let webrtc = inFlight[senderSname];
    if (!webrtc) {
      contact.host.log('starting portal connection from', senderSname);
      const requestingContact = await contact.ensureRemoteContact(senderSname);
      contact.host.noteContactForTransport(requestingContact);
      if (requestingContact.connection) { // Can happen if we receive client ICE after we have created data channel.
	contact.host.log('already has a connection from', senderSname);
	process.end([senderSname]); // Just enough for server to clean up.
	return; // Leaks
      }
      webrtc = inFlight[senderSname] = new WebRTC({label: 'p' + requestingContact.webrtcLabel});
      webrtc.contact = requestingContact;
      function cleanup() { // Free for GC.
	console.log(hostName, 'closed connection to', senderSname);
	webrtc.close();
	contact.host.removeKey(webrtc.contact.key);
	delete inFlight[senderSname]; // If not already gone.
      }
      const timer = setTimeout(cleanup, 15e3); // Enough to complete the connection.

      requestingContact.connection = webrtc.ensureDataChannel('kdht', {}, incomingSignals)
	.then(async dataChannel => {
	  clearTimeout(timer);
	  webrtc.reportConnection(true);
	  dataChannel.addEventListener('close', cleanup);
	  dataChannel.addEventListener('message', event => requestingContact.receiveWebRTC(event.data));
	  delete inFlight[senderSname];
	  setTimeout(() => contact.host.report(), 500);
	  return dataChannel;
	});
      incomingSignals = []; // Nothing further to respond() to (below) just yet.
    } else {
      contact.host.log('additional signaling message from', senderSname);
    }
    // Give signals to webrtc, and send response to server for relaying back to remote node.
    const responding = await webrtc.respond(incomingSignals);
    process.send([senderSname, ...responding]);
  });

  if (cluster.worker.id === 1) {
    // TODO: connect to global network
  } else {
    // TODO: Maybe have server support faster startup by remembering posts that it is not yet ready for?
    await new Promise(resolve => setTimeout(resolve, 2e3)); 

    const bootstrap = await contact.ensureRemoteContact('S' + (cluster.worker.id - 1));
    //await bootstrap.connect();
    contact.join(bootstrap);
  }

}
