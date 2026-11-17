// How to describe the plane's inbound flight: past tense only once it has actually landed, and
// as history once our own flight has left (by then "your plane" is flying our flight).
export function inboundSentence(inbound, leg = null) {
  if (leg && (leg.phase === 'departed' || leg.phase === 'landed')) {
    return { lead: `Before ${leg.flightNumber}, ${leg.tailNumber ?? 'the plane'} flew`, verb: 'landed' };
  }
  if (inbound.status === 'Landed') return { lead: 'Your plane came in on', verb: 'landed' };
  if (inbound.atd) return { lead: 'Your plane is on its way in on', verb: 'due' };
  return { lead: 'Your plane comes in on', verb: 'scheduled to land' };
}
