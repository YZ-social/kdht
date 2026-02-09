const { BigInt } = globalThis; // For linters.
import { v4 as uuidv4 } from 'uuid';
import { Node } from '../nodes/node.js';
import { Helper } from '../nodes/helper.js';
import { Contact } from './contact.js';
import { WebRTC } from '@yz-social/webrtc';

// Connection state classification for safe cleanup
// Transitional states are unsafe to close - cleanup should wait for stable state
// Stable states are safe to close - cleanup can proceed immediately
export const ConnectionStates = {
  // Transitional states - unsafe to close
  TRANSITIONAL: ['new', 'connecting', 'disconnected'],
  
  // Stable states - safe to close
  STABLE: ['connected', 'failed', 'closed'],
  
  isTransitional(state) {
    return this.TRANSITIONAL.includes(state);
  },
  
  isStable(state) {
    return this.STABLE.includes(state);
  }
};

// Connection event tracking for stability diagnostics
export class ConnectionTracker {
  static events = [];
  static maxEvents = 1000;
  static enabled = false;
  
  // Resource monitoring properties
  static activeConnections = 0;
  static cleanupSuccesses = 0;
  static cleanupFailures = 0;
  
  static enable() { this.enabled = true; }
  static disable() { this.enabled = false; }
  static clear() { 
    this.events = []; 
    this.activeConnections = 0;
    this.cleanupSuccesses = 0;
    this.cleanupFailures = 0;
  }
  
  // Track when a new WebRTC connection is created
  static trackConnectionCreated() {
    this.activeConnections++;
  }
  
  // Track when a connection is closed/cleaned up
  static trackConnectionClosed(success, reason) {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
    if (success) {
      this.cleanupSuccesses++;
    } else {
      this.cleanupFailures++;
    }
    this.log('cleanup_completed', { success, reason });
  }
  
  // Get current resource statistics
  static getResourceStats() {
    return {
      activeConnections: this.activeConnections,
      cleanupSuccesses: this.cleanupSuccesses,
      cleanupFailures: this.cleanupFailures,
      totalCleanups: this.cleanupSuccesses + this.cleanupFailures
    };
  }
  
  static log(type, details) {
    if (!this.enabled) return;
    const event = {
      timestamp: Date.now(),
      type,
      ...details
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
    // Also log to console for real-time debugging
    if (typeof console !== 'undefined') {
      console.log(`[ConnectionTracker] ${type}:`, details);
    }
  }
  
  static getStats() {
    const stats = {
      totalEvents: this.events.length,
      byType: {},
      connectionAttempts: 0,
      connectionSuccesses: 0,
      connectionFailures: 0,
      disconnects: 0,
      timeouts: 0,
      errors: []
    };
    
    for (const event of this.events) {
      stats.byType[event.type] = (stats.byType[event.type] || 0) + 1;
      
      switch (event.type) {
        case 'connection_attempt': stats.connectionAttempts++; break;
        case 'connection_success': stats.connectionSuccesses++; break;
        case 'connection_failure': stats.connectionFailures++; break;
        case 'connection_timeout': stats.timeouts++; break;
        case 'disconnect': stats.disconnects++; break;
        case 'error': stats.errors.push(event); break;
      }
    }
    
    stats.successRate = stats.connectionAttempts > 0 
      ? (stats.connectionSuccesses / stats.connectionAttempts * 100).toFixed(1) + '%'
      : 'N/A';
    
    return stats;
  }
  
  static getRecentEvents(count = 50) {
    return this.events.slice(-count);
  }
}

export class WebContact extends Contact { // Our wrapper for the means of contacting a remote node.
  // Can this set all be done more simply?
  get name() { return this.node.name; } // Key of remote node as a string (e.g., as a guid).
  get key() { return this.node.key; }   // Key of remote node as a BigInt.
  get isServerNode() { return this.node.isServerNode; } // It it reachable through a server.

  // Listener tracking for proper cleanup (Requirements 2.2, 2.3)
  _eventListeners = new Map();  // Map<target, Map<event, handler[]>>
  _cleanupInProgress = false;   // Prevent concurrent cleanup

  // Register a listener and track it for later removal
  registerListener(target, event, handler) {
    if (!target) return;
    
    // Get or create the event map for this target
    if (!this._eventListeners.has(target)) {
      this._eventListeners.set(target, new Map());
    }
    const eventMap = this._eventListeners.get(target);
    
    // Get or create the handler array for this event
    if (!eventMap.has(event)) {
      eventMap.set(event, []);
    }
    eventMap.get(event).push(handler);
    
    // Actually add the listener
    target.addEventListener(event, handler);
  }

  // Remove all tracked listeners
  removeAllListeners() {
    for (const [target, eventMap] of this._eventListeners) {
      for (const [event, handlers] of eventMap) {
        for (const handler of handlers) {
          try {
            target.removeEventListener(event, handler);
          } catch (e) {
            // Target may already be destroyed, ignore
          }
        }
      }
    }
    this._eventListeners.clear();
  }

  // Wait for connection to reach a stable state before cleanup (Requirements 1.1, 1.3)
  async waitForStableState(maxWaitMs = 5000) {
    const start = Date.now();
    const state = this.webrtc?.pc?.connectionState;
    
    // If no webrtc or already stable, return immediately
    if (!state || ConnectionStates.isStable(state)) {
      return { waited: false, forced: false };
    }
    
    // Poll until stable or timeout
    while (Date.now() - start < maxWaitMs) {
      const currentState = this.webrtc?.pc?.connectionState;
      if (!currentState || ConnectionStates.isStable(currentState)) {
        return { waited: true, forced: false };
      }
      await Node.delay(100);
    }
    
    // Timeout exceeded - log warning and force cleanup
    ConnectionTracker.log('cleanup_forced', {
      from: this.host?.contact?.sname,
      to: this.sname,
      state: this.webrtc?.pc?.connectionState,
      waitedMs: maxWaitMs
    });
    return { waited: true, forced: true };
  }

  // Execute cleanup in correct order (Requirements 2.1, 2.4, 2.5, 3.1, 3.4)
  performCleanup(reason) {
    let success = true;
    const connectionState = this.webrtc?.pc?.connectionState;
    
    // Step 1: Stop all media tracks
    try {
      this.webrtc?.pc?.getSenders?.()?.forEach(sender => {
        try { sender.track?.stop(); } catch (e) { /* ignore */ }
      });
    } catch (e) {
      success = false;
      ConnectionTracker.log('cleanup_error', { 
        step: 'stop_tracks', 
        error: e.message,
        from: this.host?.contact?.sname,
        to: this.sname
      });
    }
    
    // Step 2: Remove all event listeners
    try {
      this.removeAllListeners();
    } catch (e) {
      success = false;
      ConnectionTracker.log('cleanup_error', { 
        step: 'remove_listeners', 
        error: e.message,
        from: this.host?.contact?.sname,
        to: this.sname
      });
    }
    
    // Step 3: Close data channel
    try {
      if (this.unsafeData) {
        this.unsafeData.close?.();
      }
    } catch (e) {
      success = false;
      ConnectionTracker.log('cleanup_error', { 
        step: 'close_channel', 
        error: e.message,
        from: this.host?.contact?.sname,
        to: this.sname
      });
    }
    
    // Step 4: Close peer connection
    try {
      this.webrtc?.close?.();
    } catch (e) {
      success = false;
      ConnectionTracker.log('cleanup_error', { 
        step: 'close_connection', 
        error: e.message,
        from: this.host?.contact?.sname,
        to: this.sname
      });
    }
    
    // Step 5: Nullify references (always do this regardless of errors)
    this.webrtc = null;
    this.connection = null;
    this.unsafeData = null;
    
    // Log cleanup result to ConnectionTracker
    ConnectionTracker.trackConnectionClosed(success, reason);
    
    return success;
  }

  // State-aware cleanup entry point (Requirements 1.1, 1.2)
  async safeCleanup(reason) {
    // Prevent concurrent cleanup
    if (this._cleanupInProgress) return;
    this._cleanupInProgress = true;
    
    try {
      // Wait for stable state if needed
      await this.waitForStableState();
      
      // Perform cleanup in correct order
      this.performCleanup(reason);
    } finally {
      this._cleanupInProgress = false;
    }
  }

  checkResponse(response) { // Return a fetch response, or throw error if response is not a 200 series.
    if (response?.ok) return true;
    this.host.flog(`*** Unable to reach portal ${response?.url || this.sname}, ${response?.status || 'failed fetch'}: ${response?.statusText || 'Unknown reason'}. ***`);
    return false;
  }
  // connection:close is far more robust against pooling issues common to some implementations (e.g., NodeJS).
  // https://github.com/nodejs/undici/issues/3492
  async fetchBootstrap(baseURL, label = 'random') { // Promise to ask portal (over http(s)) to convert a portal
    // worker index or the string 'random' to an available sname to which we can connect().
    const url = `${baseURL}/name/${label}`;
    const response = await fetch(url, {headers: { 'Connection': 'close' } }).catch(e => this.host.flog(url, e));
    if (!this.checkResponse(response)) { // The portal webserver is not available. Stop trying to reach this node.
      // TODO: maintain a well-known list of portal servers to try, but even then, do not try to reach nodes that are on an unreachable server.
      this.host.removeContact(this);
      return '';
    }
    try {
      const result = await response.json();
      if (!result) {
        this.host.flog(`*** Empty response from ${url} - server may not be ready. ***`);
        return '';
      }
      return result;
    } catch (e) {
      this.host.flog(`*** Failed to parse response from ${url}: ${e.message} ***`);
      return '';
    }
  }
  async fetchSignals(url, signalsToSend, retryCount = 0) { 
    const maxRetries = 3;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body: JSON.stringify(signalsToSend)
    }).catch(e => this.host.flog(e));
    
    if (!this.checkResponse(response)) {
      // Don't retry on client errors (4xx) - the request is malformed
      if (response?.status >= 400 && response?.status < 500) {
        this.host.flog(`*** Client error ${response.status} for ${url} - not retrying ***`);
        return [];
      }
      // Retry on server errors with limit
      if (retryCount < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * (retryCount + 1))); // Exponential backoff
        return this.fetchSignals(url, signalsToSend, retryCount + 1);
      }
      this.host.flog(`*** Max retries (${maxRetries}) exceeded for ${url} ***`);
      return [];
    }
    return this.checkSignals(await response?.json());
  }
  async signals(senderSname, ...signals) { // Accept directed WebRTC signals from a sender sname, creating if necessary the
    // new contact on host to receive them, and promising a response.
    //this.host.flog('contact signals', senderSname, signals);
    let contact = await this.ensureRemoteContact(senderSname);

    if (contact.webrtc?.pc) return await contact.webrtc.respond(signals);

    this.host.noteContactForTransport(contact);
    contact.createWebRTC(false);
    
    // Check that webrtc was created successfully before responding
    if (!contact.webrtc) {
      this.host.flog('Failed to create WebRTC for signals from', senderSname);
      return [];
    }
    
    return await contact.webrtc.respond(signals);
  }
  get webrtcLabel() {
    return `@${this.host.contact.sname} ==> ${this.sname}`;
  }

  createWebRTC(initiate = false, timeoutMS = this.host.timeoutMS || 30e3) { // Ensure we are connected, if possible.
    // Sets up contact to have properties:
    // - connection - a promise for an open webrtc data channel:
    //   this.send(string) puts data on the channel
    //   incomming messages are dispatched to receiveWebRTC(string)
    // - closed - resolves when webrtc closes.
    // - webrtc - an instance of WebRTC (which may be used for webrtc.respond()
    //
    // If timeoutMS is non-zero and a connection is not established within that time, connection and closed resolve to null.
    //
    // This is synchronous: all side-effects (assignments to this) happen immediately.
    const start = Date.now();
    const { host, node, isServerNode, bootstrapHost } = this;
    this.host.log('starting connection', this.sname, this.connection ? 'exists!!!' : 'fresh', this.counter);
    
    // Track connection attempt
    ConnectionTracker.log('connection_attempt', {
      from: host.contact?.sname,
      to: this.sname,
      initiate,
      counter: this.counter,
      existingConnection: !!this.connection
    });
    
    let {promise, resolve} = Promise.withResolvers();
    this.closed = promise;
    
    // Track connection creation (Requirement 5.1)
    ConnectionTracker.trackConnectionCreated();
    
    const webrtc = this.webrtc = new WebRTC({name: this.webrtcLabel,
					     debug: host.debug,
					     configuration: {iceServers: [
					       {urls: [
						 'stun:stun1.l.google.com:19302',
						 'stun:stun2.l.google.com:19302',
						 'stun:stun3.l.google.com:19302',
						 'stun:stun4.l.google.com:19302'
					       ]},
					     ]},
					     polite: this.host.key < this.node.key});
    const onclose = () => { // Does NOT mean that the far side has gone away. It could just be over maxTransports.
      this.host.log('connection closed');
      
      // Track disconnect with reason
      ConnectionTracker.log('disconnect', {
        from: host.contact?.sname,
        to: this.sname,
        counter: this.counter,
        elapsed: Date.now() - start,
        hadWebrtc: !!this.webrtc,
        hostStopped: this.host.isStopped()
      });
      
      if (this.webrtc && !this.host.isStopped()) {
	this.host.ilog('connection to', this.sname, 'was not politely closed. Dropping contact.');
	ConnectionTracker.log('unexpected_close', {
	  from: host.contact?.sname,
	  to: this.sname,
	  counter: this.counter
	});
	this.host.removeContact(this, false);
      }
      this.webrtc = this.connection = this.unsafeData = null;
      resolve(null); // closed promise
    };
    if (initiate) {
      if (bootstrapHost && !host.connections.length) {
	const url = `${bootstrapHost || 'http://localhost:3000/kdht'}/join/${host.contact.sname}/${this.sname}`;
	this.webrtc.transferSignals = signals => this.fetchSignals(url, signals);
      } else {
	this.webrtc.transferSignals = signals => this.messageSignals(signals);
      }
    } // Otherwise, we just hang on to signals until we're asked to respond().

    let timeout;
    const kdhtChannelName = 'kdht';
    const channelPromise = webrtc.getDataChannelPromise(kdhtChannelName);
    webrtc.createChannel(kdhtChannelName, {negotiated: true});
    channelPromise.then(async dataChannel => {
      this.host.log('data channel open', this.sname, Date.now() - start, this.counter);
      clearTimeout(timeout);
      
      // Track successful connection
      ConnectionTracker.log('connection_success', {
        from: host.contact?.sname,
        to: this.sname,
        counter: this.counter,
        elapsed: Date.now() - start,
        initiate
      });
      
      // Use registerListener for proper cleanup tracking (Requirements 2.2, 2.3)
      this.registerListener(dataChannel, 'close', onclose);
      this.registerListener(dataChannel, 'message', event => this.receiveWebRTC(event.data));
      if (this.info || this.debug) await webrtc.reportConnection(true);
      if (webrtc.statsElapsed > 500) {
        this.host.flog(`** slow connection to ${this.sname} took ${webrtc.statsElapsed.toLocaleString()} ms. **`);
        ConnectionTracker.log('slow_connection', {
          from: host.contact?.sname,
          to: this.sname,
          elapsed: webrtc.statsElapsed
        });
      }
      this.unsafeData = dataChannel;
      return dataChannel;
    });
    if (!timeoutMS) {
      this.connection = channelPromise;
      return;
    }
    const timerPromise = new Promise(expired => {
      timeout = setTimeout(async () => {
	if (this.host.isStopped()) return;
	const now = Date.now();
	this.host.ilog('Unable to connect to', this.sname);
	
	// Track timeout
	ConnectionTracker.log('connection_timeout', {
	  from: host.contact?.sname,
	  to: this.sname,
	  counter: this.counter,
	  timeoutMS,
	  elapsed: now - start
	});
	
	// Clear webrtc BEFORE calling onclose so it knows this is a timeout,
	// not an unexpected close. This prevents the "was not politely closed"
	// message and double-remove of the contact.
	const webrtcToClose = this.webrtc;
	this.webrtc = null;
	webrtcToClose?.close();
	onclose();
	// Don't remove contact on timeout - the node may still be reachable
	// through other paths. Let the routing table manage stale contacts.
	expired(null);
      }, timeoutMS);
    });
    this.connection = Promise.race([channelPromise, timerPromise]);
  }
  async connect() { // Connect from host to node, promising a possibly cloned contact that has been noted.
    // Creates a connected WebRTC instance.
    const contact = this.host.noteContactForTransport(this);
    ///if (contact.connection) contact.host.flog('connect existing', contact.sname, contact.counter);

    const { host, node, isServerNode, bootstrapHost } = contact;
    // Anyone can connect to a server node using the server's connect endpoint.
    // Anyone in the DHT can connect to another DHT node through a sponsor.
    if (contact.connection) {
      ConnectionTracker.log('connection_reused', {
        from: host.contact?.sname,
        to: this.sname,
        counter: contact.counter
      });
      return contact.connection;
    }
    contact.createWebRTC(true);
    return await this.connection;
  }

  async send(message) { // Promise to send through previously opened connection promise.
    let channel = await this.connection;
    if (!channel) return;
    if (channel.readyState === 'open') channel.send(JSON.stringify(message));
    else this.host.ilog('Tried to send on unopen channel on', this.sname, message);
  }
  synchronousSend(message) { // this.send awaits channel open promise. This is if we know it has been opened.
    if (this.unsafeData?.readyState !== 'open') return; // But it may have since been closed.
    this.host.log('sending', message, 'to', this.sname);
    try {
      this.unsafeData.send(JSON.stringify(message));
    } catch (e) { // Some webrtc can change readyState in background.
      this.host.log(e); 
    }
  }
  serializeRequest(messageTag, method, sender, targetKey, ...rest) { // Stringify sender and targetKey.
    Node.assert(sender instanceof Contact, 'no sender', sender);
    // Recursive methods pass a context object instead of a key - don't stringify it
    const recursiveMethods = ['recursiveFindNodes', 'recursiveFindValue', 'recursiveSignals'];
    if (recursiveMethods.includes(method)) {
      return [messageTag, method, sender.sname, targetKey, ...rest];
    }
    return [messageTag, method, sender.sname, targetKey.toString(), ...rest];
  }
  async deserializeRequest(method, sender, targetKey, ...rest) { // Inverse of serializeRequest. Response object will be spread for Node receiveRPC.
    // TODO: Currently, parameters do NOT include messageTag! (Because of how receiveRPC is called without it.)
    // Recursive methods pass a context object instead of a key
    const recursiveMethods = ['recursiveFindNodes', 'recursiveFindValue', 'recursiveSignals'];
    if (recursiveMethods.includes(method)) {
      // For recursive methods, targetKey is actually the context data object
      return [method, await this.ensureRemoteContact(sender), targetKey, ...rest];
    }
    try {
      return [method, await this.ensureRemoteContact(sender), BigInt(targetKey), ...rest];
    } catch (e) {
      this.host.flog('Error deserializing request:', method, 'targetKey:', targetKey, 'error:', e.message);
      throw e;
    }
  }
  isSignalResponse(response) {
    const first = response[0];
    if (!first) return false;
    if (('description' in first) || ('candidate' in first)) return true;
    return false;
  }
  serializeResponse(response) {
    if (!this.host.constructor.isContactsResult(response)) return response;
    if (this.isSignalResponse(response)) return response;
    return response.map(helper => [helper.contact.sname, helper.distance.toString()]);
  }
  async deserializeResponse(result) {
    let response;
    if (!Node.isContactsResult(result)) return result;
    if (!result.length) return result;
    if (this.isSignalResponse(result)) return result;
    return await Promise.all(result.map(async ([sname, distance]) =>
      new Helper(await this.ensureRemoteContact(sname, this), BigInt(distance))));
  }
  async transmitRPC(messageTag, method, sender, ...rest) { // Must return a promise.
    // this.host.log('transmit to', this.sname, this.connection ? 'with connection' : 'WITHOUT connection');
    const responsePromise = this.getResponsePromise(messageTag);
    await this.send([messageTag, method, sender, ...rest]);
    return await Promise.race([responsePromise, this.rpcTimeout(method, ...rest), this.closed]);
  }

  async receiveWebRTC(dataString) { // Handle receipt of a WebRTC data channel message that was sent to this contact.
    // The message could the start of an RPC sent from the peer, or it could be a response to an RPC that we made.
    // As we do the latter, we generate and note (in transmitRPC) a message tag included in the message.
    // If we find that in our messageResolvers tags, then the message is a response.
    const [messageTag, ...data] = JSON.parse(dataString);
    await this.receiveRPC(messageTag, ...data);
  }
  async disconnectTransport(andNotify = true) {
    if (!this.connection) return;
    super.disconnectTransport(andNotify);
    const webrtc = this.webrtc;
    this.connection = this.webrtc = null;
    webrtc?.close();
  }
}
