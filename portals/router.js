import cluster from 'node:cluster';
import express from 'express';
import { Node } from '../index.js';

export const router = express.Router();

const portals = {}; // Maps worker sname => worker, for the full lifetime of the program. NOTE: MAY get filed in out of order from workers.
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
      worker.requestResolvers[senderSname]?.(signals);
    }
  });
}
cluster.on('exit', (worker, code, signal) => { // Tell us about dead workers.
  console.error(`\n\n*** Crashed worker ${worker.id}:${worker.tag} received code: ${code} signal: ${signal}. ***\n`);
});

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
