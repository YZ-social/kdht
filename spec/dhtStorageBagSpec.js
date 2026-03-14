import { Node, StorageBag, StorageItem, PubStorageItem, SubStorageItem } from '../index.js';
const { describe, it, expect, beforeAll, afterAll, BigInt} = globalThis; // For linters.


describe("DHT storageBag", function () {
  // The order of storageItem is NOT defined. When we compare storageItems we will sort by type and then by subject.
  function sort(storageItems) {
    return storageItems.sort(({type:typeA, subject:subjectA}, {type:typeB, subject:subjectB}) =>
      typeA.localeCompare(typeB) || subjectA.localeCompare(subjectB));
  }
  let rpcTrace = {};
  let dummyNode = {
    contact: {
      ensureRemoteContact(nodeName) {
	return Promise.resolve({
	  isRunning: true,
	  sendRPC(method, key, {payload}) {
	    if (method !== 'event') throw new Error('Unexpected method', method);
	    if (key !== 42) throw new Error('Unexpected key', key);
	    let received = rpcTrace[nodeName] ||= [];
	    received.push(payload);
	  }
	});
      }
    }
  };
  let storageBag, initialStorageItems, sortedStorageItems, now;

  beforeAll(function () {
    // Even though this synchronous, it cannot be at load time, because there might be StorageItem.expiration tests before running.
    storageBag = new StorageBag();
    now = Date.now();
    initialStorageItems = [ // Initial data, in sorted form
      {type:'raw', subject:'foo', issuedTime:now-1, payload:'foo1'},
      {type:'raw', subject:'bar', issuedTime:now-2, payload:'bar2'},
      {type:'pub', subject:'red', issuedTime:now-3, payload:'red3'},
      {type:'pub', subject:'blue', issuedTime:now-4, payload:'blue4'},
      {type:'sub', subject:'red', issuedTime:now-5, payload:'fred5'},
      {type:'sub', subject:'blue', issuedTime:now-6, payload:'sue6'},
      {type:'sub', subject:'white', issuedTime:now-7, payload:'dwight7'}
    ];
    storageBag.merge(initialStorageItems, dummyNode, 42);
    sortedStorageItems = sort(initialStorageItems);
  });

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
      storageBag.merge([
	{type:"raw", subject:"foo", issuedTime:newer, payload:"nextFoo"},
	{type:"raw", subject:"bar", issuedTime:now-3, payload:"priorBar"},
      ]);
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
      await Node.delay(1); // Just in case we are still at the previous merge's clock tick.
      const expiration = StorageItem.expiration;
      StorageItem.expiration = 300; // Enough time to add the null payload and confirm that it is there, even while under load.
      storageBag.merge([{type:"raw", subject:"foo", payload:null}]);
      StorageItem.expiration = expiration;
      expect(storageBag.types.raw.foo.payload).toBe(null);
      await Node.delay(1e3); // wait for the new payload to expire, so that we can add the original time back.
      storageBag.merge([{type:"raw", subject:"foo", issuedTime:now-1, payload:"foo1"}]); // Older than the one was added+deleted in this suite.
      expect(storageBag.types.raw.foo.payload).toBe('foo1');
      expect(storageBag.types.raw.bar.payload).toBe('bar2');
    });
  });

  describe("merge pubsub", function () {
    beforeAll(function () {
      storageBag.merge([{type:'pub', subject:'white', payload: 'white now'}], dummyNode, 42);
    });
    it("misses nothing.", function () {
      expect(Object.values(rpcTrace.fred5).sort()).toEqual(['blue4', 'red3', 'white now']);
      expect(Object.values(rpcTrace.sue6).sort()).toEqual(['blue4', 'red3', 'white now']);
      expect(Object.values(rpcTrace.dwight7).sort()).toEqual(['blue4', 'red3', 'white now']);
    });
    afterAll(async function () { // Unpublish
      await Node.delay(1); // a new "now"
      storageBag.merge([{type:'pub', subject:'white', payload: null}], dummyNode, 42);
    });
  });

  afterAll(async function () { // Remove all and confirm that bag goes away.
    await Node.delay(1); //a new "now"
    let node = {storage: new Map()};
    let key = 42;
    node.storage.set(key, storageBag);
    const expiration = StorageItem.expiration;
    const pubExpiration = PubStorageItem.expiration;
    const subExpiration = SubStorageItem.expiration;
    StorageItem.expiration = PubStorageItem.expiration = SubStorageItem.expiration = 20;
    storageBag.merge([
      {type:"raw", payload:'foo'}, {type:"raw", payload:'bar'},
      {type:"pub", payload:'red'}, {type:"pub", payload:'blue'}, {type:"pub", payload:'white'},
      {type:"sub", payload:'red'}, {type:"sub", payload:'blue'}, {type:"sub", payload:'white'}
    ], node, key);
    StorageItem.expiration = expiration;
    PubStorageItem.expiration = pubExpiration;
    SubStorageItem.expiration = subExpiration;
    await Node.delay(1e3); // wait for that to expire
    expect(node.storage.size).toBe(0);
  });
});
