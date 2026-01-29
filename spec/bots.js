#!/usr/bin/env node
import {cpus, availableParallelism } from 'node:os';
import cluster from 'node:cluster';
import process from 'node:process';
import { launchWriteRead } from './writes.js';
import { v4 as uuidv4 } from 'uuid';
import { WebContact, Node } from '../index.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const logicalCores = availableParallelism();

// Todo: Allow a remote portal to be specified (passing a host to WebContact.create/ensureRemoteContact).
const argv = yargs(hideBin(process.argv))
      .usage(`Launch nBots that connect to the network through the local portal. A bot is just an ordinary node that can only be contacted through another node. They provide either continuity or churn-testing, depend on whether or not they are told to 'thrash'. Model description "${cpus()[0].model}", ${logicalCores} logical cores.`)
      .option('nBots', {
	alias: 'n',
	alias: 'nbots',
	type: 'number',
	default: logicalCores,
	description: "The number of bots, which can only be reached through the network."
      })
      .option('baseURL', {
	type: 'string',
	default: 'http://localhost:3000/kdht',
	description: "The base URL of the portal server through which to bootstrap."
      })
      .option('thrash', {
	type: 'boolean',
	default: false,
	description: "Do bots randomly disconnect and reconnect with no memory of previous data?"
      })
      .option('nWrites', {
	alias: 'w',
	alias: "nwrites",
	type: 'number',
	default: 0,
	description: "The number of test writes to check."
      })
      .option('info', {
	alias: 'i',
	type: 'boolean',
	default: true,
	description: "Run with info logging."
      })
      .option('verbose', {
	alias: 'v',
	type: 'boolean',
	default: false,
	description: "Run with verbose logging."
      })
      .parse();

const host = uuidv4();
process.title = 'kdht-bot-' + host;

if (cluster.isPrimary) {
  console.log(`${cpus()[0].model}, ${logicalCores} logical cores. Starting ${argv.nBots} ${argv.thrash ? 'thrashbots' : 'bots'} over ${Node.refreshTimeIntervalMS/1000} seconds.`);
  for (let i = 1; i < argv.nBots; i++) { // The cluster primary becomes bot 0.
    cluster.fork();
  }
  cluster.on('exit', (worker, code, signal) => { // Tell us about dead workers and restart them.
    console.error(`\n\n*** Crashed worker ${worker.id}:${worker.tag} received code: ${code} signal: ${signal}. ***\n`);
    cluster.fork();
  });
  if (argv.nWrites) {
    console.log(new Date(), 'Waiting a refresh interval while bots get randomly created before write/read test');
    await Node.delay(2 * Node.refreshTimeIntervalMS);
    launchWriteRead(argv.nWrites, argv.baseURL, Node.refreshTimeIntervalMS, argv.verbose);
  }  
}

await Node.delay(Node.randomInteger(Node.refreshTimeIntervalMS));
console.log(cluster.worker?.id || 0, host);
let contact = await WebContact.create({name: host, info: argv.info, debug: argv.verbose});
let bootstrapName = await contact.fetchBootstrap(argv.baseURL);
let bootstrapContact = await contact.ensureRemoteContact(bootstrapName, argv.baseURL);
await contact.join(bootstrapContact);

process.on('SIGINT', async () => {
  console.log(process.title, 'Shutdown for Ctrl+C');
  await contact.disconnect();
  process.exit(0);
});

while (argv.thrash) {
  await Node.delay(contact.host.fuzzyInterval(Node.refreshTimeIntervalMS));
  const old = contact;
  const next = uuidv4();
  await contact.disconnect();
  await Node.delay(1e3); // TODO: remove?

  contact = await WebContact.create({name: next, info: argv.info, debug: argv.verbose});
  bootstrapName = await contact.fetchBootstrap(argv.baseURL);
  bootstrapContact = await contact.ensureRemoteContact(bootstrapName, argv.baseURL);
  await contact.join(bootstrapContact);
}

