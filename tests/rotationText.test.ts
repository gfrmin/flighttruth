import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain browser ES module, no type declarations
import { inboundSentence } from '../public/rotationText.js';

const inbound = (status: string, atd: string | null) => ({ status, atd, arrivalLocal: '11:45 Tue' });

describe('inboundSentence', () => {
  it('says the plane came in only once its inbound has landed', () => {
    expect(inboundSentence(inbound('Landed', '2026-11-10T07:47:02Z'))).toEqual({ lead: 'Your plane came in on', verb: 'landed' });
  });

  it('says the plane is on its way while the inbound is airborne', () => {
    expect(inboundSentence(inbound('Estimated', '2026-11-10T07:47:02Z'))).toEqual({ lead: 'Your plane is on its way in on', verb: 'due' });
  });

  it('tells the inbound as history once our flight has left', () => {
    const leg = { phase: 'departed', flightNumber: 'U21234', tailNumber: 'G-EZXX' };
    expect(inboundSentence(inbound('Landed', '2026-11-10T07:47:02Z'), leg)).toEqual({ lead: 'Before U21234, G-EZXX flew', verb: 'landed' });
    expect(inboundSentence(inbound('Landed', '2026-11-10T07:47:02Z'), { ...leg, phase: 'landed', tailNumber: null })).toEqual({ lead: 'Before U21234, the plane flew', verb: 'landed' });
  });

  it('says the plane comes in on a flight that has not left yet', () => {
    expect(inboundSentence(inbound('Scheduled', null))).toEqual({ lead: 'Your plane comes in on', verb: 'scheduled to land' });
  });
});
