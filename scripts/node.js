import process from 'node:process';
import cluster from 'node:cluster';
import { v4 as uuidv4 } from 'uuid';
import { WebContact, Node } from '../index.js';

export async function setup({baseURL, externalBaseURL = '', info = true, debug, fixedSpacing, variableSpacing}) {
  const hostName = uuidv4();
  process.title = 'kdht-portal-' + hostName;
  // For debugging:
  // process.on('uncaughtException', error => console.error(hostName, 'Global uncaught exception:', error));
  // process.on('unhandledRejection', error => console.error(hostName, 'Global unhandled promise rejection:', error));

  const contact = await WebContact.create({name: hostName, isServerNode: true, info, debug});
  // Handle signaling that comes as a message from the server.
  process.on('message', async ([senderSname, ...incomingSignals]) => { // Signals from a sender through the server.
    const response = await contact.signals(senderSname, ...incomingSignals);
    process.send([senderSname, ...response]);
  });

  // Cap startup delay so replacement workers (high IDs) don't wait excessively.
  const startupDelay = fixedSpacing * 1e3 * Math.min(cluster.worker.id, 15) - 1;
  await Node.delay(startupDelay);

  const isFirst = cluster.worker.id === 1; // The primary/server is 0.
  const joinURL = isFirst ? externalBaseURL : baseURL;

  if (!isFirst) await Node.delay(Node.fuzzyInterval(variableSpacing * 1e3));
  // Determine bootstrap BEFORE we send in our own name.
  let bootstrapName = joinURL && await contact.fetchBootstrap(joinURL);
  process.send(contact.sname); // Report in to server as available for others to bootstrap through.
  // Bootstrap: retry with different random targets until we get a connection.
  if (joinURL) {
    for (let attempt = 0; !contact.host.connections.length; attempt++) {
      if (attempt) {
	contact.host.flog(`Bootstrap attempt ${attempt} to ${bootstrapName} failed, retrying with another target.`);
	await Node.delay(5e3);
	bootstrapName = await contact.fetchBootstrap(joinURL);
      }
      if (!bootstrapName) continue;
      const bootstrap = await contact.ensureRemoteContact(bootstrapName, joinURL);
      await contact.join(bootstrap);
    }
  }
  process.on('SIGINT', async () => {
    console.log(process.title, 'Shutdown for Ctrl+C');
    await contact.disconnect();
    process.exit(0);
  });
  return contact;
}
