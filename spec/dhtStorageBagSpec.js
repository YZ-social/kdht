import { Node, StorageBag, StorageItem } from '../index.js';
const { describe, it, expect, beforeAll, afterAll, BigInt} = globalThis; // For linters.

describe("DHT storageBag", function () {  
  let storageBag = new StorageBag();
  let now = Date.now();
  let initialStorageItems = [ // Initial data, in sorted form
    {type:'raw', subject:'foo', issuedTime:now-1, payload:'foo1'},
    {type:'raw', subject:'bar', issuedTime:now-2, payload:'bar2'}
  ];
  storageBag.merge(initialStorageItems);
  // The order of storageItem is NOT defined. When we compare storageItems we will sort by type and then by subject.
  function sort(storageItems) {
    return storageItems.sort(({type:typeA, subject:subjectA}, {type:typeB, subject:subjectB}) =>
      typeA.localeCompare(typeB) || subjectA.localeCompare(subjectB));
  }
  const sortedStorageItems = sort(initialStorageItems);

  it("has internal data for subject.", function () {
    const inputStorageItem = initialStorageItems.find(storageItem => storageItem.type === 'raw' && storageItem.subject === 'foo');
    const {issuedTime, payload} = storageBag.types.raw.foo;
    expect(issuedTime).toBe(inputStorageItem.issuedTime);
    expect(payload).toBe(inputStorageItem.payload);
  });
  it("converts to a list of POJOs.", function () {
    expect(sort(storageBag.toJSON())).toEqual(sortedStorageItems);
  });    
  it("serializes as JSON.", function () {
    const serialized = JSON.stringify(storageBag); // JSON.stringify calls storageBag.toJSON() and then stringifies that.
    const storageItems = JSON.parse(serialized);
    expect(sort(storageItems)).toEqual(sortedStorageItems);
  });

  describe("merge raw", function () {
    let newer;
    beforeAll(function () {
      newer = Date.now();
      storageBag.merge([{type:"raw", subject:"foo", issuedTime:newer, payload:"nextFoo"},
			{type:"raw", subject:"bar", issuedTime:now-3, payload:"priorBar"}]);
      // node and key can be left off of merge if there are no side effects.
    });
    it("adds newer items for a subject.", function () {
      const {payload} = storageBag.types.raw.foo;
      expect(payload).toBe('nextFoo');
    });
    it("rejects older items for a subject.", function () {
      const {payload} = storageBag.types.raw.bar;
      expect(payload).toBe('bar2');
    });
    afterAll(async function () { // Get things back to state before this suite, so that tests can run in any order.
      let expiration = StorageItem.expiration;
      StorageItem.expiration = 20;
      storageBag.merge([{type:"raw", subject:"foo", payload:null}]);
      StorageItem.expiration = expiration;
      expect(storageBag.types.raw.foo.payload).toBe(null);
      await Node.delay(2e3); // wait for that to expire
      storageBag.merge([{type:"raw", subject:"foo", issuedTime:now-1, payload:"foo1"}]); // Older than the one was added+deleted in this suite.
      expect(storageBag.types.raw.foo.payload).toBe('foo1');
      expect(storageBag.types.raw.bar.payload).toBe('bar2');
    });
  });
});
