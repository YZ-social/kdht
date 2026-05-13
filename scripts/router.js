import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import cluster from 'node:cluster';
import express from 'express';
import cors from 'cors';
import { createServer as turnServer } from 'turn-server';
import NodeTurn from 'node-turn';

// The /name and /join routes are configured here to provide preflight approval from any site, allowing web apps
// at mirrors to reach the dht through this portal if the originating mirror goes down, and vice versa. Note that non-browser
// apps can always do so, as CORS does not block requests, but rather it blocks browser code from using the responses
// unless allowed here.

export const router = express.Router();

const portals = {}; // Maps worker sname => worker, for the full lifetime of the program. NOTE: MAY get filed in out of order from workers.
function initWorker(worker) {
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
export function initWorkers() {
  Object.values(cluster.workers).forEach(initWorker);
}
cluster.on('exit', (worker, code, signal) => { // Tell us about dead workers and restart them.
  console.error(`\n\n*** Crashed worker ${worker.id}:${worker.tag} received code: ${code} signal: ${signal}. ***\n`);
  delete worker.tag; // So that it isn't used by /name/random.
  initWorker(cluster.fork());
});

router.options('/name/random', cors()); // Handle preflight.
router.post('/name/random', cors(), (req, res, next) => { // Answer the actual sname corresponding to label.
  // Even though there's no body, we use post here to help bust service worker caching
  let worker;
  // We might grab a worker from custer.workers that has not yet reporte in (setting worker.tag).
  // Dead workers are eventually removed from cluster.workers, but one might catch it before then.
  while (!worker?.tag) {
    let list = Object.values(portals);
    const index = Math.floor(Math.random() * list.length);
    worker = list[index];
    if (!worker) return res.sendStatus(403);
  }
  return res.json(worker.tag);
});

router.options('/join/:from/:to', cors()); // Handle preflight.
router.post('/join/:from/:to', cors(), async (req, res, next) => { // Handler for JSON POST requests that provide an array of signals and get signals back.
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

// Run a TURN server on the default port (3478).
const externalIp = await fetch('https://api.ipify.org?format=text').then(response => response.text());
const internalIp = Object.values(os.networkInterfaces()).flat().find(datum => !datum.internal && datum.family === 'IPv4').address;
async function getConf(filename, defaults) { // Tries to find filename in current working directory, else defaults.
  const config = await import(path.resolve(filename))
    .catch(error => {
      if (error.code === 'ERR_MODULE_NOT_FOUND') return {default: defaults};
      throw error;
    });
  console.log({internalIp, externalIp, config: config.default});
  return config.default;
}
if (true) { // Experimenting between two implmentations.
  const conf = await getConf('node-turn-conf.js', {
    externalIps: [externalIp],
    //minPort: 51021, maxPort: 61000, // Avoiding conflicts on the AT&T BRG320 Gateway
    authMech: 'none',
    // authMech: 'long-term',
    // realm: 'yz',
    // credentials: {dummy: 'junk'},
    debugLevel: 'info'
  });
  const server = new NodeTurn(conf);
  server.start();

} else {
  const conf = await getConf('turn-server-conf.js', {
    auth: {
      mechanism: 'none'
      // mechanism: 'long-term',
      // realm: 'yz',
      // credentials: { dummy: 'junk' }
    },
    relay: {
      externalIp,
      //portRange: [51021, 61000] // Avoiding confict on the AT&T BRG320 Gateway
    }
  });
  const server = turnServer(conf);
  function handle (name) {
    server.on(name, (...args) => {
      console.log(new Date(), name, ...args);
      const f = args.find(a => typeof(a) === 'function');
      if (f) f(true);
    });
  }
  // [
  //   'listening', 'accept', 'authenticate', 'authorize', 'quota', 'beforeAllocate', 'beforeRefresh', 'beforePermission', 'beforeChannelBind', 'beforeConnect', 'beforeRelay', 'beforeData', 'redirect',
  //   //'onRelayed',
  //  // 'allocate', 'relay', 'message', 'refresh', 'allocate:expired', 'permission', 'channel', 'error', 'data', 'change_request', 'connect_peer', 'connection_bind', 'success', 'error_response', 'timeout', 'contextChanged', 'close'
  // ].forEach(handle);
  server.listen({ port: 3478 });
}
router.get('/turnURL', cors(), (req, res, next) => { // Answer a turn: url that tries to use IP address so as to avoid "realm" issues.
  res.json(`turn:${req.hostname === 'localhost' ? internalIp : externalIp}:3478?transport=udp`);
});


// post node stats and "get" all node stats, but getting uses post in case an application caches all get in a service worker.
const stats = {}; // tag => nodeStatistics
router.options('/stats/:tag', cors());
router.post('/stats/:tag', cors(), (req, res, next) => {
  const data = stats[req.params.tag] = req.body;
  data.issuedTime = Date.now();
  res.sendStatus(200);
});
router.options('/stats', cors());
router.post('/stats', cors(), (req, res, next) => {
  const staleTime = Date.now() - 15e3; // purge stale items
  for (const key in stats) {
    if (stats[key].issuedTime < staleTime) delete stats[key];
  }
  res.send(stats);
});
