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
}
