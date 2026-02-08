import cluster from 'node:cluster';
import express from 'express';
import { Node } from '../index.js';

export const router = express.Router();

// Minimum connections required before a portal node can help others join.
// Genesis node (first node) is exempt since it has no one to connect to initially.
// Once a node has this many connections, it's well-integrated into the mesh.
const MIN_CONNECTIONS_FOR_BOOTSTRAP = 1;

const portals = {}; // Maps worker sname => worker, for the full lifetime of the program. NOTE: MAY get filed in out of order from workers.
function initWorker(worker) {
  worker.on('message', message => { // Message from a worker, in response to a POST.
    // Check if this is a connection count update (format: {type: 'connectionCount', count: N})
    if (message && typeof message === 'object' && message.type === 'connectionCount') {
      worker.connectionCount = message.count;
      return;
    }
    // Check if this is a "ready" message indicating the node has joined
    if (message && typeof message === 'object' && message.type === 'ready') {
      worker.isReady = true;
      worker.connectionCount = message.connectionCount || 0;
      console.log(worker.id - 1, worker.tag, 'ready with', worker.connectionCount, 'connections');
      return;
    }
    if (!worker.tag) {  // The very first message from a worker (during setup) will identify its tag.
      portals[message] = worker;
      worker.tag = message;
      worker.isReady = false; // Not ready until it sends the 'ready' message
      worker.connectionCount = 0;
      worker.requestResolvers = {}; // Maps sender sname => resolve function of a waiting promise in flight.
      console.log(worker.id - 1, message, '(registered, waiting for ready)');
    } else {
      // Each worker can have several simultaneous conversations going. We need to get the message to the correct
      // conversation promise, which we do by calling the resolver that the POST handler is waiting on.
      // Note that requestResolvers are per worker: there can only be one requestResolver pending per worker
      // for each sender.
      const [senderSname, ...signals] = message;
      worker.requestResolvers[senderSname]?.(signals);
    }
  });
}
Object.values(cluster.workers).forEach(initWorker);
cluster.on('exit', (worker, code, signal) => { // Tell us about dead workers and restart them.
  console.error(`\n\n*** Crashed worker ${worker.id}:${worker.tag} received code: ${code} signal: ${signal}. ***\n`);
  delete worker.tag;
  initWorker(cluster.fork());
});

router.get('/name/random', (req, res, next) => { // Answer the actual sname corresponding to label.
  // Only return nodes that are ready (have joined the network) and have sufficient connections.
  // This prevents new nodes from bootstrapping through nodes that aren't yet part of the mesh.
  let readyList = Object.values(portals).filter(w => 
    w.tag && w.isReady && w.connectionCount >= MIN_CONNECTIONS_FOR_BOOTSTRAP
  );
  
  // If no nodes meet the connection threshold, fall back to any ready node (genesis case)
  if (readyList.length === 0) {
    readyList = Object.values(portals).filter(w => w.tag && w.isReady);
  }
  
  // If still no ready nodes, fall back to any registered node (startup case)
  if (readyList.length === 0) {
    readyList = Object.values(portals).filter(w => w.tag);
    if (readyList.length > 0) {
      console.log('Warning: No ready nodes available, falling back to registered nodes');
    }
  }
  
  if (readyList.length === 0) {
    return res.sendStatus(503); // Service unavailable - no workers ready
  }
  
  const index = Node.randomInteger(readyList.length);
  const worker = readyList[index];
  return res.json(worker.tag);
});

router.post('/join/:from/:to', async (req, res, next) => { // Handler for JSON POST requests that provide an array of signals and get signals back.
  // Our WebRTC send [['offer', ...], ['icecandidate', ...], ...]
  // and accept responses of [['answer', ...], ['icecandidate', ...], ...]
  // through multiple POSTS.
  const {params, body} = req;
  // Find the specifed worker, or pick one at random. TODO CLEANUP: Remove. We now use as separate /name/:label to pick one.
  const worker = portals[params.to];
  if (!worker) {
    console.warn('no worker', params.to);
    return res.sendStatus(404);
  }
  if (!worker.tag) {
    console.warn('worker', params.to, 'not signed in yet');
    return res.sendStatus(403);
  }

  // Each kdht worker node can handle connections from multiple clients. Specify which one.
  body.unshift(params.from); // Adds sender sname at front of body.

  // Pass the POST body to the worker and await the response.
  const promise = new Promise(resolve => worker.requestResolvers[params.from] = resolve);
  worker.send(body, undefined, undefined, error => error && console.log(`Error communicating with portal worker ${worker.id}:${worker.tag} ${worker.isConnected() ? 'connected' : 'disconnected'} ${worker.isDead() ? 'dead' : 'running'}:`, error));
  let response = await promise;
  delete worker.requestResolvers[params.from]; // Now that we have the response.

  return res.send(response);
});
