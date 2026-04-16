import { describe, it, expect } from 'vitest';
import { decideNextMove } from '../experiments/revenue-pulse.js';

describe('decideNextMove', () => {
  it('flags zero-everything state and calls for more outbound volume', () => {
    const m = decideNextMove({
      rev24: 0, rev7: 0, outbound: 1, replyRatio: null,
      qualified24: 0, activeCustomers: 0, burnCents: 3000,
    });
    expect(m).toMatch(/raise outbound DM volume/);
  });

  it('names the classifier as the lever when qualifications have stopped', () => {
    const m = decideNextMove({
      rev24: 0, rev7: 0, outbound: 20, replyRatio: 0.3,
      qualified24: 0, activeCustomers: 0, burnCents: 3000,
    });
    expect(m).toMatch(/audit the qualifier/);
  });

  it('names the copy as the lever when replies are under 10%', () => {
    const m = decideNextMove({
      rev24: 0, rev7: 0, outbound: 30, replyRatio: 0.05,
      qualified24: 2, activeCustomers: 0, burnCents: 3000,
    });
    expect(m).toMatch(/rewrite the outreach-thermostat copy/);
  });

  it('flags underwater when revenue exists but burn outpaces it', () => {
    const m = decideNextMove({
      rev24: 500, rev7: 1500, outbound: 30, replyRatio: 0.2,
      qualified24: 2, activeCustomers: 1, burnCents: 3000,
    });
    expect(m).toMatch(/underwater/);
    expect(m).toMatch(/cap spend/);
  });

  it('doubles down when revenue is healthy and a customer exists', () => {
    const m = decideNextMove({
      rev24: 5000, rev7: 20000, outbound: 40, replyRatio: 0.3,
      qualified24: 5, activeCustomers: 3, burnCents: 3000,
    });
    expect(m).toMatch(/double down/);
  });
});
