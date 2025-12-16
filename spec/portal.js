#!/usr/bin/env node
import cluster from 'node:cluster';
import process from 'node:process';
import { spawn } from 'node:child_process'; // For optionally spawning bots.js
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { WebRTC } from '@yz-social/webrtc';
import { WebContact, Node } from '../index.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
      .option('nPortals', {
	alias: 'nportals',	
	alias: 'p',
	type: 'number',
	default: 20,
	description: "The number of steady nodes that handle initial connections."
      })
      .option('nBots', {
	alias: 'nbots',
	alias: 'n',
	type: 'number',
	default: 0,
	description: "If non-zero, spawns bots.js with the given nBots."
      })
      .option('thrash', {
	type: 'boolean',
	default: false,
	description: "Do bots randomly disconnect and reconnect with no memory of previous data?"
      })
      .option('nWrites', {
	alias: 'w',
	alias: "nwrites",
	type: 'number',
	default: 0,
	description: "The number of test writes to check."
      })
      .option('port', {
	type: 'number',
	default: 3000,
	description: "Port on which to run the local bootstrap server."
      })
      .option('verbose', {
	alias: 'v',
	type: 'boolean',
	description: "Run with verbose logging."
      })
      .parse();

// NodeJS cluster forks a group of process that each communicate with the primary via send/message.
// Each fork is a stateful kdht node that can each handle multiple WebRTC connections. The parent runs
// a Web server that handles Post request by sending the data to the specific fork.
// 
// (Some other applications using NodeJS cluster handle stateless requests, so each fork listens directly
// on a shared socket and picks up requests randomly. We do not make use of that shared socket feature.)

if (cluster.isPrimary) { // Parent process with portal webserver through which clienta can bootstrap
  // Our job is to launch some kdht nodes to which clients can connect by signaling through
  // a little web server operated here.
  process.title = 'kdht-portal-server';
  const portals = {}; // Maps worker sname => worker, for the full lifetime of the program. NOTE: MAY get filed in out of order from workers.
  for (let i = 0; i < argv.nPortals; i++) cluster.fork();
  const workers = Object.values(cluster.workers);
  for (const worker of workers) {
    worker.on('message', message => { // Message from a worker, in response to a POST.
      if (!worker.tag) {  // The very first message from a worker (during setup) will identify its tag.
	portals[message] = worker;
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
  
  // Router (two endpoints)
  const app = express();
  const router = express.Router();

  router.get('/name/:label', (req, res, next) => { // Answer the actual sname corresponding to label.
    const label = req.params.label;
    // label can be a worker id, which alas starts from 1.
    const isRandom = label === 'random';
    let list = isRandom ? Object.values(portals) : workers;
    const index = isRandom ? Node.randomInteger(list.length) : label - 1;
    const worker =  list[index];
    if (!worker) return res.sendStatus(isRandom ? 403 : 404);
    return res.json(worker.tag);
  });

  router.post('/join/:from/:to', async (req, res, next) => { // Handler for JSON POST requests.
    // Our WebRTC send [['offer', ...], ['icecandidate', ...], ...]
    // and accept responses of [['answer', ...], ['icecandidate', ...], ...]
    // through multiple POSTS.
    const {params, body} = req;
    // Find the specifed worker, or pick one at random.
    const worker = portals[params.to];
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
  const port = argv.port;
  app.set('port', port);
  app.use(express.json());
  app.use('/kdht', router);
  app.listen(port);
  if (argv.verbose) console.log(process.title, 'listening on', port);
  if (argv.nBots) {    
    await Node.delay(1e3 * argv.nPortals);
    const args = ['spec/bots.js', '--nBots', argv.nBots, '--thrash', argv.thrash || false, '--nWrites', argv.nWrites, '--verbose', argv.verbose || false];
    console.log('spawning node', args.join(' '));
    const bots = spawn('node', args, { shell: true });
    // Slice off the trailing newline of data so that we don't have blank lines after our console adds one more.
    function echo(data) { console.log(data.slice(0, -1).toString()); }
    bots.stdout.on('data', echo);
    bots.stderr.on('data', echo);
  }    

} else { // A portal node through which client's can connect.

  const hostName = uuidv4();
  process.title = 'kdht-portal-' + hostName;
  const contact = await WebContact.create({name: hostName, isServerNode: true, debug: argv.v});
  // Handle signaling that comes as a message from the server.
  process.on('message', async ([senderSname, ...incomingSignals]) => { // Signals from a sender through the server.
    const response = await contact.signals(senderSname, ...incomingSignals);
    process.send([senderSname, ...response]);
  });

  await Node.delay(1e3 * cluster.worker.id); // A worker joins each second.

  process.send(contact.sname); // Report in to server as available for bootstrapping.
  if (cluster.worker.id === 1) {
    // TODO: connect to global network
  } else {
    // TODO: Maybe have server support faster startup by remembering posts that it is not yet ready for?

    const bootstrapName = await contact.fetchBootstrap(cluster.worker.id - 1);
    const bootstrap = await contact.ensureRemoteContact(bootstrapName, 'http://localhost:3000/kdht');
    await contact.join(bootstrap);
  }
}
