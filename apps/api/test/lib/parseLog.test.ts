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

  it('silently skips orphan content with no date anchor', () => {
    // Lines before the first date and content with no parseable date at all
    // are dropped — they are not errors. This is the new behaviour: prose
    // never produces parser errors, only missing-anchor cases.
    const text = 'not-a-date\nTopic: Whatever\nKC5QBT Jeff';
    const { sessions, errors } = parseLogText(text);
    expect(sessions).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  it('parses NET control: (none) with controlOp = null', () => {
    const text = '4/25/26\nTopic: Open net\nNET control: (none)\nKC5QBT Jeff';
    const { sessions, errors } = parseLogText(text);
    expect(errors).toEqual([]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.controlOp).toBeNull();
    expect(sessions[0]!.checkIns).toEqual([{ callsign: 'KC5QBT', name: 'Jeff' }]);
  });

  it('accepts a date typo (3/28//26)', () => {
    const text = '3/28//26\nTopic: Test\nKC5QBT Jeff';
    const { sessions, errors } = parseLogText(text);
    expect(errors).toEqual([]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.date.getFullYear()).toBe(2026);
    expect(sessions[0]!.date.getMonth()).toBe(2); // March
    expect(sessions[0]!.date.getDate()).toBe(28);
  });

  it('captures trailing parenthetical prose as session notes', () => {
    const text = '1/18/25 (2m rpt)\nTopic: Test\nKC5QBT Jeff';
    const { sessions, errors } = parseLogText(text);
    expect(errors).toEqual([]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.notes).toBe('(2m rpt)');
  });

  it('captures multi-word trailing date prose', () => {
    const text = '8/1/24 (2m rpt new pre-amp and reduced 5w RF output power)\nTopic: x';
    const { sessions, errors } = parseLogText(text);
    expect(errors).toEqual([]);
    expect(sessions[0]!.notes).toBe('(2m rpt new pre-amp and reduced 5w RF output power)');
  });

  it('captures non-parenthetical trailing prose', () => {
    const text = '11/9/24 70cm > 2m\nTopic: x';
    const { sessions, errors } = parseLogText(text);
    expect(errors).toEqual([]);
    expect(sessions[0]!.notes).toBe('70cm > 2m');
  });

  it('accepts NET control with no name (callsign only)', () => {
    const text = '4/25/26\nNET control: KC5QBT\nKA0JPM Mark';
    const { sessions } = parseLogText(text);
    expect(sessions[0]!.controlOp).toEqual({ callsign: 'KC5QBT', name: '' });
  });

  it('accepts Control: alias with no name', () => {
    const text = '4/25/26\nControl: AB0ZW\nKA0JPM Mark';
    const { sessions } = parseLogText(text);
    expect(sessions[0]!.controlOp).toEqual({ callsign: 'AB0ZW', name: '' });
  });

  it('captures Backup: <Name> <CALLSIGN>', () => {
    const text = '4/25/26\nNET control: AB0ZW James\nBackup: Tommy KE0VUM\nKA0JPM Mark';
    const { sessions } = parseLogText(text);
    expect(sessions[0]!.backups).toEqual([{ callsign: 'KE0VUM', name: 'Tommy' }]);
  });

  it('captures multi-word backup names', () => {
    const text = '4/25/26\nBackup: Tom Theis KE0VUM';
    const { sessions } = parseLogText(text);
    expect(sessions[0]!.backups).toEqual([{ callsign: 'KE0VUM', name: 'Tom Theis' }]);
  });

  it('captures Backup: callsign-only line', () => {
    const text = '4/25/26\nBackup: KE0VUM';
    const { sessions } = parseLogText(text);
    expect(sessions[0]!.backups).toEqual([{ callsign: 'KE0VUM', name: '' }]);
  });

  it('silently skips section headers (Check-ins:, Checkins:, Announcements)', () => {
    const text = [
      '4/25/26',
      'Check-ins:',
      'Checkins:',
      'Announcements',
      'Notes',
      'KC5QBT Jeff',
    ].join('\n');
    const { sessions, errors } = parseLogText(text);
    expect(errors).toEqual([]);
    // Headers are not check-ins.
    expect(sessions[0]!.checkIns).toEqual([{ callsign: 'KC5QBT', name: 'Jeff' }]);
  });

  it('accepts callsign-only check-ins (name is empty string)', () => {
    const text = '4/25/26\nKC5QBT\nKA0JPM\nKF0OEP';
    const { sessions, errors } = parseLogText(text);
    expect(errors).toEqual([]);
    expect(sessions[0]!.checkIns).toEqual([
      { callsign: 'KC5QBT', name: '' },
      { callsign: 'KA0JPM', name: '' },
      { callsign: 'KF0OEP', name: '' },
    ]);
  });

  it('uppercases lowercase callsigns', () => {
    const text = '4/25/26\nKa0jpm\nkf0oep\nwn0ks';
    const { sessions } = parseLogText(text);
    expect(sessions[0]!.checkIns.map((c) => c.callsign)).toEqual(['KA0JPM', 'KF0OEP', 'WN0KS']);
  });

  it('parses compound club/operator callsigns', () => {
    const text = '4/25/26\nW0QQQ/AB0ZW James';
    const { sessions } = parseLogText(text);
    expect(sessions[0]!.checkIns).toEqual([{ callsign: 'W0QQQ/AB0ZW', name: 'James' }]);
  });

  it('does not require blank lines between sessions', () => {
    // Real club docs: two date lines back-to-back must produce two sessions.
    const text = [
      '4/25/26',
      'KC5QBT Jeff',
      '5/2/26',
      'KA0JPM Mark',
    ].join('\n');
    const { sessions, errors } = parseLogText(text);
    expect(errors).toEqual([]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.checkIns).toEqual([{ callsign: 'KC5QBT', name: 'Jeff' }]);
    expect(sessions[1]!.checkIns).toEqual([{ callsign: 'KA0JPM', name: 'Mark' }]);
  });

  it('tolerates a real-world club doc fragment', () => {
    const text = [
      'K-State Amateur Radio Club Net Log',
      '',
      '4/4/26',
      'Topic: Artemis Launch',
      'NET control: AB0ZW James',
      'Check-ins:',
      'KC5QBT Jeff',
      'KA0JPM Mark',
      'KF0OEP',
      '',
      '3/28//26',
      'Topic: APRS basics',
      'NET control: AB0ZW James',
      'Announcements',
      'SkyWARN/Spotting: 3/24 Riley County Storm Spotter Training at 7-8:30PM Pottorff Hall (Cico)',
      'Check-ins:',
      'W0QQQ/AB0ZW James',
      'KA0JPM',
      'KC5QBT',
      'KF0OEP',
      '3/1/25 (70cm repeater)',
      'Topic: Test net',
      'Control: AB0ZW',
      'Backup: Tom Theis KE0VUM',
      'Checkins:',
      'KC5QBT Jeff',
      'ka0jpm Mark',
      '8/1/24 (2m rpt new pre-amp and reduced 5w RF output power)',
      'Topic: Equipment update',
      'NET control: AB0ZW James',
      'KC5QBT Jeff',
    ].join('\n');
    const { sessions, errors } = parseLogText(text);
    expect(errors).toEqual([]);
    expect(sessions).toHaveLength(4);

    // Session 1 — clean, callsign-only F0OEP captured.
    const s0 = sessions[0]!;
    expect(s0.date.getFullYear()).toBe(2026);
    expect(s0.date.getMonth()).toBe(3); // April
    expect(s0.date.getDate()).toBe(4);
    expect(s0.topic).toBe('Artemis Launch');
    expect(s0.controlOp).toEqual({ callsign: 'AB0ZW', name: 'James' });
    expect(s0.checkIns).toEqual([
      { callsign: 'KC5QBT', name: 'Jeff' },
      { callsign: 'KA0JPM', name: 'Mark' },
      { callsign: 'KF0OEP', name: '' },
    ]);

    // Session 2 — typo date and announcement prose; check-ins after the
    // header include callsign-only entries and a compound club call.
    const s1 = sessions[1]!;
    expect(s1.date.getFullYear()).toBe(2026);
    expect(s1.date.getMonth()).toBe(2); // March
    expect(s1.date.getDate()).toBe(28);
    expect(s1.checkIns).toEqual([
      { callsign: 'W0QQQ/AB0ZW', name: 'James' },
      { callsign: 'KA0JPM', name: '' },
      { callsign: 'KC5QBT', name: '' },
      { callsign: 'KF0OEP', name: '' },
    ]);

    // Session 3 — trailing parenthetical, Control: alias, Backup capture,
    // lowercase callsign normalization, no blank line before this session.
    const s2 = sessions[2]!;
    expect(s2.date.getFullYear()).toBe(2025);
    expect(s2.date.getMonth()).toBe(2);
    expect(s2.date.getDate()).toBe(1);
    expect(s2.notes).toBe('(70cm repeater)');
    expect(s2.controlOp).toEqual({ callsign: 'AB0ZW', name: '' });
    expect(s2.backups).toEqual([{ callsign: 'KE0VUM', name: 'Tom Theis' }]);
    expect(s2.checkIns).toEqual([
      { callsign: 'KC5QBT', name: 'Jeff' },
      { callsign: 'KA0JPM', name: 'Mark' },
    ]);

    // Session 4 — multi-word trailing prose preserved verbatim.
    const s3 = sessions[3]!;
    expect(s3.notes).toBe('(2m rpt new pre-amp and reduced 5w RF output power)');
  });

  it('does not emit errors for unparseable prose-only blocks', () => {
    const text = [
      'totally not a date',
      'Some announcement here',
      'And another line of prose',
      '',
      'still not a date',
      'more lines',
    ].join('\n');
    const { sessions, errors } = parseLogText(text);
    expect(sessions).toHaveLength(0);
    expect(errors).toEqual([]);
  });
});

describe('parseLog real-world tolerance', () => {
  it('strips parenthetical annotations from date', () => {
    const r = parseLogText('3/1/25 (70cm repeater)\nKC5QBT Jeff');
    expect(r.errors).toEqual([]);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]!.date.getFullYear()).toBe(2025);
    expect(r.sessions[0]!.date.getMonth()).toBe(2); // March
  });

  it('normalizes double slash in date', () => {
    const r = parseLogText('3/28//26\nKC5QBT Jeff');
    expect(r.errors).toEqual([]);
    expect(r.sessions[0]!.date.getMonth()).toBe(2);
    expect(r.sessions[0]!.date.getDate()).toBe(28);
  });

  it('strips trailing free text after date', () => {
    const r = parseLogText('11/9/24 70cm > 2m\nKC5QBT Jeff');
    expect(r.errors).toEqual([]);
  });

  it('handles long parenthetical annotation after date', () => {
    const r = parseLogText('8/1/24 (2m rpt new pre-amp and reduced 5w RF output power)\nKC5QBT Jeff');
    expect(r.errors).toEqual([]);
    expect(r.sessions).toHaveLength(1);
  });

  it('handles trailing prose plus parenthetical (DDay Memorial)', () => {
    const r = parseLogText('6/6/24 DDay Memorial (First 70cm net)\nKC5QBT Jeff');
    expect(r.errors).toEqual([]);
    expect(r.sessions[0]!.date.getMonth()).toBe(5); // June
    expect(r.sessions[0]!.date.getDate()).toBe(6);
  });

  it('accepts mixed-case Net control:', () => {
    const r = parseLogText('1/1/26\nNet control: KC5QBT\nKF0OEP Bret');
    expect(r.errors).toEqual([]);
    expect(r.sessions[0]!.controlOp).toEqual({ callsign: 'KC5QBT', name: '' });
  });

  it('accepts short Control: prefix', () => {
    const r = parseLogText('1/1/26\nControl: AB0ZW James\nKF0OEP Bret');
    expect(r.sessions[0]!.controlOp).toEqual({ callsign: 'AB0ZW', name: 'James' });
  });

  it('accepts compound prefix callsign in control op', () => {
    const r = parseLogText('1/1/26\nNet control: W0QQQ/AB0ZW James');
    expect(r.sessions[0]!.controlOp?.callsign).toBe('W0QQQ/AB0ZW');
    expect(r.sessions[0]!.controlOp?.name).toBe('James');
  });

  it('skips Check-ins: header silently', () => {
    const r = parseLogText('1/1/26\nCheck-ins:\nKC5QBT Jeff');
    expect(r.errors).toEqual([]);
    expect(r.sessions[0]!.checkIns).toHaveLength(1);
  });

  it('skips Checkins: (no dash) header silently', () => {
    const r = parseLogText('1/1/26\nCheckins:\nKC5QBT Jeff');
    expect(r.errors).toEqual([]);
  });

  it('skips Announcements section silently', () => {
    const r = parseLogText('1/1/26\nAnnouncements\nSomething happened\nKC5QBT Jeff');
    expect(r.errors).toEqual([]);
    expect(r.sessions[0]!.checkIns).toHaveLength(1);
  });

  it('skips Backup operator line silently (still captured to backups[])', () => {
    const r = parseLogText('1/1/26\nBackup: Tommy KE0VUM\nKC5QBT Jeff');
    expect(r.errors).toEqual([]);
    expect(r.sessions[0]!.checkIns).toEqual([{ callsign: 'KC5QBT', name: 'Jeff' }]);
  });

  it('accepts a bare callsign with no name', () => {
    const r = parseLogText('1/1/26\nKC5QBT');
    expect(r.errors).toEqual([]);
    expect(r.sessions[0]!.checkIns).toEqual([{ callsign: 'KC5QBT', name: '' }]);
  });

  it('uppercases lowercase callsigns', () => {
    const r = parseLogText('1/1/26\nka0jpm\nkf0oep Bret');
    expect(r.sessions[0]!.checkIns).toEqual([
      { callsign: 'KA0JPM', name: '' },
      { callsign: 'KF0OEP', name: 'Bret' },
    ]);
  });

  it('skips prose lines silently (SkyWARN/Spotting paragraph)', () => {
    const r = parseLogText('1/1/26\nSkyWARN/Spotting: 3/24 Riley County Storm Spotter Training\nKC5QBT Jeff');
    expect(r.errors).toEqual([]);
    expect(r.sessions[0]!.checkIns).toHaveLength(1);
  });
});
