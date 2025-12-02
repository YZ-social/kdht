# KDHT

A Kademlia Distributed Hash Table
See [paper](https://www.scs.stanford.edu/~dm/home/papers/kpos.pdf) and [wikipedia](https://en.wikipedia.org/wiki/Kademlia)

This repo allows us to experiment with a pure kdht, to see the effects of changes and and optimizations.
For example, there is a class that implements connections to nodes running on the same computer, so that tests can be run without any networking at all (as long as the CPU isn't overwhelmed from running too many nodes).
There is a repeatable test suite that can be used to confirm behavior as changes are made.

### Classes

A [Node](./dht/node.js) is an actor in the DHT, and it has a key - a [BigInt](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt) of Node.keySize bits:
- A typical client will have one Node instance through which it interacts with one DHT.
- A server or simulation might have many Node instances to each interact with the same DHT.
A Node has a Contact object to represent itself to another Node.
A Node maintains [KBuckets](./dht/kbucket.js), which each have a list of Contacts to other Nodes.

A [Contact](./transports/contact.js) is the means through which a Node interacts with another Node instance:
- When sending an RPC request, the Contact will "serialize" the sender Nodes's contact.
- When receiving an RPC response, the sender "deserializes" a string (maybe using a cache) to produce the Contact instance to be noted in the receiver's KBuckets.
- In classic UDP Kademlia, a Contact would serialize as {key, ip, port}.
- In a simulation, a Contact could "serialize" as just itself.
- In our system, I imagine that it will serialize as signature so that keys cannot be forged.

While a Node maintains several Contacts in its KBuckets, these are organized based on the distance from the Contact's key to the Node's key. However, each network-probing operation requires the ephermal creation of Contact information that is based on the distance to the target key being probed for. For this purpose, we wrap the Contacts in a [Helper](./dht/helper.js) object that caches the distance to the target.
