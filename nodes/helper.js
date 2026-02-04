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
    const helpers = contacts.map(contact => new Helper(contact, contact.distance(targetKey)));
    helpers.sort(this.compare);
    return helpers.slice(0, count);
  }

  /**
   * Calculate a proximity score combining XOR distance with RTT.
   * Lower score is better.
   * 
   * The score formula: distance * (1 + weight * rtt / 1000)
   * - XOR distance is the primary factor
   * - RTT adds a penalty proportional to the weight
   * - Unknown RTT defaults to 1000ms (encourages learning)
   * 
   * @param {number} proximityWeight - Weight factor for RTT influence (default: 0.1)
   * @returns {number} Combined proximity score (lower is better)
   * 
   * Requirements: 5.2, 5.4
   */
  proximityScore(proximityWeight = 0.1) {
    const rtt = this.contact.rtt ?? 1000; // Default high RTT if unknown
    return Number(this.distance) * (1 + proximityWeight * rtt / 1000);
  }

  /**
   * Compare two helpers considering both XOR distance and RTT proximity.
   * 
   * This comparator ensures XOR-distance correctness is preserved:
   * - If distances differ significantly, XOR distance wins
   * - If distances are equal, RTT is used as tiebreaker
   * - RTT never overrides XOR distance (Requirement 5.4)
   * 
   * @param {Helper} a - First helper
   * @param {Helper} b - Second helper
   * @param {number} proximityWeight - Weight factor for RTT influence (default: 0.1)
   * @returns {number} Negative if a < b, positive if a > b, 0 if equal
   * 
   * Requirements: 5.2, 5.4
   */
  static compareWithProximity = (a, b, proximityWeight = 0.1) => {
    // First compare by XOR distance (primary criterion)
    if (a.distance < b.distance) return -1;
    if (a.distance > b.distance) return 1;
    
    // XOR distances are equal - use RTT as tiebreaker
    const rttA = a.contact.rtt ?? 1000;
    const rttB = b.contact.rtt ?? 1000;
    
    // Lower RTT is better
    if (rttA < rttB) return -1;
    if (rttA > rttB) return 1;
    
    return 0;
  }
}
