#!/usr/bin/env node
import {cpus, availableParallelism } from 'node:os';
import cluster from 'node:cluster';
import process from 'node:process';
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
	default: Math.max(2, logicalCores / 2),
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
      .option('info', {
	alias: 'i',
	type: 'boolean',
	default: true,
	description: "Run with info logging."
      })
      .option('rude', {
	type: 'boolean',
	default: false,
	description: "Skip polite disconnect — just abandon connections (simulates browser reload)."
      })
      .option('verbose', {
	alias: 'v',
	type: 'boolean',
	default: false,
	description: "Run with verbose logging."
      })
      .parse();

if (cluster.isPrimary) {
  process.title = 'kdht-bot-master';
  console.log(`${new Date()} ${cpus()[0].model}, ${logicalCores} logical cores. Starting ${argv.nBots} ${argv.thrash ? 'thrashbots' : 'bots'} over ${Node.refreshTimeIntervalMS/1000} seconds.`);
  for (let i = 0; i < argv.nBots; i++) { // The cluster primary becomes bot 0.
    cluster.fork();
  }
  cluster.on('exit', (worker, code, signal) => { // Tell us about dead workers and restart them.
    if (code !== 0 && code !== 99) console.error(`\n\n*** Crashed worker ${worker.id}:${worker.tag} received code: ${code} signal: ${signal}. ***\n`);
    cluster.fork();
  });
} else {

  console.log(new Date(), 'launched', cluster.worker?.id);
  process.title = 'kdht-bot-sleep-' + cluster.worker?.id;
  await Node.delay(Node.randomInteger(Node.refreshTimeIntervalMS));
  let contact;

  async function launch() {
    let host = uuidv4();
    console.log(new Date(), cluster.worker?.id || 0, host);
    process.title = 'kdht-bot-' + host;
    contact = await WebContact.create({name: host, info: argv.info, debug: argv.verbose});
    let bootstrapName = await contact.fetchBootstrap(argv.baseURL);
    let bootstrapContact = await contact.ensureRemoteContact(bootstrapName, argv.baseURL);
    await contact.join(bootstrapContact);
  }
  await launch();

  process.on('SIGINT', async () => {
    console.log(new Date(), process.title, 'Shutdown for Ctrl+C');
    await contact.disconnect();
    process.exit(0);
  });

  if (argv.rude) {
    await Node.delay(contact.host.fuzzyInterval(Node.refreshTimeIntervalMS));
    console.log(new Date(), 'abandoning', contact.sname);
    // Don't disconnect — just drop everything, simulating a browser reload.
    process.exit(99);
  }
  while (argv.thrash) {
    await Node.delay(contact.host.fuzzyInterval(Node.refreshTimeIntervalMS));
    console.log(new Date(), 'disconnecting', contact.sname);
    await contact.disconnect();
    await Node.delay(1e3);
    await launch();
  }
}
