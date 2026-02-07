#!/usr/bin/env node
/**
 * Start the KDHT portal server in R/Kademlia recursive routing mode.
 * 
 * This is equivalent to `npm start` but with recursive routing enabled.
 * All nodes in the network will use recursive routing for lookups and signaling.
 * 
 * Usage:
 *   node scripts/portalRecursive.js [options]
 *   npm run start:recursive
 * 
 * Options:
 *   --pns           Enable Proximity Neighbor Selection (default: false)
 *   --ttl <n>       Maximum hops for recursive lookups (default: 20)
 *   --weight <n>    RTT influence factor 0-1 (default: 0.1)
 *   Plus all standard portal.js options (--nPortals, --baseURL, etc.)
 */

import process from 'node:process';
import cluster from 'node:cluster';
import express from 'express';
import logger from 'morgan';
import path from 'path';
import { cpus, availableParallelism } from 'node:os';
import { fileURLToPath } from 'url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Node } from '../index.js';
import { configureRecursive } from './configureRecursive.js';

const logicalCores = availableParallelism();

const argv = yargs(hideBin(process.argv))
      .usage(`Start KDHT portal server in R/Kademlia recursive routing mode. Model: "${cpus()[0].model}", ${logicalCores} logical cores.`)
      .option('nPortals', {
        alias: 'p',
        type: 'number',
        default: Math.max(2, logicalCores - 1),
        description: "Number of portal nodes"
      })
      .option('baseURL', {
        type: 'string',
        default: 'http://localhost:3000/kdht',
        description: "Base URL of the portal server"
      })
      .option('externalBaseURL', {
        type: 'string',
        default: '',
        description: "External portal URL to connect to"
      })
      .option('info', {
        alias: 'i',
        type: 'boolean',
        default: true,
        description: "Enable info logging"
      })
      .option('verbose', {
        alias: 'v',
        type: 'boolean',
        default: false,
        description: "Enable verbose logging"
      })
      .option('fixedSpacing', {
        type: 'number',
        default: 2,
        description: "Minimum seconds between portal launches"
      })
      .option('variableSpacing', {
        type: 'number',
        default: 5,
        description: "Variable seconds (+/- half) between portals"
      })
      // R/Kademlia specific options
      .option('pns', {
        type: 'boolean',
        default: false,
        description: "Enable Proximity Neighbor Selection"
      })
      .option('ttl', {
        type: 'number',
        default: 20,
        description: "Maximum hops for recursive lookups"
      })
      .option('weight', {
        type: 'number',
        default: 0.1,
        description: "RTT influence factor (0-1)"
      })
      .parse();

// Configure R/Kademlia recursive mode
configureRecursive({
  pnsEnabled: argv.pns,
  defaultTTL: argv.ttl,
  proximityWeight: argv.weight,
});

if (cluster.isPrimary) {
  console.log(`${cpus()[0].model}, ${logicalCores} logical cores.`);
  console.log('R/Kademlia RECURSIVE ROUTING MODE');
  process.title = 'kdht-recursive-portal-server';
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const app = express();
  app.use(logger(':date[iso] :status :method :url :res[content-length] - :response-time ms'));

  for (let i = 0; i < argv.nPortals; i++) cluster.fork();
  const portalServer = await import('./router.js');
  
  app.set('port', parseInt((new URL(argv.baseURL)).port || '80'));
  console.log(new Date(), process.title, 'startup on port', app.get('port'), 'in', __dirname);
  app.use(express.json());

  app.use('/kdht', portalServer.router);
  app.use(express.static(path.resolve(__dirname, '..')));
  app.listen(app.get('port'));
  const startupSeconds = argv.fixedSpacing * argv.nPortals + 1.5 * argv.variableSpacing;
  console.log(`Starting ${argv.nPortals} recursive portals over ${startupSeconds} seconds.`);

} else {
  // Worker process - also configure recursive mode
  configureRecursive({
    pnsEnabled: argv.pns,
    defaultTTL: argv.ttl,
    proximityWeight: argv.weight,
  });
  
  const PortalNode = await import('./node.js');
  const { baseURL, externalBaseURL, fixedSpacing, variableSpacing, info, verbose } = argv;
  const contact = await PortalNode.setup({ baseURL, externalBaseURL, fixedSpacing, variableSpacing, info, debug: verbose });
  
  function report() {
    contact.host.report();
    setTimeout(report, 2 * Node.refreshTimeIntervalMS);
  }
}
