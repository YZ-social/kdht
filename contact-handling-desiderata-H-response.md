- A: A node has a unique key each session, and retains that key throught the session.
For this purpose, a session runs from just before bootstrapping the first connection, through (deliberately or observing) disconnection of the last remote contact to which it is connected. (Note: node.html behaves this way on reconnect, but not yet on reconnect from tab visibility changes. Oops! I'm certain that has caused us problems in group testing!) This effects discussion of E6.

- B3 Current mechanism and Q: I think you're looking at old code? The main that includes serial-connections (as of evenening 2/18) does use isOpen.
(Question for you: the "current mechanism and question" is a very astute observation, but of the wrong code. As we noted yesterday, it had been getting very hard to track the code. But now that main has been updated, how did Claude miss this?)

- B4 In addition to the scheduled bucket referesh, the act of storing data (including pubsub data) also schedules a refresh of that data, which invokes the same probe mechanism as a bucket refresh. (Hmmm, it occurs to me that maybe we do not need the bucket refresh of an occupied bucket that also has data stored in that range. I wonder if we should optimize that, as stored data will dominate in a live/used system. However, this must be done carefully because currently the storage refresh timer is reset when someone else beats us to it and stores in us, and yet we would still want to do the probe (without the re-store).)

- D1: This is indeed confusing and the crux of the thing to be untangled. I don't have the answers.
My thinking on dead-exclusion interval -- perhaps incorrect -- is that the refresh interval is supposed to be the time at which we observe a change in the network, so mischaracterizations should be re-assessed at that time. For example, by the time a refresh interval has passed, we and the other nodes in the system will have learned of changes. Thus the dead-exclusion timeout should not be longer than a refresh. Meanwhile, I assumed -- also perhaps incorrectly -- that the main source of bad information was failed recursive signaling, and that the dead-exclusion period should thus be longer than a recursive signaling timeout. (Alas, I'm not sure that it currently is!)

There may be other reasons for going dead, and I don't think I've reasoned through them. For example, my intention is that if someone drops a connection to us for being at the maxTransports limit, they should politely send 'close' and we should remove it without marking it dead. But did I implement that correctly?

- D2:
- My intent was that there is a current mechanism: that the failed probe marks it is not running; the contactDictionary keeps it around for a while; and that sendRPC won't try to send to a non-running node, so there won't be any reason to try connecting again while excluded. Maybe I didn't actually do that?
- I'm weirded out in passing that the forwarding is labeled O(n). Maybe it's because I've always been terrible at order-of-complexity and sensitive about it. (Engineering B.S. degrees, none in Comp. Sci.) But it seems to me to be O(n) only for a tautological definition of n == order-of-complexity, and not for, e.g., n == number-of-nodes-in-the-network (or even n === k, or anything else that I can think of). Indeed, I think I explicitly limit the total hops to maxTries == alpha^3 (so constant O(9) => O(1) hops max?). (See also H3.)

- E3: Random other info:
- I don't think I've been consistent about when to use removeContact(contact, false). As we discussed previously (and you/Claude note in E4), I imagine that !results case at the top of node.step() should use a false second argument. And your E5. **It may be that this (or some others like it) are all that is needed! (In conjunction with the other changes in main, such as serialized connections and the use of isOpen.)**
- I don't remove from everyone's sponsors, as I don't have an efficient mechanism for doing so. Instead, I (think that I) check sponsors for liveness before making use of them. Maybe I got something wrong there? (E.g., maybe I'm not being consistent someplace else, such as when removing over-limit maxTransports?) See also F3

- E4: For timing, see comments re D1 and E3.

- E5: Ohh, good point! I think you're right. (Hell, maybe no removeContact should be immediate! See next.)

- E6: I think it is not possible to balance the tensions you describe, and hence the semantics of A: a rejoining node always has a new key. Hence there is no "reconnect" case. (Other than network glitch or re-establishing communication after a connection was deliberately dropped for maxTransports.)
I'd love for keys to be persisted and stable, along with their data, but I think it's just too hard to achieve that right now. It's more important for everything to work reliably, even if that means copying data around more often.

This may cause problems down the line, but for NOW, the only data is pubsub, which have limited and relatively short life spans, so persisting data between sessions isn't needed. I think (hope?) that long lived data (such as encrypted personal data) can be handled by republishing from a local-first data store, but we shall see.

- E7: I don't know is meant by "don't bother with removal bookkeeping."

- F3: I think that contactA is removed, it isn't so much that we want to do contactA._sponsors.clear(), but that we would need to remove contactA from everyone else's ._sponsors. That could be done with back-pointers, but... yuck. That's why I (think that I) am not trusting the liveness of nodes in _sponsors, but instead asking them if they are isOpen. See E3, and oh, next.

- F4: See above. But we do need to make sure we're actually checking isOpen. E.g., contact.messageSignals' trySponsors.

- G1: "The need is real for contacts that are persistently mentioned by peers". Is that true? If we did non-immediate removal in all the necessary places (E3, E5, ...), would we still have this problem? If we do, we should understand WHY, i.e., under what circumstances, exactly.

- G2: I can easily imagine that there is an existing bug here. There are several ways a connection can fail and several different timeouts. Do they all clean up properly?

- G3: The development of the host.connections.find(c => c.isOpen) check was pretty "organic", and I'll bet I've got similar stuff (nConnections?) that needs to be cleaned up. In my current work to rationalize the application-level API between civildefense's WebSocket pubsub and the dht, I've started using yet another mechanism becasue the app needs to know when we are "connected at all" vs not (e.g., to reconnect if necessary when the user clicks on the map). Once I'm happy with that application-level API, I should go through and rationalize the various internal stuff to match. Sorry about that!

- G4:
- "it does not limit how many incoming connection requests a node handles simultaneously": Ooh, good catch! I had originally intended for the connectionQueue to be part of the createConnection IMPLEMENTATION so that it would handle both, but switched it to the caller so that the simulator would exercise the same code, and forgot to go back and add it to the caller in webcontact.signals. I'll look into doing so. Hope it doesn't break things!
- "nor does it limit concurrent signal forwarding through a node": Does it need to? Why?

- H1: I do not know why it sometimes works when tried the second time after a delay. Surely that's a clue about something.

- H2: Oof. Good catch.

- H3: I don't understand. node.recursiveSignals abandons the search if forwardingExclusions.length > this.constructor.maxTries. Isn't that working? (See also, D2.)

- H4: See D1. Do we need two mechanisms?

- I4: Good question. I think it may be even a bit more complicated. If the resolver is removed by the timeout winning the race, then it isn't available at contact.receiveRPC, and so the incoming message will be treated as a new RPC request to be handled, rather than a response. I think at minimum it would need a guard to see if the requested method name exists in the host.

- J1: I think(?) that there are two questions here:
1) Is it right to add an isRunning guard here? I *think* so? Sounds reasonable.
2) If so, is the timing provided by the recently dead and/or non-immediate removal correct. I think the answer is "whatever the answer is to D1".


Idea 1: check (or have Claude check) this document against https://www.scs.stanford.edu/~dm/home/papers/kpos.pdf, particularly the "Sketch of Proof" section.

Idea 2: Have Claude examine the recursive signaling path and identify problems. For example, one obvious problem is the that there can be a dropout in the path by which data is returned through the same connection it arrived. I wonder if Claude can notice that without being told. Another is that each node can pass back better info about the network (in the style of R/Kademlia), which can be used for faster and more reliable recursion. If it does a good job in identifying the problems, we might consider having it suggest an update that addresses that.
