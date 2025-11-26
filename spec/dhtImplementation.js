// An example of the control functions needed for testing.

///////////////////////////////////////////////////////////////////////////////////////////////////////
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
  let contact = await Contact.create({name, refreshTimeIntervalMS, isServerNode: true});  // Create each node one a time.
  if (bootstrapContact) await contact.join(bootstrapContact); // Joining through the previous one.
  return contact;
  }

export async function write1(contact, key, value) {
  // Make a request through contact to store value under key in the DHT
  // resolving when ready. (See test suite definitions.)
  await contact.node.storeValue(key, value);
}
export async function read1(contact, key) {
  // Promise the result of requesting key from the DHT through contact.
  return await contact.node.locateValue(key);
}



///////////////////////////////////////////////////////////////////////////////////////////////////////
// Given the above, the following probably do NOT need to be redefined on a per-implemmentation basis.
//

var contacts = [];
export async function getContacts() {
  // Return a list of contact information for all the nodes.
  // For real implementations this might be a list of node identifiers.
  // It is async because it might be collecting from some monitor/control service.

  // For a simulator in one Javascript instance, it is just the list of Contacts.
  return contacts;
}

async function shutdown(n) {
  // Shutdown n nodes.
  for (let i = 0; i < n; i++) await contacts.pop().disconnect();
}

export async function setupServerNodes(nServerNodes, refreshTimeIntervalMS) {
  // Set up nServerNodes, returning a promise that resolves when they are ready to use.
  // See definitions in test suite.

  Node.contacts = contacts = []; // Quirk of simulation code.
  const isServerNode = true;
  
  for (let i = 0; i < nServerNodes; i++) {
    const name = i;
    const bootstrapContact = contacts[i - 1];
    let contact = await startServerNode(name, bootstrapContact, refreshTimeIntervalMS);
    contacts.push(contact);                         // Keeping track for use by getContacts.
  }
}
export async function shutdownServerNodes(nServerNodes) {
  // Shut down the specified number of server nodes, resolving when complete.
  // The nServerNodes will match that of the preceding setupServerNodes.
  // The purpose here is to kill any persisted data so that the next call
  // to setupServerNodes will start fresh.
  await shutdown(nServerNodes);
}

export async function setupClientsByTime(timeMS) {
  // Create as many ready-to-use client nodes as possible in the specified milliseconds.
  // Returns a promise that resolves to the number of clients that are now ready to use.
  return await serialSetupClientsByTime(timeMS);
  // Alternatively, one could launch batches of clients in parallel, and then
  // wait for each to complete its probes.
}
async function serialSetupClientsByTime(timeMS) {
  // Do setupClientsByTime one client node at a time.
  // In this implementation, Contact.create().then(contact => join()) does
  // not resolve until the client has probed the network and is now ready to use.
  // It takes longer and longer as the number of existing nodes gets larger.
  return await new Promise(async resolve => {
    const nBootstraps = contacts.length;
    let done = false, index = nBootstraps;
    setTimeout(() => done = true, timeMS);
    let counter = 0;
    while (!done) {
      //const bootstrapIndex = counter++ % nBootstraps; // FIXME restore Math.floor(Math.random() * nBootstraps);
      const bootstrapIndex = Math.floor(Math.random() * nBootstraps);
      const bootstrapContact = contacts[bootstrapIndex];
      const contact = await start1(index++, bootstrapContact, timeMS);
      if (!done) contacts.push(contact); // Don't include it if we're over time.
      else await contact.disconnect();
    }
    resolve(contacts.length - nBootstraps);
  });
}
export async function shutdownClientNodes(nClientNodes) {
  await shutdown(nClientNodes);
}
