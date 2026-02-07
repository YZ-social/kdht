import { NodeProbe } from './nodeProbe.js';
import { StorageItem } from './storageBag.js';

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
  async publish({eventName, key = NodeProbe.key(eventName), payload, subject = payload}) {
    // Publish payload to all subscribers of key, which cn be specified by name or directly.
    // Cancel by specifying same subject as before, and null payload.

    // TODO? Should this call event locally first (if subscribed) and then have event ignore same subject later, or is that for the application to do?
    return await this.storeValue(await key, [{
      type: 'pub',
      subject,
      payload, 
      issuedTime: Date.now()}]);
  }
  event(key, storageItem) { // Handler for 'event' RPC. Dispatches to the handler.
    this.ilog('event @', key, storageItem);
    this.eventHandlers.get(key)?.(storageItem, key);
  }
}

export class SubStorageItem extends StorageItem {
  static type = 'sub';
  static expiration = 60 * 60e3; // Delete after an hour. Must be renewed by app.
  merge1(now, storageBag, node, key) {
    const subscriberItem = super.merge1(now, storageBag, node, key);
    if (!subscriberItem || subscriberItem.isCancelled) return subscriberItem;
    const publications = Object.values(storageBag.types.pub || {});
    node?.contact?.ensureRemoteContact(subscriberItem.payload).then(contact => {
      for (const publicationItem of publications) {
	if (publicationItem.isCancelled) continue;
	contact.sendRPC('event', key, publicationItem);
      }
    });
    return subscriberItem;
  }
}
SubStorageItem.register();


export class PubStorageItem extends StorageItem {
  static type = 'pub';
  static expiration = 10 * 60e3; // 10 minutes
  merge1(now, storageBag, node, key) {
    const publicationItem = super.merge1(now, storageBag, node, key);
    if (!publicationItem || publicationItem.isCancelled) return publicationItem;
    const subscriptions = Object.values(storageBag.types.sub || {});
    for (const subscriberItem of subscriptions) {
      //fixme node?.log('publish', {subscriberItem, publicationItem});
      node?.contact?.ensureRemoteContact(subscriberItem.payload)
	.then(contact => contact.sendRPC('event', key, publicationItem));
    }
    return publicationItem;
  }
}
PubStorageItem.register();
