import process from 'node:process';
import cluster from 'node:cluster';
import { v4 as uuidv4 } from 'uuid';
import { WebContact, Node } from '../index.js';

export async function setup({baseURL, externalBaseURL = '', info = true, debug, fixedSpacing, variableSpacing}) {
  // For debugging:
  // process.on('uncaughtException', error => console.error(hostName, 'Global uncaught exception:', error));
  // process.on('unhandledRejection', error => console.error(hostName, 'Global unhandled promise rejection:', error));

  let contact = await WebContact.create({isServerNode: true, info, debug});
  process.title = 'kdht-portal-' + contact.name;

  // Handle signaling that comes as a message from the server.
  process.on('message', async ([senderSname, ...incomingSignals]) => { // Signals from a sender through the server.
    const response = await contact.signals(senderSname, ...incomingSignals);
    process.send([senderSname, ...response]);
  });

  await Node.delay(fixedSpacing * 1e3 * cluster.worker.id - 1);

  const isFirst = cluster.worker.id === 1; // The primary/server is 0.
  const joinURL = isFirst ? externalBaseURL : baseURL;
  if (joinURL) {
    await Node.delay(Node.fuzzyInterval(variableSpacing * 1e3));
    await Promise.race([contact.connect(joinURL), Node.delay(4e3)]);
  } else {
    contact.attached(contact);
    Node.publishStatistics = contact.baseURL = baseURL;
  }
  process.send(contact.sname); // Report in to server as available for others to bootstrap through.

  process.on('SIGINT', async () => {
    console.log(process.title, 'Shutdown for Ctrl+C');
    await contact.disconnect();
    process.exit(0);
  });
  return contact;
}
