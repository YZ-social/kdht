# Project Structure

```
├── index.js              # Main exports
├── nodes/                # Core DHT implementation
│   ├── node.js           # Node class (top of inheritance chain)
│   ├── nodeProbe.js      # Network iteration/probing logic
│   ├── nodeMessages.js   # RPC message handlers (ping, store, findNodes, findValue)
│   ├── nodeContacts.js   # Contact/bucket management
│   ├── nodeConnections.js # Connection limit management
│   ├── nodeStorage.js    # Local key-value storage
│   ├── nodeRefresh.js    # Periodic refresh scheduling
│   ├── nodeKeys.js       # Key hashing and distance calculations
│   ├── nodeUtilities.js  # Base class with logging/debugging
│   ├── kbucket.js        # KBucket routing table bucket
│   └── helper.js         # Helper wrapper for distance caching
├── contacts/             # Transport implementations
│   ├── contact.js        # Base Contact class
│   ├── simulations.js    # In-process simulation contacts
│   └── webrtc.js         # WebRTC data channel transport
├── scripts/              # Server components and utilities
│   ├── node.js           # Portal node for bootstrapping
│   ├── router.js         # Express router for signaling
│   ├── portal.js         # Portal server script
│   └── bots.js           # Bot simulation script
└── spec/                 # Tests
    ├── dhtSimulationsSpec.js # End-to-end DHT simulation tests
    ├── dhtInternalsSpec.js   # Unit tests for internals
    ├── dhtImplementation.js  # Test helpers/setup
    └── support/jasmine.mjs   # Jasmine config
```

## Architecture Pattern
Node uses a mixin-style inheritance chain:
```
NodeUtilities → NodeKeys → NodeRefresh → NodeStorage 
  → NodeConnections → NodeContacts → NodeMessages → NodeProbe → Node
```

Each class in the chain adds specific functionality. The chain is split for code organization, not for independent use.

## Transport Abstraction
- `Contact` base class defines the interface
- `SimulatedContact` - Direct method calls (no network)
- `SimulatedConnectionContact` - Simulates connection state
- `WebContact` - Real WebRTC data channels
