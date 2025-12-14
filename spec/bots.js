import cluster from 'node:cluster';
import process from 'node:process';
import { v4 as uuidv4 } from 'uuid';
import { WebContact, Node } from '../index.js';
const nBots = 2;

const host = uuidv4();
process.title = 'kdhtbot-' + host;

if (cluster.isPrimary) {
  for (let i = 1; i < nBots; i++) {
    cluster.fork();
  }
}

await new Promise(resolve => setTimeout(resolve, 2e3));
const contact = await WebContact.create({name: host
					 , debug: cluster.isPrimary
					});
const bootstrapName = await contact.fetchBootstrap();
const c2 = await contact.ensureRemoteContact(bootstrapName);
await contact.join(c2);

