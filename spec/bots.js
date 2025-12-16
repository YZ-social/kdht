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
	description: "The number of bots, which can only be reached through the network."
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
      function echo(data) { if (data[data.length - 1] === '\n') data = data.slice(0, -1); console.log(data.toString()); }
      bots.stdout.on('data', echo);
      bots.stderr.on('data', echo);
    }, 2 * Node.refreshTimeIntervalMS);
  }
}
process.title = 'kdht-bot-' + host;

await Node.delay(Node.randomInteger(Node.refreshTimeIntervalMS));
let contact = await WebContact.create({name: host, debug: argv.v});
let bootstrapName = await contact.fetchBootstrap();
let bootstrapContact = await contact.ensureRemoteContact(bootstrapName, 'http://localhost:3000/kdht');
await contact.join(bootstrapContact);

while (argv.thrash) {
  await Node.delay(contact.host.fuzzyInterval(Node.refreshTimeIntervalMS));
  const next = uuidv4();
  console.log('\n\n-- disconnecting', contact.host.report(null), 'and reconnecting as', next);
  contact.disconnect();

  contact = await WebContact.create({name: host, debug: argv.v});
  bootstrapName = await contact.fetchBootstrap();
  bootstrapContact = await contact.ensureRemoteContact(bootstrapName, 'http://localhost:3000/kdht');
  console.log('\n\n-- joining', contact.sname, 'via', bootstrapContact.sname);
  await contact.join(bootstrapContact);
  console.log('\n\n*** joined', contact.sname, 'via', bootstrapContact.sname, '***\n\n');
}

