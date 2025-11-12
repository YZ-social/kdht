import { Node, SimulatedContact, SimulatedOverlayContact } from '../index.js';
const { describe, it, expect, beforeAll, afterAll, BigInt} = globalThis; // For linters.

const Contact = SimulatedContact;
//const Contact = SimulatedOverlayContact;

describe("DHT operations", function () {
  describe("solo system", function () {
    let contact;
    beforeAll(async function () {
      contact = await SimulatedContact.create();
    });
    it("has node.", function () {
      expect(contact.node).toBeInstanceOf(Node);
    });
    it("has node with contact.", function () {
      expect(contact.node.contact).toBe(contact);
    });
    it("has name.", function () {
      expect(typeof contact.name).toBe('string');
      expect(contact.name).toBeTruthy();
      expect(contact.name).toBe(contact.node.name);
    });
    it("has key.", async function () {
      expect(typeof contact.key).toBe('bigint');
      expect(contact.key).toBe(contact.node.key);
      expect(contact.key).toBe(await Node.key(contact.name));
    });
    it("locateNodes answers only itself.", async function () {
      let best = await contact.node.locateNodes(Node.zero);
      expect(best.length).toBe(1);
      expect(best[0].key).toBe(contact.key);
    });
  });
  describe("binary system", function () {
    let contact, other;
    beforeAll(async function () {
      other = await SimulatedContact.create();
      contact = await SimulatedContact.create();
      await contact.join(other);
    });
    it("locates other.", async function () {
      let found = await contact.node.locateNodes(other.key);
      expect(found.map(helper => helper.key)).toEqual([other.key, contact.key]);
    });
    it("locates self with other.", async function () {
      let found = await contact.node.locateNodes(contact.key);
      expect(found.map(helper => helper.key)).toEqual([contact.key, other.key]);
    });
  });
  function test(size) {
    describe(`Network of size ${size}`, function () {
      let expectedLength = Math.min(size, Node.k);
      let contacts = [];
      function reportAll() {
	for (let i = 0; i < size; i++) contacts[i].node.report();
      }
      beforeAll(async function () {
	const start = Date.now();
	const promises = [];
	let counter = 0;
	let last = start;
	async function make1(i) {
	  const contact = await Contact.create(i);
	  contacts.push(contact);
	  if (i > 0) await contact.join(contacts[0]);
	  if (counter++ % 500 === 0) {
	    const now = Date.now();
	    const since = now - last;
	    last = now;
	    console.log(`${counter - 1}: +${Math.round(since / 1e3)} s`);
	  }
	}
	await make1(0);
	for (let i = 1; i < size; i++) promises.push(make1(i));
	await Promise.all(promises);
	const elapsed = Date.now() - start;
	console.log(`Creating ${size} nodes took ${elapsed/1e3} seconds, or ${elapsed/size} ms/node.`);
	//reportAll();
      }, 50 * size);
      afterAll(function () {
	//contacts[contacts.length - 1].host.report();
	//reportAll();
      });
      async function test1(i, j) {
	it(`allows node ${i} to locate node ${j}.`, async function () {
	  const from = contacts[i];
	  const to = contacts[j];
	  const target = to.key;
	  const found = await from.node.locateNodes(target);
	  const bestKey = found[0].key;
	  expect(found.length).toBe(expectedLength);
	  expect(bestKey).toBe(target);
	});
      }
      async function testStore(i) {
	let retrieving = Math.floor(Math.random() * size);
	let key = Math.random();
	let value = Math.random();
	it(`stores through ${i} and retrieves through ${retrieving}.`, async function () {
	  await contacts[i].node.storeValue(key, value);
	  const retrieved = await contacts[retrieving].node.locateValue(key);
	  expect(retrieved).toBe(value);
	});
      }
      for (let i = 0; i < size; i++) { // Test that each node can reach stuff.
	if (size <= 100) { // Test that node i can reach every node j.
	  for (let j = 0; j < size; j++) test1(i, j);
	} else { // Too many nodes to test every combination. Just test against one random j.
	  test1(i, Math.floor(Math.random() * size));
	}
	testStore(i);
      }
    });
  }
  for (let size = 1; size < 4; size++) test(size);
  for (let size = 4; size <= 40; size+=4) test(size);
  test(100);
  //test(1e3);
  //test(10e3);
  //test(50e3);
});
