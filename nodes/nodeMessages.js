import { NodeContacts } from './nodeContacts.js';
import { Contact } from '../contacts/contact.js';

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
  async signals(key, signals, forwardingExclusions = null, targetNameForDebugging) {
    // Handle an exchange of signals, with a response that may include {result, forwardingExclusions}. See code.

    if (!this.isRunning) { // In case it happens in simulations.
      //this.flog('\n*** not running ***');
      return null;  //{forwardingExclusions}; // FIXME
    }

    // If the key is us, pass the signals to our home contact and respond with the WebRTC signals from the contact.
    // (Subtle: the signals will contain the sender name. The handler in our home contact will create
    // a new specific contact if necessary, and set up the WebRTC through that.)
    // The forwardingExclusions are passed back, in case the sender wants to see the steps involved.
    if (this.key === key) return {result: await this.contact.signals(...signals), forwardingExclusions};

    // If we have a direct connection to the key, pass it on and answer what it tells us.
    // (E.g., if we sponsored target for sender, we will have a direct connection that will answer as above.)
    let contact = this.findContactByKey(key);
    if (contact && contact.connection) {
      forwardingExclusions?.push(this.name); // Keeps stats accurate if sender is examining paths.
      const response = await contact.sendRPC('signals', key, signals, forwardingExclusions, targetNameForDebugging);
      if (response) return response;
      return {forwardingExclusions}; // Subtle: If it fails, return a definitive failure instead of just null.
    }

    // Forward recursively using R/Kademlia routing (if forwardingExclusions provided)
    if (forwardingExclusions) {
      return await this.initiateRecursiveSignals(key, signals, forwardingExclusions, Date.now() + Contact.forwardingTimeoutMS, targetNameForDebugging);
    }

    // We were a sponsor but for a contact has since disconnected. We do not know if they are still connected to others.
    //this.flog('\n*** sponsored disconnected ***');
    return {forwardingExclusions}; // FIXME: Is this definitively right, or should we answer null here?
  }
  messageResolvers = new Map(); // maps outgoing message tag => promise resolver being waited on.
  receiveRPC(method, sender, ...rest) { // Process a deserialized RPC request, dispatching it to one of the above.
    this.constructor.assert(typeof(method)==='string', 'no method', method, sender, rest);
    this.constructor.assert(sender instanceof Contact, 'no sender', method, sender, rest);
    this.constructor.assert(sender.host.key === this.key, 'sender', sender.host.name, 'not on receiver', this.name);
    this.addToRoutingTable(sender); // sender exists, so add it to the routing table.
    if (!(method in this)) {
      this.flog('Does not handle method', method);
      return null;
    }
    return this[method](...rest);
  }
}
