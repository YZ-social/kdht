import { NodeContacts } from './nodeContacts.js';

// The four methods we recevieve through RPCs.
// These are not directly invoked by a Node on itself, but rather on other nodes
// through Contact sendRPC.
export class NodeMessages extends NodeContacts {
  ping(key) { // Respond with 'pong'. (RPC mechanism doesn't call unless connected.)
    return 'pong';
  }
  store(key, value) { // Tell the node to store key => value, returning truthy.
    this.storeLocally(key, value);
    return 'pong';
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
}
