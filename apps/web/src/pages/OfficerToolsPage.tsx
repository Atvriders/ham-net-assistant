import React from 'react';
import { ReminderSettingsPanel } from '../components/ReminderSettingsPanel.js';
import { ScriptLibraryPanel } from '../components/ScriptLibraryPanel.js';

export function OfficerToolsPage() {
  return (
    <div className="hna-container" style={{ maxWidth: 900, margin: '0 auto' }}>
      <h1>Officer tools</h1>
      <ReminderSettingsPanel />
      <div style={{ height: 16 }} />
      <ScriptLibraryPanel />
    </div>
  );
}
