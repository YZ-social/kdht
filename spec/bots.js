import cluster from 'node:cluster';
import process from 'node:process';
import { v4 as uuidv4 } from 'uuid';
import { WebContact } from '../index.js';
const nBots = 1;

const host = uuidv4();
process.title = 'kdhtbot-' + host;

if (cluster.isPrimary) {
  for (let i = 1; i < nBots; i++) {
    cluster.fork();
  }
}

await new Promise(resolve => setTimeout(resolve, 2e3));
const contact = new WebContact({host, node: 'random', isServerNode: true});
await contact.connect();
