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
    if (this.constructor.diagnosticTrace) {
      this.log(`store RPC received: key=${key}, value=${value}`);
    }
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

  receiveRPC(method, sender, ...rest) { // Process a deserialized RPC request, dispatching it to one of the above.
    this.constructor.assert(typeof(method)==='string', 'no method', method);
    this.constructor.assert(sender instanceof Contact, 'no sender', sender);
    this.constructor.assert(sender.host.key === this.key, 'sender', sender.host.name, 'not on receiver', this.name);
    // The sender exists, so add it to the routing table, but asynchronously so as to allow it to finish joining.
    this.addToRoutingTable(sender);
    return this[method](...rest);
  }
}
