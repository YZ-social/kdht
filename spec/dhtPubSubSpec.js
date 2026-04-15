import { Node, StorageBag, StorageItem, PubStorageItem, SubStorageItem, ExtStorageItem } from '../index.js';
const { describe, it, expect, beforeAll, afterAll, BigInt} = globalThis; // For linters.

describe('DHT pubsub', function () {
  function shuffle(array) { // tests are randomized, but before- function are executed in order.
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]]; // ES6 destructuring swap
    }
    return array;
  }
  describe('low-level', function () {
    describe('eventually-consistent merging', function () { // We cannot count on the network to deliver items in a consistent order.
      let store = new StorageBag();
      let items = [];
      let timeBase;
      for (const type of ['pub', 'sub', 'ext']) {
	let isExtension = type === 'ext';
	for (const subject of ['a', 'b']) {
	  for (const issuedTime of [1, 2, 3]) {
	    beforeAll(function () {
	      items.push({
		type, subject,
		issuedTime: isExtension ? issuedTime + 4 : issuedTime,
		payload: isExtension ? undefined : subject+issuedTime
	      });
	    });
	  }
	  describe(`type ${type} subject ${subject}`, function () {
	    it('keeps only latest.', function () {
	      expect(store.types[type][subject].payload).toBe(isExtension ? undefined : subject+3);
	    });
	    it('expires on schedule.', function () {
	      let item = store.types[type][subject];
	      let lastUpdate = item.getLastUpdatedTime(store);
	      let updated = type === 'sub' ? timeBase + 3 : timeBase + 3 + 4; // ext and pub should match, regardless of the order
	      expect(lastUpdate).toBe(updated);
	    });
	  });
	}
	it(`type ${type} keeps all subjects.`, function () {
	  expect(Object.keys(store.types[type]).sort()).toEqual(['a', 'b']);
	});
      }
      beforeAll(function () {
	timeBase = Date.now() - 8; // For .merge(), update each item.issuedTime from relative to absolute now.
	items.forEach(properties => properties.issuedTime += timeBase);
	store.merge(StorageBag.ensureItems(shuffle(items)));
      });
    });
  });
});
