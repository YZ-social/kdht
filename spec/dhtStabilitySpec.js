import { Node, SimulatedContact, SimulatedOverlayContact } from '../index.js';
const { describe, it, expect, beforeAll, afterAll, BigInt} = globalThis; // For linters.


describe("DHT stability", function () {
  function test({networkSize, nBootstrapNodes = 1, refreshTimeIntervalMS = 1e3, runTimeMS = 3 * refreshTimeIntervalMS, Contact = SimulatedOverlayContact}) {
    // Generates a test suite with the given parameters (most described in https://github.com/YZ-social/flag/issues/31).
    nBootstrapNodes = Math.min(networkSize, nBootstrapNodes);
    describe(`Network of size ${networkSize}`, function () {
      let stopToggles = false;
      function toggle(i) { // Start disconnect/reconnect timer on contact i.
	// TODO: use Node#repeat with a margin that does not produce a ridiculous short minimum uptime.
	setTimeout(async () => {
	  const contact = Node.contacts[i];
	  contact.disconnect();
	  Node.contacts[i] = await make1(i);
	  if (!stopToggles) toggle(i);
	}, randomInteger(2 * refreshTimeIntervalMS));
      }
      function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
      }
      // Jasmine collects the named suies and tests in some order, and then completely runs one before starting the next.
      // But there are tests that we want to run "later" and we don't want to stall everything.
      // To do this, we allow a suite or test to add a promise to deferred. The promise will run asynchronously and
      // resolve whenever it is designed to do so, and the entire suite will wait for all of them before finally exiting.
      const deferred = [];
      let defaultRefreshTime;
      afterAll(async function () {
	// The named tests have all run. Start thrashing.
	Node.resetStatistics();

	console.log('starting toggles', new Date());
	for (let i = nBootstrapNodes; i < networkSize; i++) toggle(i);
	await delay(2 * runTimeMS / 3);

	console.log('stopping toggles', new Date());
	stopToggles = true;
	await delay(runTimeMS / 3);

	console.log('running deferred tests', new Date());
	await Promise.all(deferred.map(thunk => thunk()));

	console.log('finished', new Date());
	Node.refreshTimeIntervalMS = defaultRefreshTime;
	let stats = Node.statistics;
	let replication = Math.min(Node.k, networkSize);
	let refreshments = 2 * runTimeMS / refreshTimeIntervalMS ; // We average 2 refreshmments / refreshTimeIntervalMS
	//Node.reportAll();
	console.log('\nAverage counts per node:');
	console.log(`${stats.stored} stored items, expect ${replication}`);
	console.log(`${stats.buckets} buckets`);
	console.log(`${stats.contacts} contacts, ${Math.round(stats.contacts/stats.buckets)} per bucket`);
	console.log(`${stats.overlays} webrtc connections, ${Math.round(stats.overlays/stats.buckets)} per bucket`);	
	console.log('\nAverage ms per action:');
	const stat = (label, {count, elapsed, lag, average}, expect) =>
	      console.log(`${(elapsed/count).toFixed(1)} ${label} lagging ${(lag/count).toFixed(1)}, total ${count.toLocaleString()}${expect ? ` (idealized ${expect})`: ''} in ${elapsed/1e3} seconds.`);
	stat('RPC', stats.rpc);
	stat('overlay leg', stats.overlay);	
	stat('bucket refresh', stats.bucket);
	stat('storage refresh', stats.storage, stats.stored * refreshments * networkSize);
      }, 2 * runTimeMS);
      let reportedDeferred = false;
      function randomInteger(max = Node.contacts.length) {
	// Return a random number between 0 (inclusive) and max (exclusive), defaulting to the number of contacts made.
	return Math.floor(Math.random() * max);
      }
      function randomContact(max = Node.contacts.length) { // Return a connected contact at randomInteger(max).
	const contact = Node.contacts[randomInteger(max)];
	if (contact?.isConnected) return contact;
	return randomContact(max);
      }
      function randomNode(max = Node.contacts.length) {
	return randomContact(max).node;
      }
      async function expectedNodes(target) {
	const key = await Node.key(target);
	let connected = Node.contacts.filter(c => c.isConnected);
	return Node.findClosestHelpers(key, connected, 20).map(h => h.contact.node);
      }
      function make1(i) {
	return Contact.create({name: i, refreshTimeIntervalMS})
	  .then(contact => contact.join(randomContact(nBootstrapNodes)));
      }
      beforeAll(async function () {
	defaultRefreshTime = Node.refreshTimeIntervalMS;
	Node.refreshTimeIntervalMS = refreshTimeIntervalMS;
	Node.contacts = [];
	const start = Date.now();

	// First create the bootstrap nodes in full.
	// For now, we'll create them one at a time.
	// TODO: do all but the first in parallel.
	for (let i = 0; i < nBootstrapNodes; i++) {
	  let contact = await Contact.create({name: i, refreshTimeIntervalMS});
	  if (i) await contact.join(Node.contacts[i - 1]);
	  Node.contacts.push(contact);
	}
	console.log('Refresh time is', Node.contacts[0].node.refreshTimeIntervalMS / 1e3, 'seconds.');
	console.log('Run time is', runTimeMS / 1e3, 'seconds.');

	// add all clients
	const joins = [];
	for (let i = nBootstrapNodes; i < networkSize; i++) joins.push(make1(i));
	Node.contacts.push(...await Promise.all(joins));
	// Write all keys
	let writes = [];
	for (let i = 0; i < networkSize; i++) writes.push(randomNode().storeValue(i, i));
	await Promise.all(writes);
	const elapsed = Date.now() - start;
	console.log(`Setup ${networkSize} ${Contact.name} complete in ${(elapsed/1e3).toFixed(1)} seconds (${Math.round(elapsed/networkSize)} ms/node).`);
      }, (networkSize/100 + 1) * networkSize + 5e3);

      it('initially reads.', async function () {
	let done = [];
	for (let i = 0; i < networkSize; i++) {
	  done.push(randomNode().locateValue(i)
		    .then(value => expect(value).toBe(i)));
	  async function getLegit() {
	    const node = randomNode();
	    if (!node.contact.isConnected) console.error('FIXME', node.report(null));
	    const response = await node.locateValue(i);
	    if (node.contact.isConnected) {
	      expect(response).toBe(i);
	    } else {
	      console.log(`${node.name} was still disconnected when trying to look up ${i}. Retrying.`);
	      await getLegit();
	    }
	  }
	  deferred.push(getLegit);
	}
	await Promise.all(done);
      });
    });
  }
  test({networkSize: 100, nBootstrapNodes: 1, refreshTimeIntervalMS: 10e3, Contact: SimulatedContact});
});
