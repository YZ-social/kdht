import process from 'node:process';
import cluster from 'node:cluster';
import { v4 as uuidv4 } from 'uuid';
import { WebContact, Node } from '../index.js';

export async function setup({baseURL, externalBaseURL = '', verbose, fixedSpacing, variableSpacing}) {
  const hostName = uuidv4();
  process.title = 'kdht-portal-' + hostName;
  // For debugging:
  // process.on('uncaughtException', error => console.error(hostName, 'Global uncaught exception:', error));
  // process.on('unhandledRejection', error => console.error(hostName, 'Global unhandled promise rejection:', error));

  const contact = await WebContact.create({name: hostName, isServerNode: true, debug: verbose});
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
  const bootstrapName = joinURL && await contact.fetchBootstrap(joinURL);
  const bootstrap = joinURL && await contact.ensureRemoteContact(bootstrapName, joinURL);
  process.send(contact.sname); // Report in to server as available for others to bootstrap through.
  if (bootstrap) await contact.join(bootstrap);
  contact.host.xlog('joined');
  process.on('SIGINT', async () => {
    console.log(process.title, 'Shutdown for Ctrl+C');
    await contact.disconnect();
    process.exit(0);
  });
  return contact;
}
