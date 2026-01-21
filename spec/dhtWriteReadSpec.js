#!/usr/bin/env npx jasmine
const { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } = globalThis; // For linters.
import process from 'node:process';
import { spawn, exec } from 'node:child_process';
import {cpus, availableParallelism } from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { WebContact, Node } from '../index.js';
import { fileURLToPath } from 'url';
import path from 'path';

describe("DHT write/read", function () {
  let contact, portalProcess, botProcess;
  const verbose = false;
  const baseURL = 'http://localhost:3000/kdht';
  const logicalCores = availableParallelism();
  console.log(`Model description "${cpus()[0].model}", ${logicalCores} logical cores.`);
  const maxPerCluster = logicalCores / 2; // Why half? Because we have at least two processes.
  const nPortals = maxPerCluster;
  const nBots = maxPerCluster;
  const fixedSpacing  = 2; // Between portals.
  const variableSpacing = 5; // Additional random between portals.
  const nWrites = 40;
  const waitBeforeRead = 15e3;
  const thrash = true;
  const showPortals = true;
  const showBots = true;

  
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const portalSeconds = fixedSpacing * nPortals + 1.5 * variableSpacing;
  const botsMilliseconds = 2 * Node.refreshTimeIntervalMS;
  
  beforeAll(async function () {
    function echo(data) { data = data.slice(0, -1); console.log(data.toString()); }

    console.log(new Date(), 'starting', nPortals, 'portals over', portalSeconds, 'seconds');
    portalProcess = spawn('node', [path.resolve(__dirname, 'portal.js'), '--nPortals', nPortals, '--verbose', verbose.toString()]);
    if (showPortals) {
      portalProcess.stdout.on('data', echo);
      portalProcess.stderr.on('data', echo);
    }
    await Node.delay(portalSeconds * 1e3);

    if (nBots) {
      for (let launched = 0, round = Math.min(nBots, maxPerCluster); launched < nBots; round = Math.min(nBots - launched, maxPerCluster), launched += round) {
	console.log(new Date(), 'starting', round, 'bots over', botsMilliseconds/1e3, 'seconds');
	botProcess = spawn('node', [path.resolve(__dirname, 'bots.js'), '--nBots', round, '--thrash', thrash.toString(), '--verbose', verbose.toString()]);
	if (showBots) {
	  botProcess.stdout.on('data', echo);
	  botProcess.stderr.on('data', echo);
	}
	await Node.delay(botsMilliseconds);
      }
    }

    contact = await WebContact.create({name: uuidv4(), debug: verbose});
    const bootstrapName = await contact.fetchBootstrap(baseURL);
    const bootstrapContact = await contact.ensureRemoteContact(bootstrapName, baseURL);
    console.log(new Date(), contact.sname, 'joining', bootstrapContact.sname);
    await contact.join(bootstrapContact);
    console.log(new Date(), contact.sname, 'joined');    
    for (let index = 0; index < nWrites; index++) {
      const wrote = await contact.storeValue(index, index);
      console.log('Wrote', index);
    }
    if (waitBeforeRead) {
      console.log(new Date(), `Written. Waiting ${waitBeforeRead.toLocaleString()} ms before reading.`);
      await Node.delay(waitBeforeRead);
    }
    console.log(new Date(), 'Reading');
  }, 5e3 * nWrites + (1 + Math.ceil(nBots / maxPerCluster)) * Node.refreshTimeIntervalMS);
  afterAll(async function () {
    contact.disconnect();
    console.log(new Date(), 'killing portals and bots');
    exec('pkill kdht-');
  });
  for (let index = 0; index < nWrites; index++) {
    it(`reads ${index}.`, async function () {
      const read = await contact.node.locateValue(index);
      console.log('read', read);
      expect(read).toBe(index);
    }, 10e3); // Can take longer to re-establish multiple connections.
  }
});
