import { Node } from '../index.js';
const { describe, it, expect, BigInt } = globalThis; // For linters.

describe("DHT Keys", function () {

  describe("Node creation", function () {

    describe("from string", function () {
      it("keeps given name.", async function () {
	let name = "something";
	let node= await Node.create(name);
	expect(node.name).toBe(name);
	expect(typeof node.key).toBe('bigint');
      });

      it("can ommit name.", async function () {
	let node = await Node.create();
	expect(typeof node.name).toBe('string');
	expect(typeof node.key).toBe('bigint');
      });
      
      it("has non-negative bigInt.", async function () {
	const key = Math.random();
	const node = await Node.create(key);
	const bigInt = node.key;
	expect(bigInt).toBeGreaterThanOrEqual(0n);
      });
    });
  });

  describe("keySize", function () {
    it("is >= 128.", function () {
      expect(Node.keySize).toBeGreaterThanOrEqual(128);
    });

    it("is a multiple of 8.", function () {
      expect(Node.keySize % 8).toBe(0);
    });

    it("is the max number of bits in the Identifier bigInt.", async function () {
      const example = await Node.create("something else");
      // Not every example will have a leading 1 in the most significant bit, but this one does.
      const binaryString = example.key.toString(2);
      expect(binaryString.length).toBe(Node.keySize);

      const random = await Node.create(Math.random());
      expect(random.key.toString(2).length).toBeLessThanOrEqual(Node.keySize);
    });
  });

  describe("distance", function () {

    it("is xor as a BigInt.", function () {
      // Here we are just spot checking some of the bits.
      let a = BigInt(0b1010);
      let b = BigInt(0b1001);
      let distance = Node.distance(a, b);
      expect(distance).toBe(BigInt(0b11));
    });

    it("is zero from itself.", async function () {
      let random = await Node.create(Math.random());
      let distance = Node.distance(random.key, random.key);
      expect(distance).toBe(0n);
    });

    it("is commutative.", async function () {
      let a = await Node.create(Math.random());
      let b = await Node.create(Math.random());
      let distance1 = Node.distance(a.key, b.key);
      let distance2 = Node.distance(b.key, a.key);
      expect(distance1).toBe(distance2);
    });

    it("is maximum (all nTagBits on) for a complement.", async function () {
      let random = await Node.create(Math.random());
      let key = random.key;
      let flipped = ~key;
      let truncatedFlipped = BigInt.asUintN(Node.keySize, flipped);
      let complementIdentifier = truncatedFlipped;
      let distance = Node.distance(key, complementIdentifier);
      let one = 1n;
      let next = distance + one;
      let max = one << BigInt(Node.keySize);
      expect(next).toBe(max);
    });
  });
});

