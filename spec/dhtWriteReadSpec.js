#!/usr/bin/env npx jasmine
const { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } = globalThis; // For linters.
import process from 'node:process';
import { spawn } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';
import { WebContact, Node } from '../index.js';
import { fileURLToPath } from 'url';
import path from 'path';

describe("DHT write/read", function () {
  let contact, portalProcess;
  const verbose = false;
  const baseURL = 'http://localhost:3000/kdht';
  const nPortals = 10;
  const nBots = 10;
  const fixedSpacing  = 2; // Between portals.
  const variableSpacing = 5; // Additional random between portals.
  const nWrites = 40;
  const waitBeforeRead = 15e3;
  const thrash = true;

  
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const portalSeconds = fixedSpacing * nPortals + 1.5 * variableSpacing;
  const botsMilliseconds = 2 * Node.refreshTimeIntervalMS;
  
  beforeAll(async function () {
    portalProcess = spawn('node', [path.resolve(__dirname, 'portal.js'), '--nPortals', nPortals, '--nBots', nBots, '--thrash', thrash.toString(), '--verbose', verbose.toString()]);
    contact = await WebContact.create({name: uuidv4(), debug: verbose});
    console.log('starting portals over', portalSeconds, 'seconds');
    await Node.delay(portalSeconds * 1e3);
    console.log('starting bots over', botsMilliseconds/1e3, 'seconds');    
    await Node.delay(botsMilliseconds);

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
  }, 5e3 * nWrites + 2 * Node.refreshTimeIntervalMS);
  afterAll(async function () {
    contact.disconnect();
    portalProcess.kill();
  });
  for (let index = 0; index < nWrites; index++) {
    it(`reads ${index}.`, async function () {
      const read = await contact.node.locateValue(index);
      console.log('read', read);
      expect(read).toBe(index);
    }, 10e3); // Can take longer to re-establish multiple connections.
  }
});
