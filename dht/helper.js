import { Node } from './node.js';

// A Contact that is some distance from an assumed targetKey.
export class Helper { 
  constructor(contact, distance) {
    this.contact = contact;
    this.distance = distance;
  }
  get key() { return this.contact.key; }
  get name() { return this.contact.name; }
  get node() { return this.contact.node; }
  get report() { return this.contact.report; }
  static compare = (a, b) => { // For sort, where a,b have a distance property returning a BigInt.
    // Sort expects a number, so bigIntA - bigIntB won't do.
    // This works for elements of a list that have a distance property -- they do not strictly have to be Helper instances.
    if (a.distance < b.distance) return -1;
    if (a.distance > b.distance) return 1;
    return 0;
  }
  static findClosest(targetKey, contacts, count = this.constructor.k) { // Utility, useful for computing and debugging.
    const helpers = contacts.map(contact => new Helper(contact, Node.distance(targetKey, contact.key)));
    helpers.sort(this.compare);
    return helpers.slice(0, count);
  }
}
