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
	  if (stopToggles || !contact.node.refreshTimeIntervalMS) return;

	  // For debugging, show that disconnects are happening by reporting if the highest number Node.contacts is disconnecting.
	  // (The lower number Node.contacts might be bootstrap nodes.)
	  if (Node.contacts?.length && contact.farHomeContact === Node.contacts[Node.contacts.length - 1]) console.log('disconnect', contact.farHomeContact.report);

	  contact.disconnect();


	  // For debugging: Report if we're killing the last holder of our data.
	  if (Node.contacts) {
	    for (const key of contact.node.storage.keys()) {
	      let remaining = [];
	      for (const contact of Node.contacts) {
		if (contact.isConnected && contact.node.storage.has(key)) remaining.push(contact.node.name);
	      }
	      if (!remaining.length) console.log(`Disconnecting ${contact.node.name}, last holder of ${key}: ${contact.node.storage.get(key)}.`);
	    }
	  }

	  await make1(i);
	  toggle(i);
	}, randomInteger(2 * refreshTimeIntervalMS));
      }
      function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
      }
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
      async function make1(i) {
	let contact = await Contact.create({name: i, refreshTimeIntervalMS});
	Node.contacts[i] = contact;
	const bootstrap = randomContact(nBootstrapNodes);
	//console.log(contact.node.report(null), 'joining', bootstrap.node.report(null));
	await contact.join(bootstrap);
      }
      // Jasmine collects the named suies and tests in some order, and then completely runs one before starting the next.
      // But there are tests that we want to run "later" and we don't want to stall everything.
      // To do this, we allow a suite or test to add a promise to deferred. The promise will run asynchronously and
      // resolve whenever it is designed to do so, and the entire suite will wait for all of them before finally exiting.
      // TODO: turn this around so that the toggling is in the beforeAll, and then the post-toggling test can be normal named tests.
      const deferred = [];
      let defaultRefreshTime;
      const writeAllowanceMS = 750;
      const beforeTimeout = Math.max(6 * refreshTimeIntervalMS  +  20 * networkSize, 3 * refreshTimeIntervalMS + networkSize * writeAllowanceMS);
      beforeAll(async function () {
	defaultRefreshTime = Node.refreshTimeIntervalMS;
	Node.refreshTimeIntervalMS = refreshTimeIntervalMS;
	Node.contacts = [];
	let nodeDelayRange = 2 * refreshTimeIntervalMS / networkSize; // Spread out creation (and later writes) over half this range on average.
	const start = Date.now();

	// First create the BOOTSTRAP nodes in full.
	// For now, we'll create them one at a time.
	// TODO: do all but the first in parallel.
	Node.contacts.push(await Contact.create({name: 0, refreshTimeIntervalMS}));
	for (let i = 1; i < nBootstrapNodes; i++) {
	  const contact = await Contact.create({name: i, refreshTimeIntervalMS});
	  Node.contacts.push(contact);
	  await delay(nodeDelayRange);
	  await contact.join(Node.contacts[i - 1]);
	}
	console.log('Refresh time is', Node.contacts[0].node.refreshTimeIntervalMS / 1e3, 'seconds.');
	console.log('Run time is', runTimeMS / 1e3, 'seconds.');

	// Add all (non-bootstrap) clients.
	for (let i = nBootstrapNodes; i < networkSize; i++) {
	  await delay(nodeDelayRange);
	  await make1(i);
	}
	const created = Date.now();
	// Write all keys
	//let writes = [];
	for (let i = 0; i < networkSize; i++) {
	  randomNode().storeValue(i, i);
	  await delay(nodeDelayRange);
	}
	//await Promise.all(writes);
	const writes = Date.now() - created;
	const elapsed = Date.now() - start;
	console.log(`Setup ${networkSize} ${Contact.name} complete in ${(elapsed/1e3).toFixed(1)} seconds (${Math.round(writes/networkSize)} ms/node).`);
      }, beforeTimeout);

      it('initially reads.', async function () {
	let done = [];
	for (let i = 0; i < networkSize; i++) {
	  done.push(randomNode().locateValue(i)
		    .then(value => expect(value).toBe(i)));
	  async function getLegit() {
	    const node = randomNode();
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
      afterAll(async function () {
	// The named tests have all run. Start thrashing.
	Node.resetStatistics();
	//Node.reportAll();
	
	console.log('starting toggles', new Date());
	for (let i = nBootstrapNodes; i < networkSize; i++) toggle(i);
	await delay(2 * runTimeMS / 3);

	console.log('stopping toggles', new Date());
	stopToggles = true;
	await delay(runTimeMS / 3);

	//Node.reportAll();
	console.log('running deferred tests', new Date());
	await Promise.all(deferred.map(thunk => thunk()));

	for (const contact of Node.contacts) contact.node.stopRefresh(); // In case there are multiple suites, do not keep flogging ours during the next.
	console.log('finished', new Date());
	Node.reportAll();
	Node.refreshTimeIntervalMS = defaultRefreshTime;
	let stats = Node.statistics;
	let replication = Math.min(Node.k, networkSize);
	let refreshments = 2 * runTimeMS / refreshTimeIntervalMS ; // We average 2 refreshmments / refreshTimeIntervalMS
	console.log('\nAverage counts per node:');

	// let transports = 0;
	// const transportSizes = new Map(); // nTransports => nNodes (that had that nTransports)
	// Node.contacts.forEach(c => {
	//   const nTransports = c.node.nTransports;
	//   transports += nTransports;
	//   const nNodes = transportSizes.get(nTransports) || 0;
	//   transportSizes.set(nTransports, nNodes + 1);
	// });
	// const histogram = Array.from(transportSizes.entries()).sort(([nTransportsA, nNodesA], [nTransportsB, nNodesB]) => nTransportsA - nTransportsB);
	// console.log(transports/networkSize, histogram);

	console.log(`${stats.stored} stored items, expect ${replication}`);
	console.log(`${stats.buckets} buckets`);
	console.log(`${stats.contacts} contacts, ${Math.round(stats.contacts/stats.buckets)} per bucket`);
	console.log('\nAverage ms per action:');
	const stat = (label, {count, elapsed, lag, average}, expect) =>
	      console.log(`${(elapsed/count).toFixed(1)} ${label}${lag ? ` (lagging ${(lag/count).toFixed(1)})` : ''}, total ${count.toLocaleString()}${expect ? ` (idealized ${expect})`: ''} in ${elapsed/1e3} seconds.`);
	stat('RPC', stats.rpc);
	stat('bucket refresh', stats.bucket);
	stat('storage refresh', stats.storage, stats.stored * refreshments * networkSize);
      }, Math.max(20e3, 2 * runTimeMS));
    });
  }
  //test({networkSize: 10, nBootstrapNodes: 1, refreshTimeIntervalMS: 1e3, Contact: SimulatedOverlayContact});
  test({networkSize: 50, nBootstrapNodes: 1, refreshTimeIntervalMS: 5e3, Contact: SimulatedOverlayContact});
  //test({networkSize: 100, nBootstrapNodes: 1, refreshTimeIntervalMS: 15e3, Contact: SimulatedOverlayContact});
  // test({networkSize: 150, nBootstrapNodes: 1, refreshTimeIntervalMS: 15e3, Contact: SimulatedOverlayContact});
  // test({networkSize: 300, nBootstrapNodes: 1, refreshTimeIntervalMS: 15e3, Contact: SimulatedOverlayContact});
  // test({networkSize: 400, nBootstrapNodes: 1, refreshTimeIntervalMS: 15e3, Contact: SimulatedOverlayContact});
  // test({networkSize: 500, nBootstrapNodes: 1, refreshTimeIntervalMS: 15e3, Contact: SimulatedOverlayContact});
});
