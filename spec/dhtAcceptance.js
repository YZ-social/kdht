// Defines a repeatable suite of tests that confirm DHT operations and log performance data.

// Defined by the generic test framework. See https://jasmine.github.io/
// One does not import these definitions from a file, but rather they are
// defined globally by the jasmine program or browser page that runs the tests.
const { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach} = globalThis; // For linters.

// The file dhtImplementation.js exports functions that perform setup operations whose
// implementation changes for different DHTs.
import { setupServerNodes, shutdownServerNodes,
	 setupClientsByTime, shutdownClientNodes,
	 getContacts, write1, read1 } from './dhtImplementation.js';
import { Node } from '../index.js'; // fixme remove

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
  const elapsed = Date.now() - startTime;
  console.log(await logString(elapsed/1e3));
  return elapsed;
}
async function getContactsLength() {
  // Promise current length of contacts. (Convenience for sanity checks.)
  const contacts = await getContacts();
  return contacts.length;
}
function delay(ms) { // This shouldn't ever be necessary. Handy for debugging.
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function parallelWriteAll() {
  // Persist a unique string through each contact all at once, but not resolving until all are ready.
  const contacts = await getContacts();
  // The key and value are the same, to facilitate read confirmation.
  const writePromises = await Promise.all(contacts.map((contact, index) => write1(contact, index, index)));
  return writePromises.length;
}
async function serialWriteAll() {
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
    let randomIndex = Math.floor(Math.random() * contacts.length);
    const randomContact = contacts[randomIndex];
    const value = await read1(randomContact, index);
    if (value !== index) {
      console.log('No read from', randomContact.node.report(), 'of', contacts[index].node.report());
      console.log('read from home', await read1(contacts[index], index));
      console.log('second read from random', await read1(randomContact, index));
      process.exit(1);
    }
    expect(value).toBe(index);
  }));
  return readPromises.length;
}
async function serialReadAll() {
  const contacts = await getContacts();
  for (let index = 0; index < contacts.length; index++) {
    let randomIndex = Math.floor(Math.random() * contacts.length);
    const randomContact = contacts[randomIndex];
    const value = await read1(randomContact, index);
    expect(value).toBe(index);
  }
  return contacts.length;
}


describe("DHT", function () {
  function test(parameters) {
    // Define a suite of tests with the given parameters.
    const {nServerNodes, refreshTimeIntervalMS} = parameters;
    const suiteLabel = JSON.stringify(parameters);
    
    describe(suiteLabel, function () {
      beforeAll(async function () {
	console.log(suiteLabel);
	await timed(_ => setupServerNodes(nServerNodes),
		    elapsed => `Setup ${nServerNodes} server nodes in ${elapsed} seconds.`);
	expect(await getContactsLength()).toBe(nServerNodes);
      });
      afterAll(async function () {
	await shutdownServerNodes(nServerNodes);
	expect(await getContactsLength()).toBe(0);
      });

      describe("joins within a refresh interval", function () {
	let nJoined = 0, nWritten = 0;
	beforeAll(async function () {
	  let elapsed = await timed(async _ => nJoined = await setupClientsByTime(refreshTimeIntervalMS),
				    elapsed => `Created ${nJoined} client nodes in ${elapsed} seconds.`);
	  expect(elapsed).toBeLessThan(refreshTimeIntervalMS + 500); // Sanity check, allowing for timer slop.
	  elapsed = await timed(async _ => nWritten = await parallelWriteAll(), // Alt: serialWriteAll
				elapsed => `Wrote ${nWritten} nodes in ${elapsed} seconds.`);
	}, 4 * refreshTimeIntervalMS); // Allowance: 1 period for setup, and 3 more for store.
	afterAll(async function () {
	  await shutdownClientNodes(nJoined);
	  expect(await getContactsLength()).toBe(nServerNodes); // Sanity check.
	});
	it("handles at least 100.", async function () {
	  expect(nJoined).toBeGreaterThan(100); // As an minimum.
	  const total = await getContactsLength();
	  expect(total).toBe(nJoined + nServerNodes); // Sanity check
	  expect(nWritten).toBe(total);
	});
	it("can be read.", async function () {
	  let nRead = 0;
	  await timed(async _ => nRead = await parallelReadAll(), // alt: serialReadAll
		      elapsed => `Read ${nRead} values in ${elapsed} seconds.`);
	  expect(nRead).toBe(nWritten);
	}, 4 * refreshTimeIntervalMS);
      });
    });
  }
  // If refresh is turned off, 15 second interval gives 1740 nodes, 13 seconds to write, 1.2 seconds to read.
  test({nServerNodes: 10, refreshTimeIntervalMS: 15e3});
});
