#!/usr/bin/env node
import process from 'node:process';
import cluster from 'node:cluster';
import { spawn } from 'node:child_process'; // For optionally spawning bots.js
import { launchWriteRead } from './writes.js';
import express from 'express';
import logger from 'morgan';
import path from 'path';
import {cpus, availableParallelism } from 'node:os';
import { fileURLToPath } from 'url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Node } from '../index.js';

const logicalCores = availableParallelism();

// TODO: Allow a remote portal to be specified that this portal will hook with, forming one big network.
const argv = yargs(hideBin(process.argv))
      .usage(`Start an http post server through which nodes can connect to set of nPortals stable nodes. Model description "${cpus()[0].model}", ${logicalCores} logical cores.`)
      .option('nPortals', {
	alias: 'nportals',	
	alias: 'p',
	type: 'number',
	default: Math.min(logicalCores / 2, 2),
	description: "The number of steady nodes that handle initial connections."
      })
      .option('nBots', {
	alias: 'nbots',
	alias: 'n',
	type: 'number',
	default: 0,
	description: "If non-zero, spawns bots.js with the given nBots."
      })
      .option('thrash', {
	type: 'boolean',
	default: false,
	description: "Do the nBots randomly disconnect and reconnect with no memory of previous data?"
      })
      .option('nWrites', {
	alias: 'w',
	type: 'number',
	default: 0,
	description: "The number of test writes to pass to bots.js."
      })
      .option('baseURL', {
	type: 'string',
	default: 'http://localhost:3000/kdht',
	description: "The base URL of the portal server through which to bootstrap."
      })
      .option('externalBaseURL', {
	type: 'string',
	default: '',
	description: "The base URL of the some other portal server to which we should connect ours, if any."
      })
      .option('verbose', {
	alias: 'v',
	type: 'boolean',
	description: "Run with verbose logging."
      })
      .option('fixedSpacing', {
	type: 'number',
	default: 2,
	description: "Minimum seconds to add between each portal."
      })
      .options('variableSpacing', {
	type: 'number',
	default: 5,
	description: "Additional variable seconds (+/- variableSpacing/2) to add to fixedSpacing between each portal."
      })
      .parse();

// NodeJS cluster forks a group of process that each communicate with the primary via send/message.
// Each fork is a stateful kdht node that can each handle multiple WebRTC connections. The parent runs
// a Web server that handles Post request by sending the data to the specific fork.
// 
// (Some other applications using NodeJS cluster handle stateless requests, so each fork listens directly
// on a shared socket and picks up requests randomly. We do not make use of that shared socket feature.)

if (cluster.isPrimary) { // Parent process with portal webserver through which clienta can bootstrap
  // Our job is to launch some kdht nodes to which clients can connect by signaling through
  // a little web server operated here.
  process.title = 'kdht-portal-server';
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const app = express();
  //fixme if (argv.verbose)
    app.use(logger(':date[iso] :status :method :url :res[content-length] - :response-time ms'));

  for (let i = 0; i < argv.nPortals; i++) cluster.fork();
  const portalServer = await import('../portals/router.js');
  
  // Portal server
  app.set('port', parseInt((new URL(argv.baseURL)).port || '80'));
  console.log(new Date(), process.title, 'startup on port', app.get('port'), 'in', __dirname);
  app.use(express.json());

  app.use('/kdht', portalServer.router);
  app.use(express.static(path.resolve(__dirname, '..')));
  app.listen(app.get('port'));
  const startupSeconds = argv.fixedSpacing * argv.nPortals + 1.5 * argv.variableSpacing;
  console.log(`Starting ${argv.nPortals} portals over ${startupSeconds} seconds.`);
  if (argv.nBots || argv.nWrites) await Node.delay(startupSeconds * 1e3);
  if (argv.nBots) {
    const args = ['spec/bots.js', '--nBots', argv.nBots, '--baseURL', argv.baseURL, '--thrash', argv.thrash || false, '--verbose', argv.verbose || false];
    if (argv.verbose) console.log('spawning node', args.join(' '));
    const bots = spawn('node', args, {shell: process.platform === 'win32'});
    // Slice off the trailing newline of data so that we don't have blank lines after our console adds one more.
    function echo(data) { data = data.slice(0, -1); console.log(data.toString()); }
    bots.stdout.on('data', echo);
    bots.stderr.on('data', echo);
    if (argv.nWrites) {
      console.log(new Date(), 'Waiting a refresh interval while', argv.nBots, 'bots get randomly created before write/read test.');
      await Node.delay(2 * Node.refreshTimeIntervalMS);
    }
  }
  if (argv.nWrites) launchWriteRead(argv.nWrites, argv.baseURL, argv.nBots ? 2 * Node.refreshTimeIntervalMS : 0, argv.verbose);

} else { // A portal node through which client's can connect.
  const portalNode = await import('../portals/node.js');
  const {baseURL, externalBaseURL, fixedSpacing, variableSpacing, verbose} = argv;
  await portalNode.setup({baseURL, externalBaseURL, fixedSpacing, variableSpacing, verbose});
}
