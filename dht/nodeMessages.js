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
  async signals(key, signals, forwardingExclusions = null, targetNameForDebugging) {
    // Handle an exchange of signals, with a response that may include {result, forwardingExclusions}. See code.

    if (!this.isRunning) return {forwardingExclusions}; // Can happen in simulations.

    // If the key is us, pass the signals to our home contact and respond with the WebRTC signals from the contact.
    // (Subtle: the signals will contain the sender name. The handler in our home contact will create
    // a new specific contact if necessary, and set up the WebRTC through that.)
    if (this.key === key) return {result: await this.contact.signals(...signals), forwardingExclusions};

    // If we have a direct connection to the key, pass it on and answer what it tells us.
    // (E.g., if we sponsored target for sender, we will have a direct connection that will answer as above.)
    let contact = this.findContactByKey(key);
    if (contact) forwardingExclusions?.push(this.name); // Keeps stats accurate if sender is examining paths.
    if (contact) return await contact.sendRPC('signals', key, signals, forwardingExclusions, targetNameForDebugging);

    // Forward recursively.
    if (forwardingExclusions) return await this.recursiveSignals(key, signals, forwardingExclusions, targetNameForDebugging);

    // We were a sponsor but contact has since disconnected.
    return {forwardingExclusions};
  }
  static maxTries = Math.pow(this.alpha, 3); // alpha tries at each of three deep.
  async recursiveSignals(key, signals, forwardingExclusions, targetNameForDebugging) { // Forward recursively.
    if (forwardingExclusions.length > this.constructor.maxTries) {
      this.xlog('abandoning wandering path towards', targetNameForDebugging, 'through', forwardingExclusions.join(', '));
      return {forwardingExclusions};
    }
    const helpers = this.findClosestHelpers(key);
    const contacts = helpers.map(helper => helper.contact);
    forwardingExclusions.push(this.name);

    // The target key may not be reachable from here (and might not even still be running).
    // So bound our branching. The total time before giving up is a function of the tree depth.
    let remaining = this.constructor.alpha; // If it's good enough for probing, then it's good enough here.
    for (const contact of contacts) {
      if (!remaining--) break;
      if (!contact.isRunning) continue;
      if (!contact.connection) continue;
      if (forwardingExclusions.includes(contact.name)) continue;
      this.constructor.assert(contact.key !== this.key, 'forwarding through self');
      //this.xlog('forwarding through', contact.sname);
      const response = await contact.sendRPC('signals', key, signals, forwardingExclusions, targetNameForDebugging);
      if (response) {
	const {forwardingExclusions: extendedExclusions, result} = response;
	//this.xlog('got response from', contact.sname, result, 'through', forwardingExclusions.join(', '));	
	if (result) return response; // Success!
	// We don't know whether the target or an intermediary is dead to the one before. Keep going.
	forwardingExclusions = extendedExclusions; // TODO: don't directly trust extendedExclusions. add/union.
      } else { // No response at all: continue with further calls that exclude contact.
	//this.xlog('No forwarding response from', contact.sname, );
	forwardingExclusions.push(contact.name);
      }
    }
    return null;
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
