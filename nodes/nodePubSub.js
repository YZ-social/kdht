import { NodeProbe } from './nodeProbe.js';
import { StorageItem, StorageBag } from './storageBag.js';

export class NodePubSub extends NodeProbe {
  eventHandlers = new Map(); // key => function(key, StorageItem)
  async subscribe({eventName, key = NodeProbe.key(eventName), handler}) {
    // Subscribe to events at key, which can be specified by name or directly.
    // Cancel by specifying same subject as before, and null payload.
    key = await key;
    if (handler) this.eventHandlers.set(key, handler);
    else this.eventHandlers.delete(eventName);

    return await this.storeValue(key, [{
      type: 'sub',
      subject: this.name,
      payload: handler ? this.name : null,
      issuedTime: Date.now()
    }]);
  }
  async publish({eventName, key = NodeProbe.key(eventName), payload, subject = payload, issuedTime = Date.now(), immediate = false}) {
    // Publish payload to all subscribers of key, which cn be specified by name or directly.
    // Cancel by specifying same subject as before, and null payload.
    key = await key;
    if (immediate && this.eventHandlers.get(key)) {
      this.event(key, {subject, issuedTime, payload}); // Receive event now, without waiting for network. We will ignore the echo.
    }
    return await this.storeValue(key, [{type: 'pub', subject, payload, issuedTime}]);
  }
  ourEventData = new Map(); // The current data to which we have subscribed.
  event(key, {subject, issuedTime, payload}) { // Handler for 'event' RPC. Dispatches to the handler.
    let existingValue = this.ourEventData.get(key);
    if (!existingValue) this.ourEventData.set(key, existingValue = new StorageBag());
    existingValue.merge([{type: 'event', subject, issuedTime, payload}], this, key);
    return 'pong';
  }
}

export class EventStorageItem extends StorageItem { // An event received at a subscriber. Only fires handler on new data for subject.
  static type = 'event';
  static expiration = Infinity;
  merge1(now, storageBag, node, key) {
    const storageItem = super.merge1(now, storageBag, node, key);
    if (!storageItem || !node) return storageItem; // A new cancelled event DOES fire, so that apps can know.
    node.ilog('event @', key, storageItem);
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
  static expiration = 10 * 60e3; // 10 minutes
  merge1(now, storageBag, node, key) {
    const publicationItem = super.merge1(now, storageBag, node, key);
    // We DO fire newly cancelled publication on existing (uncancelled) subsccriptions.
    if (!publicationItem) return publicationItem;
    const subscriptions = Object.values(storageBag.types.sub || {});
    for (const subscriberItem of subscriptions) {
      if (subscriberItem.isCancelled) continue;
      node?.contact?.ensureRemoteContact(subscriberItem.payload)
	.then(contact => {
	  contact.sendRPC('event', key, publicationItem.toJSON());
	});
    }
    return publicationItem;
  }
}
PubStorageItem.register();
