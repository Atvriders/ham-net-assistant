import { describe, it, expect } from 'vitest';
import { parseLogText } from '../../src/lib/parseLog.js';

describe('parseLogText', () => {
  it('parses two sessions from the example block', () => {
    const text = [
      '4/25/26',
      'Topic: Ham Radio Emergency Preparedness: how could you help?',
      'NET control: AB0ZW James',
      'KC5QBT Jeff',
      'KF0WBD Bret',
      '',
      '5/2/26',
      'Topic: Antennas 101',
      'NET control: AB0ZW James',
      'W0XYZ Sam',
      'KD0AZG Tina',
    ].join('\n');
    const { sessions, errors } = parseLogText(text);
    expect(errors).toEqual([]);
    expect(sessions).toHaveLength(2);
    const s0 = sessions[0]!;
    expect(s0.date.getFullYear()).toBe(2026);
    expect(s0.date.getMonth()).toBe(3); // April
    expect(s0.date.getDate()).toBe(25);
    expect(s0.topic).toBe('Ham Radio Emergency Preparedness: how could you help?');
    expect(s0.controlOp).toEqual({ callsign: 'AB0ZW', name: 'James' });
    expect(s0.checkIns).toEqual([
      { callsign: 'KC5QBT', name: 'Jeff' },
      { callsign: 'KF0WBD', name: 'Bret' },
    ]);
    expect(sessions[1]!.checkIns).toHaveLength(2);
  });

  it('strips bullet glyphs from check-in lines', () => {
    const text = [
      '4/25/26',
      'NET control: AB0ZW James',
      // various bullet styles
      'KA0AAA Alice',
      '* KB0BBB Bob',
      '- KC0CCC Carol',
    ].join('\n');
    const { sessions, errors } = parseLogText(text);
    expect(errors).toEqual([]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.checkIns).toEqual([
      { callsign: 'KA0AAA', name: 'Alice' },
      { callsign: 'KB0BBB', name: 'Bob' },
      { callsign: 'KC0CCC', name: 'Carol' },
    ]);
  });

  it('strips bullet character from check-in lines', () => {
    // Bullet characters directly: filled and outlined dots
    const text = `4/25/26\nNET control: AB0ZW James\n● KC5QBT Jeff\n• KF0WBD Bret`;
    const { sessions, errors } = parseLogText(text);
    expect(errors).toEqual([]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.checkIns).toEqual([
      { callsign: 'KC5QBT', name: 'Jeff' },
      { callsign: 'KF0WBD', name: 'Bret' },
    ]);
  });

  it('parses ISO date format', () => {
    const text = '2026-04-25\nTopic: ISO date\nNET control: AB0ZW James\nKC5QBT Jeff';
    const { sessions, errors } = parseLogText(text);
    expect(errors).toEqual([]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.date.getFullYear()).toBe(2026);
    expect(sessions[0]!.date.getMonth()).toBe(3);
    expect(sessions[0]!.date.getDate()).toBe(25);
  });

  it('records error for malformed date', () => {
    const text = 'not-a-date\nTopic: Whatever\nKC5QBT Jeff';
    const { sessions, errors } = parseLogText(text);
    expect(sessions).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toContain('Could not parse date');
  });

  it('parses NET control: (none) with controlOp = null', () => {
    const text = '4/25/26\nTopic: Open net\nNET control: (none)\nKC5QBT Jeff';
    const { sessions, errors } = parseLogText(text);
    expect(errors).toEqual([]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.controlOp).toBeNull();
    expect(sessions[0]!.checkIns).toEqual([{ callsign: 'KC5QBT', name: 'Jeff' }]);
  });
});
