import React from 'react';
import { SectionDivider } from '../components/ui/SectionDivider.js';
import { ReminderSettingsPanel } from '../components/ReminderSettingsPanel.js';
import { ScriptLibraryPanel } from '../components/ScriptLibraryPanel.js';

/**
 * Officer-tools page — the two panels (Reminders, Script Library) each render
 * their own console Card internally, so this shell just adds the calibrated
 * page-header identity, an uppercase mono caption above each panel, and a
 * SectionDivider between them. The panels will be restyled in a follow-on
 * pass; their behaviour is preserved here.
 */
export function OfficerToolsPage() {
  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <header className="hna-page-header">
        <p className="hna-page-marker">// OFFICER TOOLS</p>
        <h1 className="hna-page-title">Officer tools</h1>
        <p className="hna-page-sub">
          Reminder schedules and the saved script library — the two things
          officers reach for most often.
        </p>
      </header>

      <p className="hna-cap hna-cap--accent">[ REMINDERS ]</p>
      <ReminderSettingsPanel />

      <SectionDivider>SCRIPT LIBRARY</SectionDivider>

      <ScriptLibraryPanel />
    </div>
  );
}
