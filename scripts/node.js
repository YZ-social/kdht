import process from 'node:process';
import cluster from 'node:cluster';
import { v4 as uuidv4 } from 'uuid';
import { WebContact, Node } from '../index.js';

export async function setup({baseURL, externalBaseURL = '', info = true, debug, fixedSpacing, variableSpacing}) {
  const hostName = uuidv4();
  process.title = 'kdht-portal-' + hostName;
  // Enable error logging to capture crashes
  process.on('uncaughtException', error => console.error(hostName, 'Global uncaught exception:', error));
  process.on('unhandledRejection', error => console.error(hostName, 'Global unhandled promise rejection:', error));

  const contact = await WebContact.create({name: hostName, isServerNode: true, info, debug});
  // Handle signaling that comes as a message from the server.
  process.on('message', async ([senderSname, ...incomingSignals]) => { // Signals from a sender through the server.
    const response = await contact.signals(senderSname, ...incomingSignals);
    process.send([senderSname, ...response]);
  });

  await Node.delay(fixedSpacing * 1e3 * cluster.worker.id - 1);

  const isFirst = cluster.worker.id === 1; // The primary/server is 0.
  const joinURL = isFirst ? externalBaseURL : baseURL;

  if (!isFirst) await Node.delay(Node.fuzzyInterval(variableSpacing * 1e3));
  // Determine boostrap BEFORE we send in our own name.
  // Retry fetchBootstrap if it returns empty (server may not be ready yet)
  let bootstrapName = '';
  if (joinURL) {
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries && !bootstrapName; attempt++) {
      if (attempt > 0) {
        console.log(`Worker ${cluster.worker.id}: Retry ${attempt}/${maxRetries} fetching bootstrap...`);
        await Node.delay(2000); // Wait 2 seconds between retries
      }
      bootstrapName = await contact.fetchBootstrap(joinURL);
    }
    if (!bootstrapName) {
      console.warn(`Worker ${cluster.worker.id}: Failed to get bootstrap after ${maxRetries} attempts`);
    }
  }
  const bootstrap = bootstrapName && await contact.ensureRemoteContact(bootstrapName, joinURL);
  
  // Register our sname with the router first (so we can receive signals)
  process.send(contact.sname);
  
  // Join the network
  if (bootstrap) await contact.join(bootstrap);
  
  // Now report that we're ready with our connection count
  // This tells the router we can help other nodes join
  const connectionCount = contact.host.nConnections;
  process.send({ type: 'ready', connectionCount });
  
  // Periodically report connection count so router can make informed decisions
  setInterval(() => {
    process.send({ type: 'connectionCount', count: contact.host.nConnections });
  }, 10000); // Every 10 seconds
  
  process.on('SIGINT', async () => {
    console.log(process.title, 'Shutdown for Ctrl+C');
    await contact.disconnect();
    process.exit(0);
  });
  return contact;
}
