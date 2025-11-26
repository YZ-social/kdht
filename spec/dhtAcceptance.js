// Defines a repeatable suite of tests that confirm DHT operations and log performance data.

// Defined by the generic test framework. See https://jasmine.github.io/
// One does not import these definitions from a file, but rather they are
// defined globally by the jasmine program or browser page that runs the tests.
const { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach} = globalThis; // For linters.

// The file dhtImplementation.js exports functions that perform setup operations whose
// implementation changes for different DHTs.
import { setupServerNodes, shutdownServerNodes,
	 setupClientsByTime, shutdownClientNodes,
	 getContacts, getRandomLiveContact,
	 startThrashing, write1, read1 } from './dhtImplementation.js';

// Some definitions:
//
// CONTACTS: an array whose elements can be passed to write1/read1.
//   The elements might be node names or keys, or some wrapper around a node instance.
//
// THRASH: to run a client node for a random amount of time averaging the refresh interval,
//   disconnect, and then immediately reconnect with no memory of any stored key/value pairs.
//   It is not specified whether the node must come back with the same node name or node key,
//   but it is required that contacts must be updated with any new values.
// 
// CLIENT NODE: A node representing an application user, that is subject to thrashing.
//
// SERVER NODE: A node managed by the server that does NOT thrash.
//   1. The server nodes provide persistence of stored values when all the client nodes have disconnected,
//      and thus ARE included in contacts. (AKA as "persistence nodes" or "community nodes".)
//   2. In addition, the implementation-specific function setupServerNodes also ensures
//      that client nodes have nodes that they can join through (AKA "bootstrap nodes"),
//      but it is not specified whether this function is performed by the server nodes in the
//      contacts array, or by other nodes managed by the server.
//
// READY: A node is ready when write1/read1 operations may be performed through it without loss.
//   It is not specified whether this condition is an arbitrary amount of time or the result of
//   having positively completed completed some probing operation with the network. The
//   implementation-specific asynchronous operations to set up, thrash, write, and read must
//   not resolve until the node is "ready" for more operations. For example, a write that has
//   resolved, followed by nodes thrashing (averaging the refresh interval), followed by
//   a read sould produce the written value.

async function timed(operation, logString) {
  // Time the execution of await operation(startTime), and
  // then log the result of await logString(elapsedSeconds).
  // Promises the elapsed time in milliseconds.
  const startTime = Date.now();
  await operation(startTime);
  const endTime = Date.now();
  const elapsed = endTime - startTime;
  console.log(await logString(elapsed/1e3));
  return elapsed;
}

async function getContactsLength() {
  // Promise current length of contacts. (Convenience for sanity checks.)
  const contacts = await getContacts();
  return contacts.length;
}
function delay(ms, label = '') {
  // Promise to resolve in the given milliseconds.
  if (label && ms) console.log(`(${(ms/1e3).toFixed(3)}s ${label})`);
  const start = Date.now();
  return new Promise(resolve => setTimeout(() => {
    const lag = Date.now() - start - ms;
    if (lag > 250) console.log(`** System is overloaded by ${lag.toLocaleString()} ms. **`);
    resolve();
  }, ms));
}

async function parallelWriteAll() {
  // Persist a unique string through each contact all at once, but not resolving until all are ready.
  const contacts = await getContacts();
  // The key and value are the same, to facilitate read confirmation.
  const writePromises = await Promise.all(contacts.map((contact, index) => write1(contact, index, index)));
  return writePromises.length;
}
async function serialWriteAll() { // One-at-atime alternative to above, useful for debugging.
  const contacts = await getContacts();
  for (let index = 0; index < contacts.length; index++) {
    await write1(contacts[index], index, index);
  }
  return contacts.length;
}
async function parallelReadAll() {
  // Reads from a random contact, confirming the value, for each key written by writeAll.
  const contacts = await getContacts();
  const readPromises = await Promise.all(contacts.map(async (contact, index) => {
    const value = await read1(await getRandomLiveContact(), index);
    expect(value).toBe(index);
  }));
  return readPromises.length;
}
async function serialReadAll() { // One-at-a-time alternative of above, useful for debugging.
  const contacts = await getContacts();
  for (let index = 0; index < contacts.length; index++) {
    const value = await read1(await getRandomLiveContact(), index);
    expect(value).toBe(index);
  }
  return contacts.length;
}


describe("DHT", function () {
  function test(parameters = {}) {
    // Define a suite of tests with the given parameters.
    const {nServerNodes = 10,
	   maxClientNodes = 0, // If zero, will try to make as many as it can in refreshTimeIntervalMS.
	   refreshTimeIntervalMS = 15e3, // How long on average does a client stay up?
	   runtimeBeforeWriteMS = 3 * refreshTimeIntervalMS, // How long to probe (and thrash) before writing starts.
	   runtimeBeforeReadMS = runtimeBeforeWriteMS, // How long to probe (and thrash) before reading starts.
	   startThrashingBefore = 'creation' // When to start thrashing clients: before creation|writing|reading. Anything else is no thrashing.
	  } = parameters;
    const suiteLabel = `Server nodes: ${nServerNodes}, max client nodes: ${maxClientNodes || Infinity}, refresh: ${refreshTimeIntervalMS.toFixed(3)} ms, pause before write: ${runtimeBeforeWriteMS.toFixed(3)} ms, pause before read: ${runtimeBeforeReadMS.toFixed(3)} ms, thrash before: ${startThrashingBefore}`;
    
    describe(suiteLabel, function () {
      beforeAll(async function () {
	console.log('\n' + suiteLabel);
	await delay(1e3); // For gc
	await timed(_ => setupServerNodes(nServerNodes, refreshTimeIntervalMS),
		    elapsed => `Server setup ${nServerNodes} / ${elapsed} = ${Math.round(nServerNodes/elapsed)} nodes/second.`);
	expect(await getContactsLength()).toBe(nServerNodes);
      });
      afterAll(async function () {
	await shutdownServerNodes(nServerNodes);
	expect(await getContactsLength()).toBe(0);
      });

      describe("joins within a refresh interval", function () {
	let nJoined = 0, nWritten = 0;
	const setupTimeMS = Math.max(refreshTimeIntervalMS, 2e3); // Even if we turn off refresh, allow at least 2 seconds for setup.
	beforeAll(async function () {
	  if (startThrashingBefore === 'creation') await startThrashing(nServerNodes, refreshTimeIntervalMS);
	  let elapsed = await timed(async _ => nJoined = await setupClientsByTime(refreshTimeIntervalMS, nServerNodes, maxClientNodes, setupTimeMS),
				    elapsed => `Created ${nJoined} / ${elapsed} = ${(elapsed/nJoined).toFixed(3)} client nodes/second.`);
	  if (startThrashingBefore === 'writing') await startThrashing(nServerNodes, refreshTimeIntervalMS);
	  await delay(runtimeBeforeWriteMS, 'pause before writing');
	  elapsed = await timed(async _ => nWritten = await parallelWriteAll(), // Alt: serialWriteAll
				elapsed => `Wrote ${nWritten} / ${elapsed} = ${Math.round(nWritten/elapsed)} nodes/second.`);
	}, setupTimeMS + runtimeBeforeWriteMS + runtimeBeforeWriteMS + 3 * setupTimeMS);
	afterAll(async function () {
	  await shutdownClientNodes(nServerNodes, nJoined);
	  expect(await getContactsLength()).toBe(nServerNodes); // Sanity check.
	});
	it("handles at least 100.", async function () {
	  const total = await getContactsLength();
	  expect(total).toBe(nJoined + nServerNodes); // Sanity check
	  expect(nWritten).toBe(total);
	});
	it("can be read.", async function () {
	  if (startThrashingBefore === 'reading') await startThrashing(nServerNodes, refreshTimeIntervalMS);
	  await delay(runtimeBeforeReadMS, 'pause before reading');
	  let nRead = 0;
	  await timed(async _ => nRead = await parallelReadAll(), // alt: serialReadAll
		      elapsed => `Read ${nRead} / ${elapsed} = ${Math.round(nRead/elapsed)} values/second.`);
	  expect(nRead).toBe(nWritten);
	}, 10 * setupTimeMS + runtimeBeforeReadMS);
      });
    });
  }
  // Each call here sets up a full suite of tests with the given parameters, which can be useful for development and debugging.
  // For example:
  test({refreshTimeIntervalMS: 0, startThrashingBefore: 'never'}); // Flat out with no probing or disconnects
  //test({runtimeBeforeWriteMS: 5e3, startThrashingBefore: 'never'}); // Overwhelms a simulation with so much probing.
  test({maxClientNodes: 50, refreshTimeIntervalMS: 5e3, startThrashingBefore: 'creation'}); // A few clients, on a short interval.

  // To pass, we need to work with the default parameters, and assess the output.
  //test();
  // TODO:
  // maxConnections
  // collect and confirm data from each node on shutdown.
  // pub/sub
  // 1k nodes
});
