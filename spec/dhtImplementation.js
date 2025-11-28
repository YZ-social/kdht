// An example of the control functions needed for testing.

////////////////////////////////////////////////////////////////////////////////////////////////
// This section certainly needs to be modified for any given implementation.
//

// In the present case, these manipulate a Contact that directly contains a
// DHT node with simulated networking.
import { SimulatedConnectionContact as Contact, Node } from '../index.js';

export async function start1(name, bootstrapContact, refreshTimeIntervalMS, isServerNode = false) {
  const contact = await Contact.create({name, refreshTimeIntervalMS, isServerNode});
  if (bootstrapContact) await contact.join(bootstrapContact);
  return contact;
}

export async function startServerNode(name, bootstrapContact, refreshTimeIntervalMS) {
  return await start1(name, bootstrapContact, refreshTimeIntervalMS, true);
}

export async function stop1(contact) {

  // For debugging: Report if we're killing the last holder of our data.
  // This is fine for simulations, but some decentralized reporting would be needed for real systems.
  // if (contact && isThrashing) {
  //   for (const key of contact.node.storage.keys()) {
  //     let remaining = [];
  //     for (const contact of contacts) {
  // 	if (contact?.isConnected && contact.node.storage.has(key)) remaining.push(contact.node.name);
  //     }
  //     if (!remaining.length) console.log(`Disconnecting ${contact.node.name}, last holder of ${key}: ${contact.node.storage.get(key)}.`);
  //   }
  // }

  return await contact?.disconnect();
}

export async function write1(contact, key, value) {
  // Make a request through contact to store value under key in the DHT
  // resolving when ready. (See test suite definitions.)
  return await contact.node.storeValue(key, value);
}
export async function read1(contact, key) {
  // Promise the result of requesting key from the DHT through contact.
  return await contact.node.locateValue(key);
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
export async function getRandomLiveContact() {
  // Answer a randomly selected contact (including those for server nodes) that is
  // is not in the process of reconnecting.
  return contacts[randomInteger()] || await getRandomLiveContact();
}
export async function getBootstrapContact(nServerNodes) {
  return contacts[randomInteger(nServerNodes)];
}

var isThrashing = false;
const thrashers = [];
function thrash(i, nServerNodes, refreshTimeIntervalMS) { // Start disconnect/reconnect timer on contact i.
  // If we are asked to thrash with a zero refreshTimeIntervalMS, average one second anyway.
  const runtimeMS = randomInteger(2 * (refreshTimeIntervalMS || 2e3));
  thrashers[i] = setTimeout(async () => {
    if (!isThrashing) return;
    const contact = contacts[i];
    contacts[i] = null;
    await stop1(contact);
    const bootstrapContact = await getBootstrapContact(nServerNodes);
    contacts[i] = await start1(i, bootstrapContact, refreshTimeIntervalMS);
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
  for (let i = startIndex; i < stopIndex; i++) {
    await stop1(contacts.pop());
  }
}

export async function setupServerNodes(nServerNodes, refreshTimeIntervalMS, pingTimeMS) {
  // Set up nServerNodes, returning a promise that resolves when they are ready to use.
  // See definitions in test suite.

  Node.contacts = contacts = []; // Quirk of simulation code.
  Contact.pingTimeMS = pingTimeMS;
  
  for (let i = 0; i < nServerNodes; i++) {
    contacts.push(await startServerNode(i, contacts[i - 1], refreshTimeIntervalMS));
  }
}
export async function shutdownServerNodes(nServerNodes) {
  // Shut down the specified number of server nodes, resolving when complete.
  // The nServerNodes will match that of the preceding setupServerNodes.
  // The purpose here is to kill any persisted data so that the next call
  // to setupServerNodes will start fresh.
  await shutdown(0, nServerNodes);
}

export async function setupClientsByTime(...rest) {
  // Create as many ready-to-use client nodes as possible in the specified milliseconds.
  // Returns a promise that resolves to the number of clients that are now ready to use.
  return await serialSetupClientsByTime(...rest);
  // Alternatively, one could launch batches of clients in parallel, and then
  // wait for each to complete its probes.
}
async function serialSetupClientsByTime(refreshTimeIntervalMS, nServerNodes, maxClientNodes, runtimeMS) {
  // Do setupClientsByTime one client node at a time.
  // It takes longer and longer as the number of existing nodes gets larger.
  return await new Promise(async resolve => {
    const nBootstraps = contacts.length;
    let done = false, index = nBootstraps, count = 0;
    setTimeout(() => done = true, runtimeMS);
    while (!done && (!maxClientNodes || (count++ < maxClientNodes))) {
      const bootstrapContact = await getBootstrapContact(nBootstraps);
      const contact = await start1(index, bootstrapContact, refreshTimeIntervalMS);
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
  await shutdown(nServerNodes, nClientNodes + nServerNodes);
}
