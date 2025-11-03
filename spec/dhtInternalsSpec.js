import { Node, KBucket } from '../index.js';
const { describe, it, expect, beforeAll, afterAll, BigInt} = globalThis; // For linters.

describe("DHT internals", function () {

  describe("structure", function () {
    let example;
    beforeAll(async function () {
      example = await Node.create(0);
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
      
 //    describe("report", function () {
 //      beforeAll(async function () { // Add some data for which we know the expected internal structure.
 // 	example.storeLocally(await Identifier.create("foo"), 17); // May or may not have already been set to same value, depending on test order.
 // 	example.storeLocally(await Identifier.create("bar"), "baz");
 // 	example.routingTable[90] = [Entry.fromOtherNode(example, await Node.create(1)),
 // 				    Entry.fromOtherNode(example, await Node.create(2))];
 // 	example.replacementCache[90] = [await Node.create(3),
 // 					await Node.create(4)];
 //      });
 //      afterAll(function () {
 // 	example.routingTable[90] = example.replacementCache[90] = undefined;
 //      });
 //      it("includes name, routing/replacement names and stored items by bigInt key.", function () {
 // 	// The current implementation uses the classic "fixed size routing tables" - up to k at at each bit position.
 // 	let report = example.report(string => string); // No op for what to do with the report. Just return it.
 // 	expect(report).toBe(`Node 0
 // storing: [["58686998438798322974467776505749455156",17],["336119020696479164089214630533760195420","baz"]]
 // 90: 1, 2 replacements: 3, 4`);
 //      });
 //    });

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
	bucket0.addKey(random[0]);
	bucket0.addKey(random[1]);
	bucket60.addKey(random[2]);
	bucket60.addKey(random[3]);
	node.routingTable.set(0, bucket0);
	node.routingTable.set(60, bucket60);
      });
      it("is initially empty.", async function () {
	const node = await Node.create();
	expect(node.keys).toEqual([]);
      });
      it("collects from all buckets.", function () {
	expect(node.keys).toEqual(random);
      });
      it("finds all ordered keys there are.", function () {
	let target = node.key;
	let keysAndDistances = random.map(key => ({key, distance: Node.distance(target, key)}));
	keysAndDistances.sort(Node.compare);
	expect(node.findClosestKeys(target)).toEqual(keysAndDistances.map(pair => pair.key));
      });
      it("reports name and bucket contents.", function () {
	let report = node.report(string => string);
	let expected = `Node: ${node.name}
  0: ${node.routingTable.get(0).keys.map(k => k.toString() + 'n').join(', ')}
  60: ${node.routingTable.get(60).keys.map(k => k.toString() + 'n').join(', ')}`;
	expect(report).toBe(expected);
      });
    });
    describe("discovery", function () {
      it("does not place self.", function () {
	let node = Node.fromKey(Node.one);
	expect(node.addToRoutingTable(Node.one)).toBeFalsy();
	expect(node.routingTable.size).toBe(0);
      });
      it("places in bucket if room.", function () {
	let node = Node.fromKey(Node.zero);
	let other = Node.fromKey(Node.one); // Closest bucket
	expect(node.addToRoutingTable(Node.one)).toBeTruthy();
	expect(node.getBucketIndex(Node.one)).toBe(0);
	const bucket = node.routingTable.get(0);
	expect(bucket.keys[0]).toBe(Node.one);
      });
      describe("examples", function () {
	const nOthers = Node.k + 40; // k+31 will not overflow. k+40 would overflow to a replacementCache if we used one.
	let node;
	beforeAll(function () {
	  node = Node.fromKey(Node.zero);
	  // These others are all constructed to have distances that increase by one from node.
	  for (let i = 0; i < nOthers; i++) {
	    let other = BigInt(i + 1);
	    node.addToRoutingTable(other);
	  }
	  //node.report();
	});
	it("places k in bucket and then into replacementCache.", function () {
	  // Checks the results of the discover() placement, each other should have filled in starting from the closest end.
	  // Working backwards from the last kBucket, these will all fill in 1, 2, 4, 8, 16 nodes in each bucket.
	  // The next bucket will then fill in k=20, and the rest are replacements for that same bucket index.

	  // Iterate through the buckets, keeping track of the expectCount in each (1, 2, 4, ...)
	  for (let bucketIndex = 0, expectCount = 1, otherBigInt = Node.one, othersLast = BigInt(nOthers );
	       otherBigInt <= othersLast;
	       bucketIndex++, expectCount *= 2) {
	    const bucket = node.routingTable.get(bucketIndex);
	    // Now iterate through the entries in the bucket, up to expectCount or k.
	    let i = 0;
	    for (; i < Math.min(expectCount, Node.k); i++) {
	      const key = bucket.keys[i];
	      expect(key).toBe(otherBigInt++);
	    }
	    if (i >= Node.k) { // Now continue with replacementCache, if anyr
	      const cache = bucket.replacementCache;
	      for (i = 0; otherBigInt <= othersLast; i++) {
		expect(cache[i]).toBe(otherBigInt++);
	      }
	    }
	  }
	});
	it('finds closest keys', function () {
	  const closest = node.findClosestKeys(BigInt(40));
	  expect(closest).toEqual([
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
