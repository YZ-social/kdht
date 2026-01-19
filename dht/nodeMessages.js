import { NodeContacts } from './nodeContacts.js';
import { Contact } from '../transports/contact.js';

// The four methods we recevieve through RPCs.
// These are not directly invoked by a Node on itself, but rather on other nodes
// through Contact sendRPC.
export class NodeMessages extends NodeContacts {
  ping(key) { // Respond with 'pong'. (RPC mechanism doesn't call unless connected.)
    return 'pong'; // Answer something truthy. See isValueResult.
  }
  store(key, value) { // Tell the node to store key => value, returning truthy.
    this.storeLocally(key, value);
    return 'pong'; // Answer something truthy. See isValueResult.
  }
  findNodes(key) { // Return k closest Contacts from routingTable.
    // TODO: Currently, this answers a list of Helpers. For security, it should be changed to a list of serialized Contacts.
    // I.e., send back a list of verifiable signatures and let the receiver verify and then compute the distances.
    return this.findClosestHelpers(key);
  }
  findValue(key) { // Like findNodes, but if we have key stored, return {value} instead.
    let value = this.retrieveLocally(key);
    if (value !== undefined) return {value};
    return this.findClosestHelpers(key);
  }
  async signals(key, signals) {
    //this.xlog(this.key, 'handling signals request', key, signals);
    await this.constructor.delay(100); // fixme remove
    const contact = this.findContactByKey(key);
    if (!this.isRunning) { this.xlog('was asked to sponsor signals to', contact?.name, 'but is no longer running'); return null; }
    if (this.key === key) return [this.name];
    if (!contact) return null;
    //const forwarded = ['forward-to-' + contact?.name + '-through-' + this.name ];
    const forwarded = await contact.sendRPC('signals', key, signals);
    //this.xlog('got forwarded value', forwarded, 'from', contact.sname, !!contact.connection);
    return forwarded;
  }

  messageResolvers = new Map(); // maps outgoing message tag => promise resolver being waited on.
  receiveRPC(method, sender, ...rest) { // Process a deserialized RPC request, dispatching it to one of the above.
    this.constructor.assert(typeof(method)==='string', 'no method', method, sender, rest);
    this.constructor.assert(sender instanceof Contact, 'no sender', method, sender, rest);
    this.constructor.assert(sender.host.key === this.key, 'sender', sender.host.name, 'not on receiver', this.name);
    // The sender exists, so add it to the routing table, but asynchronously so as to allow it to finish joining.
    this.addToRoutingTable(sender);
    if (!(method in this)) {
      this.xlog('Does not handle method', method);
      return null;
    }
    return this[method](...rest);
  }
}
