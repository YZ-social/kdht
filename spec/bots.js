#!/usr/bin/env node
import cluster from 'node:cluster';
import process from 'node:process';
import { spawn } from 'node:child_process'; // For optionally spawning bots.js
import { v4 as uuidv4 } from 'uuid';
import { WebContact, Node } from '../index.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
      .option('nBots', {
	alias: 'n',
	alias: 'nbots',
	type: 'number',
	default: 20,
	description: "The number of thrashbots, which can only be reached through the network."
      })
      .option('nWrites', {
	alias: 'w',
	alias: "nwrites",
	type: 'number',
	default: 0,
	description: "The number of test writes to check."
      })
      .option('verbose', {
	alias: 'v',
	type: 'boolean',
	description: "Run with verbose logging."
      })
      .parse();

const host = uuidv4();

if (cluster.isPrimary) {
  for (let i = 1; i < argv.nBots; i++) {
    cluster.fork();
  }
  if (argv.nWrites) {
    console.log(new Date(), 'Waiting a refresh interval while bots get randomly created before write/read test');
    setTimeout(() => {
      const args = ['jasmine', 'spec/dhtWriteRead.js', '--', '--nWrites', argv.nWrites, '--verbose', argv.verbose || false];
      const bots = spawn('npx', args, { shell: true });
      console.log(new Date(), 'spawning npx', args.join(' '));
      bots.stdout.on('data', data => console.log(data.slice(0, -1).toString()));
      bots.stderr.on('data', data => console.error(data.slice(0, -1).toString()));
    }, Node.refreshTimeIntervalMS);
  }
}
process.title = 'kdht-bot-' + host;

await Node.delay(Node.randomInteger(Node.refreshTimeIntervalMS));
const contact = await WebContact.create({name: host, debug: argv.v});
const bootstrapName = await contact.fetchBootstrap();
const c2 = await contact.ensureRemoteContact(bootstrapName);
await contact.join(c2);

