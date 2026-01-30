# KDHT

A Kademlia Distributed Hash Table
See [paper](https://www.scs.stanford.edu/~dm/home/papers/kpos.pdf) and [wikipedia](https://en.wikipedia.org/wiki/Kademlia)

Our system works in browsers (and in NodeJS), using WebRTC data channels to pass information from one node to another. (WebRTC is the only peer-to-peer messaging mechanism built into every browser.) This is different from the original Kademlia, in which information was passed over connectionless UDP. A node kept a small set of data about the other nodes that it knew of, such as IP address and port number, and no long-lived limited resources such as sockets. 

For testing and development, our system also allows the data channel connection to be simulated, so that large number of nodes can run directly in the same Javascript process, invoking RPC on each other directly rather than over the wire.

### Classes

A [`Node`](./nodes/node.js) is an actor in the DHT, and it has a `key` - a [BigInt](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt) of `Node.keySize` bits. The `key` is computed as a hash of a `name` string, which is typically a GUID, but in any case unique among the nodes of the network to which the node is connected.
- A typical client will have one `Node` instance through which it interacts with one DHT.
- A server or simulation might have many Node instances to each interact with the same DHT.
- In any case, there is one `Node` class for all uses. For ease of development, it is broken into linear chain of small classes that live in the nodes directory of the repo.

A `Node` has a `Contact` object to represent itself to another `Node`. A `Node` maintains [`KBuckets`](./nodes/kbucket.js), which each have a list of `Contacts` to other `Node`s.

A [`Contact`](./contacts/contact.js) is the means through which a `Node` interacts with another `Node` instance:
- When sending an RPC request, the `Contact` will "serialize" the sender `Nodes`'s contact.
- When receiving an RPC response, the sender "deserializes" a string (maybe using a cache) to produce the `Contact` instance to be noted in the receiver's `KBucket`s.
- In classic UDP Kademlia, a `Contact` would serialize as {key, ip, port}.
- Our `WebContact` subclass wraps around a WebRTC connection.
- Our `SimulatedConnectionContact` subclass directly contains the "far" `Node` object itself.
- In both cases, a `Contact` has two `Node` objects, the "host" that owns this `Contact` (in the node's `KBucket`s), and a (possibly empty) representation of the far `Node` (to maintain, e.g., it's `key` and `name`). A `Contact` also has customizable methods to `connect` and to `sendRPC`.

While a `Node` maintains several `Contacts` in its `KBucket`s, these are organized based on the distance from the `Contact`'s key to the `Node`'s key. However, each network-probing operation requires the ephermal creation of `Contact` information that is based on the distance to the target key being probed for. For this purpose, we wrap the `Contacts` in a [`Helper`](./nodes/helper.js) object that caches the distance to the target.

### Connecting

Nodes learn about other node `name`s through those that with which they are already connected. In Kademlia, the node will, from time to time, directly connect to these newly discovered nodes.

Browsers do not allow pages to listen for incoming connections. Instead, two WebRTC peers must exchange "signal" information that allows them to simultaneously find each other on the Internet. 
When a node A needs to directly connect to another node B, A sends signals to B, which responds with its own signals back to A. This happens a couple of times until agreement is reached on how to directly connect. Obviously, these signals messages cannot go directly between two unconnected peers, but must be carried through some intermediary. Once connected to any node in the network, the signals can pass as network messages through the already connected node.

To form that initial connection to another node, a new unconnected node must go through a "portal" server. This consists of an ordinary Web server that handles a GET request that answers the `name` of one of the nodes that are run by that server and with which the server can directly communicate. The joining node then makes a POST to that same server, specifying its own name and that of the portal's node, as well as the signals. The server passes those signals to the specified portal node, and responds with that portal node's answering signals.  As long as the joined node remains connected to any other node in the network, it will connect to other nodes by passing the signals through the network itsef, rather than the portal web server, even if connecting to a node that happens to be on the portal server.


### Scripts

The [NodeJS](https://nodejs.org/) script [`portals.js`](./scripts/portals.js) runs a little [ExpressJS](https://expressjs.com/) Web server and associated portal nodes. (See [Connecting](#connecting), above.). Each portal node is run its own NodeJS sub-process (using NodeJS's [`cluster`](https://nodejs.org/api/cluster.html) mechanism). By default, it runs one portal node for each CPU core but one, allowing one core for the Web server process. The portal nodes are started one at a time, with each after the first connecting to one of the previous portal nodes through the script's own Web server at `http://localhost:3000/kdht`. 
- If an `externalBaseURL` is specified, the first portal node will connect to the compatible portal server running at the specified URL, forming one big network. Otherwise, the portal nodes and any other nodes that connect to it will be distinct. 
- `npm start` runs the script to connect with ki1r0y.com/kdht, while `npm run withoutExternal` runs separately. 
- The ExpressJS routing parts of `portals.js` is also available separately as `router.js`, so that it can be used as middleware within existing ExpressJS applications.
- A very basic Web page is also servered at `http://localhost:3000/portal/node.html` that joins the same network.

Once one instance of `portals.js` is running, the script [`bots.js`](./scripts/bots.js) can be run any number of times, depending on what the computer can handle.



### Testing

We use the [https://jasmine.github.io/](Jasmine) test framework.

- `npx jasmine` runs all the test that use only simulated network connections. In particular, `npx jasmine spec/dhtSimulationsSpec.js` runs several customizable variations of network behavior.
- `npx jasmine spec/testWebrtc.js` runs the portals and bots scripts, and creates a node that interacts with them.
- `npm test` runs all of these.


