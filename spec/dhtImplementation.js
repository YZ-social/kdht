// An example of the control functions needed for testing.

// For running a server
// import express from 'express';
// import http from 'http';
//import { router } from './routes/index.js';

////////////////////////////////////////////////////////////////////////////////////////////////
// This section certainly needs to be modified for any given implementation.
//

// In the present case, these manipulate a Contact that directly contains a
// DHT node with simulated networking.
import { SimulatedConnectionContact as Contact, Node } from '../index.js';
export { Node, Contact };

const info = false; // Whether or not to log basic operations of each node.

export async function serializeAction(contact, action) { // Mutex action(runningContact) against others on the same contact.
  // The contact may be a contact or a promise for one.
  // Returns and sets up inProcess resolution to be result of action, which is usually the next runningContact.
  contact = await contact;
  return contact.inProcess = contact.inProcess.then(action);
}

export async function start1(name, bootstrapContact, refreshTimeIntervalMS, isServerNode = false) {
  const contact = await Contact.create({name, refreshTimeIntervalMS, isServerNode, info});
  contact.creationTimestamp = Date.now();
  contact.inProcess = Promise.resolve(contact);
  if (bootstrapContact) await serializeAction(bootstrapContact, async liveBootstrap => {
    // For client nodes, the bootstrapContact may be thrashing, hence serializeAction.
    await contact.join(bootstrapContact);
    return liveBootstrap;
  });
  return contact;
}

export async function startServerNode(name, bootstrapContact, refreshTimeIntervalMS) {
  Node.refreshTimeIntervalMS = refreshTimeIntervalMS;
  return await start1(name, bootstrapContact, refreshTimeIntervalMS, true);
}

export function stop1(contact) {
  return serializeAction(contact, promised => { promised.disconnect(); return promised; });
}

export async function write1(contact, key, value) {
  // Make a request through contact at index to store value under key in the DHT
  // resolving when ready. (See test suite definitions.)
  // Coordinate with stop1 such that each excludes the other for the duration.
  let stored;
  await serializeAction(contact, async promised => {
    stored = await promised.node.storeValue(key, value);
    promised.host.log('stored', stored, 'copies');
    return promised;
  });
  return stored;
}
export async function read1(contact, key) {
  // Promise the result of requesting key from the DHT through contact.
  let retrieved;
  await serializeAction(contact, async promised => {
    retrieved = await promised.node.locateValue(key);
    if (retrieved === undefined) {
      const now = Date.now();
      const lifetime = now - promised.creationTimestamp;
      promised.host.xlog('could not locate the value at key', key, 'from node joined', lifetime/1e3, 'seconds ago, and having', promised.host.contacts.length, 'contacts, Refreshing buckets and trying again.');
      for (const bucket of promised.host.routingTable.values()) { // Alas, forEachBucket does not await calls on bucket.
	await bucket.refresh();
      }
      retrieved = await promised.node.locateValue(key);
      if (retrieved === undefined) promised.host.xlog('still unable to locate the value at', key);
    }
    return promised;
  });
  return retrieved;
}



////////////////////////////////////////////////////////////////////////////////////////////////
// Given the above, the following might not need to be redefined on a per-implemmentation basis,
// but see pingTimeMS in setupServerNodes().

var contacts = [];
export async function getContacts() {
  // Return a list of contact information for all the nodes.
  // For real implementations this might be a list of node identifiers.
  // It is async because it might be collecting from some monitor/control service.

  // For a simulator in one Javascript instance, it is just the list of Contacts.
  return contacts;
}
function randomInteger(max = contacts.length) {
  // Return a random number between 0 (inclusive) and max (exclusive), defaulting to the number of contacts made.
  return Math.floor(Math.random() * max);
}
export function getRandomLiveContact() {
  // Answer a randomly selected contact (including those for server nodes) that is
  // is not in the process of reconnecting.
  return contacts[randomInteger()];
}
export function getBootstrapContact(nServerNodes, excludingIndex) {
  const index = randomInteger(nServerNodes);
  if (index === excludingIndex) return getBootstrapContact(nServerNodes, excludingIndex);
  return contacts[index];
}

export async function readThroughRandom(index) {
  let value;
  await serializeAction(getRandomLiveContact(), contact => {
    value = read1(contact, index);
    return contact;
  });
  return value;
}

var isThrashing = false;
const thrashers = [];
function thrash(i, nServerNodes, refreshTimeIntervalMS) { // Start disconnect/reconnect timer on contact i.
  // If we are asked to thrash with a zero refreshTimeIntervalMS, average one second anyway.
  const average = Math.max(refreshTimeIntervalMS, 2e3);
  const min = Math.min(average / 2, 2e3);
  const runtimeMS = randomInteger(2 * (average - min)) + min;
  thrashers[i] = setTimeout(async () => {
    if (!isThrashing) return;
    const contacts = await getContacts();
    const contact = contacts[i];
    await serializeAction(contact, async old => {
      const bootstrapContact = getBootstrapContact(nServerNodes);
      await old.disconnect();
      // Because simulations invoke operations directly on the far node of their contacts,
      // we must arrange for the new nodes to be different names/keys so that we don't operate on
      // stale contacts.
      const suffix = parseInt(old.name.split('-')[1] || 0);
      const next = contacts[i] = start1(`${i}-${suffix + 1}`, bootstrapContact, refreshTimeIntervalMS);
      return next;
    });
    thrash(i, nServerNodes, refreshTimeIntervalMS);
  }, runtimeMS);
}
export async function startThrashing(nServerNodes, refreshTimeIntervalMS) {
  console.log('Start thrashing');
  isThrashing = true;
  for (let i = nServerNodes; i < contacts.length; i++) {
    thrash(i, nServerNodes, refreshTimeIntervalMS);
  }
}
export async function stopThrashing() {
  isThrashing = false;
  for (const thrasher of thrashers) clearTimeout(thrasher);
}

async function shutdown(startIndex, stopIndex) { // Internal
  // Shutdown n nodes.
  Node.refreshTimeIntervalMS = 0;
  for (let i = startIndex; i < stopIndex; i++) {
    await stop1(contacts.pop());
  }
}


// const app = express();
// const port = 3000;
// app.set('port', port);
// app.use(express.json());
// //app.use('/test', router);
// app.listen(port);

let ping, transports;
export async function setupServerNodes(nServerNodes, refreshTimeIntervalMS, pingTimeMS, maxTransports) {
  // Set up nServerNodes, returning a promise that resolves when they are ready to use.
  // See definitions in test suite.

  Node.contacts = contacts = []; // Quirk of simulation code.
  transports = Node.maxTransports;
  Node.maxTransports = maxTransports;
  ping = Contact.pingTimeMS;
  Contact.pingTimeMS = pingTimeMS;
  
  for (let i = 0; i < nServerNodes; i++) {
    const node = await startServerNode(i, contacts[i - 1], refreshTimeIntervalMS);
    contacts.push(node);
  }
}
export async function shutdownServerNodes(nServerNodes) {
  // Shut down the specified number of server nodes, resolving when complete.
  // The nServerNodes will match that of the preceding setupServerNodes.
  // The purpose here is to kill any persisted data so that the next call
  // to setupServerNodes will start fresh.
  await shutdown(0, nServerNodes);
  Contact.pingTimeMS = ping;
  Node.maxTransports = transports;
  Node.contacts = [];
}

export async function setupClientsByTime(...rest) {
  // Create as many ready-to-use client nodes as possible in the specified milliseconds.
  // Returns a promise that resolves to the number of clients that are now ready to use.
  return await serialSetupClientsByTime(...rest);
  // Alternatively, one could launch batches of clients in parallel, and then
  // wait for each to complete its probes.
}
async function serialSetupClientsByTime(refreshTimeIntervalMS, nServerNodes, maxClientNodes, runtimeMS, op=start1) {
  // Do setupClientsByTime one client node at a time.
  // It takes longer and longer as the number of existing nodes gets larger.
  return await new Promise(async resolve => {
    const nBootstraps = contacts.length;
    let done = false, index = nBootstraps, count = 0;
    setTimeout(() => done = true, runtimeMS);
    while (!done && (count++ < maxClientNodes)) {
      const bootstrapContact = await getBootstrapContact(nBootstraps);
      const contact = await op(index, bootstrapContact, refreshTimeIntervalMS);
      if (!done) { // Don't include it if we're now over time.
	contacts.push(contact); 
	if (isThrashing) thrash(index, nServerNodes, refreshTimeIntervalMS);
	index++;
      } else {
	await stop1(contact);
      }
    }
    resolve(contacts.length - nBootstraps);
  });
}
export async function shutdownClientNodes(nServerNodes, nClientNodes) {
  await stopThrashing();
  await new Promise(resolve => setTimeout(resolve, 5e3));
  await shutdown(nServerNodes, nClientNodes + nServerNodes);
}
