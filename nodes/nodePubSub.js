import { NodeProbe } from './nodeProbe.js';
import { StorageItem, StorageBag } from './storageBag.js';

export class NodePubSub extends NodeProbe {
  eventHandlers = new Map(); // key => function(key, StorageItem));
  renewals = new Map(); // key => timer
  clearRenewals() {
    this.storage.values().forEach(bag => clearTimeout(bag.timer));
  }
  async subscribe({eventName, key = NodeProbe.key(eventName), handler, expiration = SubStorageItem.expiration, autoRenewal = false, ...rest}) {
    // Subscribe to events at key, which can be specified by name or directly.
    // Cancel by specifying same subject as before, and null payload.
    //
    // Each storing node will expire after min(expiration, SubStorageItem.expiration).
    // Renewal is triggered here, as long as we are connected.
    key = await key;
    const subject = this.name;
    const issuedTime = Date.now();
    const renewal = autoRenewal && handler && 0.9 * Math.min(expiration, SubStorageItem.expiration);
    const payload = handler ? this.name : null;
    if (handler) this.eventHandlers.set(key, handler);
    else {
      this.ourEventData.delete(key);
      this.eventHandlers.delete(key);
      this.renewals.delete(key);
    }

    if (renewal) {
      this.renewals.set(key,
			setTimeout(() => this.eventHandlers.has(key) && // i.e., not since cancelled
				   this.subscribe({...rest, eventName, key, handler, expiration, autoRenewal}), renewal));
    }
    return await this.storeValue(key, [{...rest, type: 'sub', subject, payload, issuedTime, expiration}]);
  }
  publish({eventName, key, payload, subject = payload.toString(), issuedTime = Date.now(), immediate = false, ...rest}) {
    // Publish payload to all subscribers of key, which can be specified by name or directly.
    // Cancel by specifying same subject as before, and null payload.

    // If key was supplied, we can execute immediate requests synchronously. If not, we need to hash and then execute.
    if (!key) {
      return NodeProbe.key(eventName)
	.then(key => this.publish({eventName, key, payload, subject, issuedTime, immediate, ...rest}));
    }

    if (immediate && this.eventHandlers.get(key)) {
      this.event(key, {subject, issuedTime, payload, ...rest}); // Receive event now, without waiting for network. We will ignore the echo.
    }
    return this.storeValue(key, [{...rest, type: payload === undefined ? 'ext' : 'pub', subject, payload, issuedTime}]);
  }
  ourEventData = new Map(); // The current data to which we have subscribed.
  event(key, {subject, issuedTime, payload, ...rest}) { // Handler for 'event' RPC. Dispatches to the handler.
    let existingValue = this.ourEventData.get(key);
    if (!existingValue) this.ourEventData.set(key, existingValue = new StorageBag());
    existingValue.merge([{...rest, type: 'event', subject, issuedTime, payload}], this, key);
    return 'pong';
  }
}

export class EventStorageItem extends StorageItem { // An event received at a subscriber. Only fires handler on new data for subject.
  static type = 'event';
  static expiration = Infinity;
  merge1(now, storageBag, node, key) {
    const storageItem = super.merge1(now, storageBag, node, key);
    if (!storageItem || !node) return storageItem; // A new cancelled event DOES fire, so that apps can know.
    node.log('event @', key, storageItem);
    node.eventHandlers.get(key)?.(storageItem, key);
    return storageItem;
  }
}
EventStorageItem.register();

export class SubStorageItem extends StorageItem { // A subscription.
  static type = 'sub';
  static expiration = 60 * 60e3; // Delete after an hour. Must be renewed by app.
  merge1(now, storageBag, node, key) {
    const subscriberItem = super.merge1(now, storageBag, node, key);
    if (!subscriberItem || subscriberItem.isCancelled) return subscriberItem;
    const publications = Object.values(storageBag.types.pub || {});
    node?.contact?.ensureRemoteContact(subscriberItem.payload).then(contact => {
      if (!contact.isRunning) return; // Don't attempt delivery to known-dead subscribers (J1).
      for (const publicationItem of publications) {
	if (publicationItem.isCancelled) continue; // We do NOT fire previously cancelled publications at new subscriptions.
	contact.sendRPC('event', key, publicationItem.toJSON());
      }
    });
    return subscriberItem;
  }
}
SubStorageItem.register();


export class PubStorageItem extends StorageItem { // A published datum.
  static type = 'pub';
  static expiration = 24 * 60 * 60e3; // 24 hours
  getLastUpdatedTime(bag) {
    const extension = this.matchingExtension(bag);
    const updateTime = extension?.issuedTime || 0;
    return Math.max(this.issuedTime, updateTime);
  }
  matchingExtension(storageBag) { // Extention matching this publication, if any.
    return storageBag?.types.ext?.[this.subject];
  }
  merge1(now, storageBag, node, key) {
    const publicationItem = super.merge1(now, storageBag, node, key);
    // We DO fire newly cancelled publication on existing (uncancelled) subscriptions.
    if (!publicationItem) return publicationItem;
    const subscriptions = Object.values(storageBag.types.sub || {});
    if (this.debug) node?.flog('subscripts for new publication', key, publicationItem, subscriptions);
    for (const subscriberItem of subscriptions) {
      if (subscriberItem.isCancelled) continue;
      node?.contact?.ensureRemoteContact(subscriberItem.payload)
	.then(contact => {
	  if (!contact.isRunning) return; // Don't attempt delivery to known-dead subscribers (J1).
	  contact.sendRPC('event', key, publicationItem.toJSON());
	});
    }
    return publicationItem;
  }
}
PubStorageItem.register();

export class ExtStorageItem extends StorageItem { // Extended expiration on a published item.
  // Signed data just like 'pub' and 'sub', but typically by a different owner than the 'pub'.
  static type = 'ext';
  static expiration = PubStorageItem.expiration;
  matchingPublication(storageBag) { // Publication matching this extension, if any.
    return storageBag.types.pub?.[this.subject];
  }
  merge1(now, storageBag, node, key) {
    NodeProbe.assert(this.payload === undefined, 'Cannot specify payload in extension', this);
    const extensionItem = super.merge1(now, storageBag, node, key);
    // Side effect of successful merge is to reset the expiration of any matching 'pub'.
    const publicationItem = this.matchingPublication(storageBag);
    if (publicationItem && !publicationItem.isCancelled) {
      publicationItem.resetTimer({now, storageBag, node, key});
    }
    return extensionItem;
  }
}
ExtStorageItem.register();
