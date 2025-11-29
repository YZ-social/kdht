import { NodeUtilities } from './nodeUtilities.js';
const { BigInt, TextEncoder, crypto } = globalThis; // For linters.

// A node name is (coerced to) a string, and a node key is BigInt of keySize.
export class NodeKeys extends NodeUtilities {
  static zero = 0n;
  static one = 1n;
  static keySize = 128; // Number of bits in a key. Must be multiple of 8 and <= sha256.
  static distance(keyA, keyB) { // xor
    return keyA ^ keyB;
  }

  static async sha256(string) { // Promises a Uint8Array containing the hash of string.
    const msgBuffer = new TextEncoder().encode(string);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const uint8Array = new Uint8Array(hashBuffer);
    return uint8Array;
  }
  static uint8ArrayToHex(uint8Array) { // Answer uint8Array as a hex string.
    return Array.from(uint8Array)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
  static async key(string) { // If "string" is already a bigint, return it. Otherwise hash it to a keySize BigInt.
    if (typeof(string) === 'bigint') return string;
    const uint8Array = await this.sha256(string.toString());
    const truncated = uint8Array.slice(0, this.keySize / 8);
    const hex = this.uint8ArrayToHex(truncated);
    const key = BigInt('0x' + hex);
    return key;
  }
  static counter = 0; // If name is not given, use incremented counter.
  static async create(nameOrProperties = {}) { // Create a node with a simple name and matching key.
    if (['string', 'number'].includes(typeof nameOrProperties)) nameOrProperties = {name: nameOrProperties};
    let {name = this.counter++, ...rest} = nameOrProperties;
    name = name.toString();
    const key = await this.key(name);  
    return new this({name, key, ...rest});
  }
  static fromKey(key) { // Forge specific key for testing. The key can be a BigInt or a string that will make a BigInt.
    if (typeof(key) !== 'bigint') key = BigInt(key);
    return new this({name: key.toString() + 'n', key});
  }
}
