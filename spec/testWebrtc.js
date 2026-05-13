#!/usr/bin/env npx jasmine
const { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, URL } = globalThis; // For linters.
import { WebContact, Node } from '../index.js';

const verbose = false;
const testNodeVerbose = verbose;
const baseURL = 'http://localhost:3000/kdht'; // Can specify another host:port where a kdht portal server is running.
const fixedSpacing  = 2; // Second between portals.
const variableSpacing = 5; // Additional seconds random between portals.
const nWrites = 40;
const waitBeforeRead = 15e3;
const botsMilliseconds = 2 * Node.refreshTimeIntervalMS;
const maxPortals = 16;

// If run in NodeJS (e.g., npm run testWebrtc, or npx jasmine spec/testWebrtc.js), this
// will set up a portal server at the start of testing and tear it down at the end.
// However, this can also run:
// - In NodeJS to baseURL that was edited above to a machine in which npm run local is already running.
// - In a browser to http://localhost:3000/test.html or other host where npm run local is already running.
let setupServer, teardownServer;
const isNodeJS = typeof(globalThis.process) !== 'undefined';
const startAndStopPortal = isNodeJS && baseURL.startsWith('http://localhost');
if (startAndStopPortal) {
  const process = await import('node:process');
  const { spawn, exec } = await import('node:child_process');
  const {cpus, availableParallelism } = await import('node:os');
  const { fileURLToPath } = await import('url');
  const path = await import('path');

  const botInfo = true;
  const showPortals = true;
  const showBots = true;
  const logicalCores = availableParallelism();
  console.log(`Model description "${cpus()[0].model}", ${logicalCores} logical cores.`);
  const thrash = true;
  const rude = thrash && false;
  const nPortals = Math.max(2, logicalCores - 1);
  const nBots = Math.max(2, ((thrash || rude) ? 0.75 : 1.75) * logicalCores);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  setupServer = async () => {
    let portalProcess, botProcess;
    function echo(data) { data = data.slice(0, -1); console.log(data.toString()); }

    const portalSeconds = fixedSpacing * nPortals + 1.5 * variableSpacing;
    console.log(new Date(), 'starting', nPortals, 'portals over', portalSeconds, 'seconds');
    portalProcess = spawn('node', [path.resolve(__dirname, '../scripts/portal.js'), '--nPortals', nPortals, '--info', botInfo, '--verbose', verbose.toString()]);
    if (showPortals) {
      portalProcess.stdout.on('data', echo);
      portalProcess.stderr.on('data', echo);
    }
    await Node.delay(portalSeconds * 1e3);

    if (nBots) {
      const botParameters = [path.resolve(__dirname, '../scripts/bots.js'), '--nBots', nBots, '--thrash', thrash.toString(), '--rude', rude.toString(), '--info', botInfo, '--verbose', verbose.toString()];
      console.log(new Date(), 'starting', nBots, rude ? 'crashbots' : (thrash ? 'thrashbots' : 'bots'), 'over', botsMilliseconds/1e3, 'seconds');
      botProcess = spawn('node', botParameters);
      if (showBots) {
	botProcess.stdout.on('data', echo);
	botProcess.stderr.on('data', echo);
      }
      await Node.delay(botsMilliseconds);
    }
  };
  teardownServer = () => {
    console.log(new Date(), 'killing portals and bots');
    exec('pkill kdht-');
  };

} else {
  setupServer = () => {};
  teardownServer = () => {};
}

describe("DHT webrtc write/read", function () {
  let contact;

  beforeAll(async function () {
    await setupServer();
    contact = await WebContact.create({debug: testNodeVerbose});
    console.log('connecting our node', contact.sname, 'through', WebContact.configuration);
    await contact.connect(baseURL);
    console.log(new Date(), 'client node', contact.sname, 'joined');
    for (let index = 0; index < nWrites; index++) {
      const wrote = await contact.storeValue(index, index);
      console.log('Wrote', index);
    }
    if (waitBeforeRead) {
      console.log(new Date(), `Written. Waiting ${waitBeforeRead.toLocaleString()} ms before reading.`);
      await Node.delay(waitBeforeRead);
    }
    console.log(new Date(), 'Reading');
  }, fixedSpacing * maxPortals * 1e3 + 1.5e3 * variableSpacing + botsMilliseconds + 5e3 * nWrites + waitBeforeRead + 10e3);
  afterAll(async function () {
    //console.log(await fetch(new URL('/kdht/stats', globalThis.location || 'http://localhost:3000'), {method: 'POST'}).then(response => response.json()));
    //contact.host.report();
    await contact.disconnect();
    await teardownServer();
  });
  for (let index = 0; index < nWrites; index++) {
    it(`reads ${index}.`, async function () {
      const read = await contact.node.locateValue(index);
      console.log('read', read);
      expect(read).toBe(index);
    }, 20e3); // Can take longer to re-establish multiple connections.
  }
});
