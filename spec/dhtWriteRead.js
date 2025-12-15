#!/usr/bin/env npx jasmine
const { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } = globalThis; // For linters.
import process from 'node:process';
import { exec } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';
import { WebContact, Node } from '../index.js';

// I cannot get yargs to work properly within jasmine. Get args by hand.
// Note: jasmine will treat --options as arguments to itself. To pass them to the script, you need to separate with '--'.
const nWritesIndex = process.argv.indexOf('--nWrites');
const verboseIndex = process.argv.indexOf('--verbose');
const shutdownIndex = process.argv.indexOf('--shutdown');
const nWrites = nWritesIndex >= 0 ? JSON.parse(process.argv[nWritesIndex + 1]) : 10;
const verbose = verboseIndex >= 0 ? JSON.parse( process.argv[verboseIndex + 1] || 'true' ) : false;
const shutdown = shutdownIndex >= 0 ? JSON.parse( process.argv[shutdownIndex + 1] || 'true' ) : true;

describe("DHT write/read", function () {
  let contact;
  beforeAll(async function () {
    contact = await WebContact.create({name: uuidv4(), debug: verbose});
    const bootstrapName = await contact.fetchBootstrap();
    const bootstrapContact = await contact.ensureRemoteContact(bootstrapName);
    console.log(new Date(), 'Joining', bootstrapContact.sname);
    await contact.join(bootstrapContact, 'http://localhost:3000/kdht');
    for (let index = 0; index < nWrites; index++) {
      const wrote = await contact.store(index, index);
      console.log('Wrote', index);
    }
    console.log(new Date(), 'Written. Waiting one refresh period before reading.');
    await Node.delay(Node.refreshTimeIntervalMS);
    console.log(new Date(), 'Reading');
  }, 5e3 * nWrites + 2 * Node.refreshTimeIntervalMS);
  afterAll(function () {
    if (shutdown) {
      exec('pkill kdht-bot');
      Node.delay(2e3);
      exec('pkill kdht-portal-server');
    }
  });
  for (let index = 0; index < nWrites; index++) {
    it(`reads ${index}.`, async function () {
      const read = await contact.node.locateValue(index);
      console.log('read', read);
      expect(read).toBe(index);
    });
  }
});
