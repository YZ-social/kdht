import { Node, KBucket, SimulatedContact, Contact, Helper } from '../index.js';
const { describe, it, expect, beforeAll, afterAll, BigInt} = globalThis; // For linters.

describe("DHT internals", function () {
  beforeAll(function () {
    Node.distinguisher = 0;
  });
  afterAll(function () {
    Node.stopRefresh();
  });

  describe("structure", function () {
    let example;
    beforeAll(async function () {
      const contact = await Contact.create(0);
      example = contact.node;
    });
    it("has key.", function () {
      expect(typeof example.key).toBe('bigint');
    });
    describe("local storage", function () {
      it("stores by Identifier key.", async function () {
	let key = await Node.key("foo");
	let value = 17;
	example.storeLocally(key, value);
	let retrieved = example.retrieveLocally(key);
	expect(retrieved).toBe(value);
      });
      it("retrieves undefined if not set.", async function () {
	let key = await Node.key("not seen");
	let retrieved = example.retrieveLocally(key);
	expect(retrieved).toBeUndefined();
      });
    });
      
    describe("report", function () {
      beforeAll(async function () { // Add some data for which we know the expected internal structure.
	example.storeLocally(await Node.key("foo"), 17); // May or may not have already been set to same value, depending on test order.
	example.storeLocally(await Node.key("bar"), "baz");
	let bucket = new KBucket();
	bucket.contacts.push(await SimulatedContact.fromKey(1));
	bucket.contacts.push(await SimulatedContact.fromKey(2));
	example.routingTable.set(90, bucket);
      });
      afterAll(function () {
	example.routingTable.delete(90);
      });
      it("includes name, routing names and stored items by bigInt key.", function () {
	let report = example.report(string => string); // No op for what to do with the report. Just return it.
	expect(report).toBe(`Node: 0
  storing 2: 58686998438798322974467776505749455156n: 17, 336119020696479164089214630533760195420n: "baz"
  90: 1n, 2n`);
      });
    });

    describe("constants", function () {
      it("alpha >= 3.", function () {
	expect(Node.alpha).toBeGreaterThanOrEqual(3);
      });
      it("k >= 10.", function () {
	expect(Node.k).toBeGreaterThanOrEqual(10);
      });
    });
  });
  
  describe("operations", function () {
    const one = 1n;
    const two = 2n;
    const three = 3n;
    const max = Node.one << BigInt(Node.keySize);
    describe("commonPrefixLength", function () {
      it("is keySize for 0n.", function () {
	expect(Node.commonPrefixLength(Node.zero)).toBe(Node.keySize);
      });
      it("is keySize - 1 for 1n.", function () {
	expect(Node.commonPrefixLength(Node.one)).toBe(Node.keySize - 1);
      });
      it("is 1 for (keySize - 1) ones.", function () {
	expect(Node.commonPrefixLength(BigInt("0b" + "1".repeat(Node.keySize-1)))).toBe(1);
      });
      it("is 0 for keySize ones.", function () {
	expect(Node.commonPrefixLength(BigInt("0b" + "1".repeat(Node.keySize)))).toBe(0);
      });
    });
    describe("getBucketIndex", function () {
      let node;
      beforeAll(function () {
	node = Node.fromKey(Node.zero); 
      });
      it("bucket keySize -1 is farthest.", function () {
	const distance = max - Node.one; // max distance within nTagBits. All bits on.
	expect(node.getBucketIndex(distance)).toBe(Node.keySize - 1);
      });
      it("bucket keySize - 2 is for middle distance.", function () {
	const distance = (max / two) - Node.one;
	expect(node.getBucketIndex(distance)).toBe(Node.keySize - 2);
      });
      it("bucket 1 is for a distance 2.", function () {
	const distance = two;
	expect(node.getBucketIndex(distance)).toBe(1);
      });
      it("bucket 0 is for a closest distance.", function () {
	const distance = Node.one;
	expect(node.getBucketIndex(distance)).toBe(0);
      });
    });
    describe("randomTargetInIndex", function () {
      let node;
      beforeAll(async function () {
	node = await Node.create();
      });
      function test(bucketIndex) {
	it(`computes random of ${bucketIndex}.`, function () {
	  const random = node.randomTargetInBucket(bucketIndex);
	  const computedBucket = node.getBucketIndex(random);
	  expect(computedBucket).toBe(bucketIndex);
	});
      }
      for (let i = 0; i < Node.keySize; i++) test(i);
    });

    describe("examination", function () {
      const random = Array.from({length: 4}, () => BigInt(Math.floor(Math.random() * 1e10)));
      let node;
      beforeAll(async function () {
	// Applications won't be hand-creating the routingTable, but this test does.
	node = await Node.create();
	// In the discovery tests below, we'll put things in the right place and examine results.
	// But for these test here, we're just testing structure and the keys are NOT being put in the right buckets.
	const bucket0 = new KBucket();
	const bucket60 = new KBucket();
	const addTo = (bucket, index) => bucket.addContact(SimulatedContact.fromKey(random[index]));
	addTo(bucket0, 0);
	addTo(bucket0, 1);
	addTo(bucket60, 2);
	addTo(bucket60, 3);
	node.routingTable.set(0, bucket0);
	node.routingTable.set(60, bucket60);
	SimulatedContact.fromNode(node);
      });
      it("is initially empty.", async function () {
	const node = await Node.create();
	expect(node.contacts).toEqual([]);
      });
      it("collects from all buckets.", function () {
	const contacts = node.contacts;
	const asKeys = contacts.map(c => c.key);
	expect(asKeys).toEqual(random);
      });
      it("finds all ordered keys there are.", function () {
	let target = node.key;
	let all = [node.key, ...random]; // Our findClosestHelpers includes ourself.
	let keysAndDistances = all.map(key => ({key, distance: Node.distance(target, key)}));
	keysAndDistances.sort(Helper.compare);
	const closest = node.findClosestHelpers(target);
	const mapped = closest.map(helper => ({key: helper.key, distance: helper.distance}));
	expect(mapped).toEqual(keysAndDistances);
      });
      it("reports name and bucket contents.", function () {
	let report = node.report(string => string);
	let expected = `Node: ${node.name}
  0: ${node.routingTable.get(0).contacts.map(c => c.key.toString() + 'n').join(', ')}
  60: ${node.routingTable.get(60).contacts.map(c => c.key.toString() + 'n').join(', ')}`;
	expect(report).toBe(expected);
      });
    });
    describe("discovery", function () {
      it("does not place self.", async function () {
	let node = Node.fromKey(Node.one);
	expect(await node.addToRoutingTable(SimulatedContact.fromKey(Node.one))).toBeFalsy();
	expect(node.routingTable.size).toBe(0);
      });
      it("places in bucket if room.", async function () {
	let node = Node.fromKey(Node.zero);
	let other = Node.fromKey(Node.one); // Closest bucket
	expect(await node.addToRoutingTable(SimulatedContact.fromKey(Node.one))).toBeTruthy();
	expect(node.getBucketIndex(Node.one)).toBe(0);
	const bucket = node.routingTable.get(0);
	expect(bucket.contacts[0].key).toBe(Node.one);
      });
      describe("examples", function () {
	const nOthers = Node.k + 40; // k+31 will not overflow. k+40 would overflow.
	let node;
	beforeAll(async function () {
	  const host = SimulatedContact.fromKey(Node.zero);
	  node = host.node;
	  // These others are all constructed to have distances that increase by one from node.
	  for (let i = 1; i <= nOthers; i++) {
	    let other = SimulatedContact.fromKey(BigInt(i), host);
	    await node.addToRoutingTable(other);
	  }
	  //node.report();
	});
	it("places k in bucket.", function () {
	  // Checks the results of the discover() placement, each other should have filled in starting from the closest end.
	  // Working backwards from the last kBucket, these will all fill in 1, 2, 4, 8, 16 nodes in each bucket.
	  // The next bucket will then fill in k=20

	  // Iterate through the buckets, keeping track of the expectCount in each (1, 2, 4, ...)
	  for (let bucketIndex = 0, expectCount = 1, otherBigInt = Node.one, othersLast = BigInt(nOthers );
	       otherBigInt <= othersLast;
	       bucketIndex++, expectCount *= 2) {
	    const bucket = node.routingTable.get(bucketIndex);
	    // Now iterate through the entries in the bucket, up to expectCount or k.
	    let i = 0;

	    // Full bucket.contacts can be in a different order because each attempt to add to a full bucket
	    // causes the head of the bucket to be pinged and (if alive) rotated to the back.
	    // So, let's just collect the keys and the expected values, andnd sort the keys for comparison.
	    let keys = bucket.contacts.map(c => c.key);
	    let expecting = [];
	    for (; i < Math.min(expectCount, Node.k); i++) expecting.push(otherBigInt++);
	    const compare = (a, b) => {
	      if (a < b) return -1;
	      if (a > b) return 1;
	      return 0;
	    };
	    keys.sort(compare);
	    expect(keys).toEqual(expecting);

	    if (i >= Node.k) { // Now soak up those dropped, if any. (If we add a bucket replacement cache, it would be checked here.)
	      for (i = 0; otherBigInt <= othersLast; i++) {
		otherBigInt++;
	      }
	    }
	  }
	});
	it('finds closest keys', function () {
	  const closest = node.findClosestHelpers(BigInt(40));
	  const keys = closest.map(helper => helper.key);
	  expect(keys).toEqual([
  40n, 41n, 42n, 43n, 44n,
  45n, 46n, 47n, 32n, 33n,
  34n, 35n, 36n, 37n, 38n,
  39n, 48n, 49n, 50n, 51n
]);
	});
      });
    });
  });
});
