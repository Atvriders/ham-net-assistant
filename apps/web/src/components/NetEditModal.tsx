import React, { useEffect, useId, useMemo, useState } from 'react';
import type { Net, NetInput, NetScript, Repeater, ScriptCategory } from '@hna/shared';
import { DEFAULT_REMINDER_MINUTES } from '@hna/shared';
import { apiFetch, ApiErrorException } from '../api/client.js';
import { Button } from './ui/Button.js';
import { Input } from './ui/Input.js';
import { Modal } from './ui/Modal.js';
import { ConfirmModal } from './ui/ConfirmModal.js';
import { ScriptImportModal } from './ScriptImportModal.js';
import { ScriptLibraryPicker } from './ScriptLibraryPicker.js';
import { ScriptEditor } from './ScriptEditor.lazy.js';
import { dayName, to12h, to24h } from '../lib/time.js';

interface NetLinkWithRepeater {
  id: string;
  repeaterId: string;
  repeater: Repeater;
  note?: string | null;
}
export interface NetWithRepeater extends Net {
  repeater: Repeater;
  links?: NetLinkWithRepeater[];
}

export function netToInput(n: NetWithRepeater): NetInput {
  return {
    name: n.name,
    kind: n.kind,
    repeaterId: n.repeaterId,
    dayOfWeek: n.dayOfWeek,
    startLocal: n.startLocal,
    timezone: n.timezone,
    theme: n.theme ?? null,
    scriptMd: n.scriptMd ?? null,
    scriptCategory: n.scriptCategory ?? 'general',
    reminderMinutes: Array.isArray(n.reminderMinutes)
      ? [...n.reminderMinutes]
      : [...DEFAULT_REMINDER_MINUTES],
    active: n.active,
    linkedRepeaterIds: (n.links ?? []).map((l) => l.repeaterId),
  };
}

export const emptyNetInput: NetInput = {
  name: '',
  kind: 'weekly',
  repeaterId: '',
  // No baked-in schedule defaults — the user must explicitly pick a day and
  // start time. Empty strings + an undefined dayOfWeek surface as the
  // "PICK" placeholder option, which the form-level validator catches at
  // submit.
  dayOfWeek: undefined,
  startLocal: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  theme: '',
  scriptMd: '',
  scriptCategory: 'general',
  // New nets start with reminders OFF; officers opt in from the edit form
  // or the centralized Reminder Settings panel.
  reminderMinutes: [],
  active: true,
  linkedRepeaterIds: [],
};

/**
 * Zones offered when the browser cannot enumerate the IANA database itself.
 * Deliberately short and US-college-club shaped — it only has to keep the
 * control usable on an old engine, not mirror tzdata.
 */
const FALLBACK_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Puerto_Rico',
  'Europe/London',
];

/**
 * Selectable IANA zone identifiers.
 *
 * This used to be a free-text box, which is how values like "CDT" reached the
 * server: `Intl.DateTimeFormat` throws on them, so every scheduling
 * calculation for that net (next occurrence, Discord reminders, the
 * five-minute announcement) failed permanently and could only be repaired by
 * editing the row. Constraining the control to real identifiers makes that
 * class of typo unrepresentable. Computed once at module load — the list is
 * ~400 entries and never changes.
 */
const IANA_TIMEZONES: string[] = (() => {
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      const zones = Intl.supportedValuesOf('timeZone');
      if (zones.length > 0) {
        // Some engines omit plain "UTC" from the enumeration even though they
        // accept it, and existing nets are stored with it.
        return zones.includes('UTC') ? [...zones] : ['UTC', ...zones];
      }
    }
  } catch {
    /* engines predating the 'timeZone' key throw RangeError */
  }
  return FALLBACK_TIMEZONES;
})();

// Common preset reminder lead times offered as one-click chips.
const REMINDER_PRESETS: { label: string; minutes: number }[] = [
  { label: '24h', minutes: 1440 },
  { label: '4h', minutes: 240 },
  { label: '1h', minutes: 60 },
  { label: '30m', minutes: 30 },
  { label: '15m', minutes: 15 },
];

interface Props {
  /** Whether the modal is open. */
  open: boolean;
  /** Net id when editing an existing net; omit/undefined to create a new net. */
  netId?: string;
  /** Initial form values. */
  initial: NetInput;
  /** Optional preloaded repeaters; fetched on open when not supplied. */
  repeaters?: Repeater[];
  onClose: () => void;
  /** Called after a successful save (POST or PATCH). */
  onSaved: () => void | Promise<void>;
}

/**
 * Shared net create/edit modal. Extracted from NetsPage so other surfaces
 * (e.g. the running-net script panel) can offer the same edit affordance
 * without duplicating the form.
 */
export function NetEditModal({
  open,
  netId,
  initial,
  repeaters: repeatersProp,
  onClose,
  onSaved,
}: Props) {
  const [data, setData] = useState<NetInput>(initial);
  const [repeaters, setRepeaters] = useState<Repeater[]>(repeatersProp ?? []);
  const [scriptImportOpen, setScriptImportOpen] = useState(false);
  const [scriptPickerOpen, setScriptPickerOpen] = useState(false);
  const [loadedScriptTitle, setLoadedScriptTitle] = useState<string | null>(null);
  const [saveScriptStatus, setSaveScriptStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  // Pending saved-script replacement awaiting user confirmation. When non-null
  // the ConfirmModal asks the operator whether to overwrite the current
  // script body before we mutate the form.
  const [pendingReplaceScript, setPendingReplaceScript] =
    useState<NetScript | null>(null);

  // Field ids — drive `htmlFor` ↔ control id linkage, plus
  // `aria-describedby` for the inline error messages.
  const nameId = useId();
  const kindId = useId();
  const repeaterFieldId = useId();
  const dayId = useId();
  const startHourId = useId();
  const startMinuteId = useId();
  const startMeridiemId = useId();
  const timezoneId = useId();
  const themeId = useId();
  const scriptCategoryId = useId();
  const errBannerId = useId();
  const dialogTitleId = useId();

  // Re-seed the form whenever the modal (re)opens for a different net.
  useEffect(() => {
    if (open) {
      setData(initial);
      setLoadedScriptTitle(null);
      setSaveScriptStatus(null);
      setErrors({});
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, netId]);

  // Load repeaters when none were supplied by the parent.
  useEffect(() => {
    if (!open || repeatersProp) return;
    let cancelled = false;
    apiFetch<Repeater[]>('/repeaters')
      .then((rows) => {
        if (!cancelled) setRepeaters(rows);
      })
      .catch(() => {
        /* ignore — repeater list stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, [open, repeatersProp]);

  useEffect(() => {
    if (repeatersProp) setRepeaters(repeatersProp);
  }, [repeatersProp]);

  /**
   * Inline form validation. Returns the next errors map; the caller decides
   * whether to short-circuit a write and surface the banner.
   */
  function validate(): Partial<Record<string, string>> {
    const next: Partial<Record<string, string>> = {};
    const isWeekly = (data.kind ?? 'weekly') === 'weekly';
    if (!data.name.trim()) {
      next.name = 'Name is required.';
    }
    if (!data.repeaterId) {
      next.repeaterId = 'Pick a primary repeater.';
    }
    if (isWeekly) {
      if (data.dayOfWeek === undefined || data.dayOfWeek === null) {
        next.dayOfWeek = 'Pick a day of the week.';
      }
      if (!data.startLocal || !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.startLocal)) {
        next.startLocal = 'Pick a start time.';
      }
    }
    if (!data.timezone || !data.timezone.trim()) {
      next.timezone = 'Timezone is required.';
    }
    if (!data.scriptCategory) {
      next.scriptCategory = 'Pick a script category.';
    }
    return next;
  }

  async function save() {
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setFormError(
        'Fix the highlighted fields before saving.',
      );
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      if (netId) {
        await apiFetch(`/nets/${netId}`, {
          method: 'PATCH',
          body: JSON.stringify(data),
        });
      } else {
        await apiFetch('/nets', { method: 'POST', body: JSON.stringify(data) });
      }
      await onSaved();
      onClose();
    } catch (e) {
      const msg =
        e instanceof ApiErrorException
          ? e.payload.message
          : (e as Error).message;
      setFormError(msg || 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  function applySavedScript(script: NetScript): void {
    const current = (data.scriptMd ?? '').trim();
    if (current.length > 0) {
      // Stage the replacement so the ConfirmModal can surface the same legacy
      // copy ("Replace the current script with … ? This cannot be undone.")
      // inside a calibrated dialog instead of window.confirm.
      setPendingReplaceScript(script);
      return;
    }
    setData({
      ...data,
      scriptMd: script.body,
      scriptCategory: script.category,
    });
    setLoadedScriptTitle(script.title);
    setScriptPickerOpen(false);
  }

  function confirmReplaceScript(): void {
    const script = pendingReplaceScript;
    if (!script) return;
    setData({
      ...data,
      scriptMd: script.body,
      scriptCategory: script.category,
    });
    setLoadedScriptTitle(script.title);
    setScriptPickerOpen(false);
    setPendingReplaceScript(null);
  }

  async function saveAsScript(): Promise<void> {
    const body = data.scriptMd ?? '';
    if (!body.trim()) {
      setSaveScriptStatus('Script is empty — nothing to save.');
      return;
    }
    const defaultTitle = `${(data.name || 'Untitled').trim()} script`;
    const titleRaw = window.prompt('Save this script as…', defaultTitle);
    if (titleRaw === null) return;
    const title = titleRaw.trim();
    if (!title) {
      setSaveScriptStatus('A title is required.');
      return;
    }
    setSaveScriptStatus('Saving…');
    try {
      const created = await apiFetch<NetScript>('/scripts', {
        method: 'POST',
        body: JSON.stringify({
          title,
          category: data.scriptCategory ?? 'general',
          body,
        }),
      });
      setLoadedScriptTitle(created.title);
      setSaveScriptStatus(`Saved as "${created.title}".`);
    } catch (e) {
      const msg =
        e instanceof ApiErrorException ? e.payload.message : (e as Error).message;
      setSaveScriptStatus(`Save failed: ${msg}`);
    }
  }

  const dialogTitle = netId ? 'Edit net' : 'New net';
  // A net saved before the picker existed may carry a zone this engine's
  // tzdata does not list. Keep it in the options so merely opening the editor
  // cannot silently rewrite an existing net's schedule.
  const timezoneOptions = useMemo(() => {
    const current = data.timezone;
    if (!current || IANA_TIMEZONES.includes(current)) return IANA_TIMEZONES;
    return [current, ...IANA_TIMEZONES];
  }, [data.timezone]);
  const isWeekly = (data.kind ?? 'weekly') === 'weekly';
  // The internal hh:mm pieces, with a sentinel when startLocal is empty so the
  // selects can render a "PICK" placeholder option that fails validation.
  const startSet =
    data.startLocal && /^([01]\d|2[0-3]):[0-5]\d$/.test(data.startLocal);
  const startPieces = startSet
    ? to12h(data.startLocal as string)
    : { hour: 0, minute: -1, meridiem: 'AM' as const };

  // Wire the existing in-body <h2> as the dialog's accessible name so the
  // Modal's header bar doesn't duplicate the title visually and screen
  // readers still announce "Edit net" / "New net" via aria-labelledby.

  return (
    <>
      <Modal open={open} onClose={onClose} size="wide" titleId={dialogTitleId}>
        <div>
          <h2 id={dialogTitleId} style={{ marginTop: 0 }}>
            {dialogTitle}
          </h2>
          {formError && (
            <div
              id={errBannerId}
              role="alert"
              className="hna-form-error"
              data-testid="net-edit-form-error"
            >
              {formError}
            </div>
          )}
          <div className="hna-form">
            <div className="hna-field">
              <label htmlFor={nameId}>
                Name
                <span className="hna-required" aria-hidden="true">
                  *
                </span>
              </label>
              <Input
                id={nameId}
                value={data.name}
                aria-required="true"
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? `${nameId}-err` : undefined}
                onChange={(e) => setData({ ...data, name: e.target.value })}
              />
              {errors.name && (
                <p id={`${nameId}-err`} className="hna-input-error">
                  {errors.name}
                </p>
              )}
            </div>

            <div className="hna-field">
              <label htmlFor={kindId}>Kind</label>
              <select
                id={kindId}
                className="hna-input"
                value={data.kind ?? 'weekly'}
                onChange={(e) =>
                  setData({
                    ...data,
                    kind: e.target.value as 'weekly' | 'impromptu',
                  })
                }
              >
                <option value="weekly">Weekly (scheduled)</option>
                <option value="impromptu">Impromptu (ad-hoc)</option>
              </select>
              {(data.kind ?? 'weekly') === 'impromptu' && (
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                  Impromptu nets have no fixed schedule and are skipped by net
                  reminders.
                </div>
              )}
            </div>

            <fieldset className="hna-repeater-group">
              <legend>Repeaters</legend>
              {(() => {
                const primary = repeaters.find(
                  (r) => r.id === data.repeaterId,
                );
                const linkedIds = data.linkedRepeaterIds ?? [];
                const linked = repeaters.filter((r) =>
                  linkedIds.includes(r.id),
                );
                return (
                  <ul className="hna-repeater-group-summary">
                    <li>
                      <span className="hna-repeater-group-tag">Primary</span>
                      <span>
                        {primary
                          ? `${primary.name} — ${primary.frequency.toFixed(3)} MHz`
                          : '—'}
                      </span>
                    </li>
                    {linked.map((r) => (
                      <li key={r.id}>
                        <span className="hna-repeater-group-tag">Linked</span>
                        <span>
                          {r.name} — {r.frequency.toFixed(3)} MHz
                        </span>
                      </li>
                    ))}
                  </ul>
                );
              })()}

              <div className="hna-field">
                <label htmlFor={repeaterFieldId}>
                  Primary repeater
                  <span className="hna-required" aria-hidden="true">
                    *
                  </span>
                </label>
                <select
                  id={repeaterFieldId}
                  className="hna-input"
                  value={data.repeaterId}
                  aria-required="true"
                  aria-invalid={errors.repeaterId ? true : undefined}
                  aria-describedby={
                    errors.repeaterId ? `${repeaterFieldId}-err` : undefined
                  }
                  onChange={(e) =>
                    setData({ ...data, repeaterId: e.target.value })
                  }
                >
                  {!data.repeaterId && (
                    <option value="" disabled>
                      — PICK —
                    </option>
                  )}
                  {repeaters.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} — {r.frequency.toFixed(3)} MHz
                    </option>
                  ))}
                </select>
                {errors.repeaterId && (
                  <p
                    id={`${repeaterFieldId}-err`}
                    className="hna-input-error"
                  >
                    {errors.repeaterId}
                  </p>
                )}
              </div>

              <div className="hna-field">
                <label>Linked repeaters (optional)</label>
                <div className="hna-checkbox-list">
                  {repeaters.filter((r) => r.id !== data.repeaterId).length ===
                    0 && (
                    <div style={{ fontSize: 12, opacity: 0.7 }}>
                      No other repeaters available.
                    </div>
                  )}
                  {repeaters
                    .filter((r) => r.id !== data.repeaterId)
                    .map((r) => {
                      const checked = (data.linkedRepeaterIds ?? []).includes(
                        r.id,
                      );
                      return (
                        <label key={r.id}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const current = data.linkedRepeaterIds ?? [];
                              const next = e.target.checked
                                ? [...current, r.id]
                                : current.filter((id) => id !== r.id);
                              setData({ ...data, linkedRepeaterIds: next });
                            }}
                          />
                          <span>
                            {r.name} — {r.frequency.toFixed(3)} MHz
                          </span>
                        </label>
                      );
                    })}
                </div>
              </div>
            </fieldset>

            {isWeekly && (
              <div className="hna-field-row-2">
                <div className="hna-field">
                  <label htmlFor={dayId}>
                    Day of week
                    <span className="hna-required" aria-hidden="true">
                      *
                    </span>
                  </label>
                  <select
                    id={dayId}
                    className="hna-input"
                    value={data.dayOfWeek ?? ''}
                    aria-required="true"
                    aria-invalid={errors.dayOfWeek ? true : undefined}
                    aria-describedby={
                      errors.dayOfWeek ? `${dayId}-err` : undefined
                    }
                    onChange={(e) =>
                      setData({
                        ...data,
                        dayOfWeek:
                          e.target.value === ''
                            ? undefined
                            : Number(e.target.value),
                      })
                    }
                  >
                    {(data.dayOfWeek === undefined ||
                      data.dayOfWeek === null) && (
                      <option value="" disabled>
                        — PICK —
                      </option>
                    )}
                    {Array.from({ length: 7 }, (_, i) => (
                      <option key={i} value={i}>
                        {dayName(i)}
                      </option>
                    ))}
                  </select>
                  {errors.dayOfWeek && (
                    <p id={`${dayId}-err`} className="hna-input-error">
                      {errors.dayOfWeek}
                    </p>
                  )}
                </div>
                <div className="hna-field">
                  <label htmlFor={startHourId}>
                    Start time
                    <span className="hna-required" aria-hidden="true">
                      *
                    </span>
                  </label>
                  {(() => {
                    const t = startPieces;
                    const updateTime = (
                      patch: Partial<{
                        hour: number;
                        minute: number;
                        meridiem: 'AM' | 'PM';
                      }>,
                    ) => {
                      const merged = {
                        hour: t.hour || 8,
                        minute: t.minute < 0 ? 0 : t.minute,
                        meridiem: t.meridiem,
                        ...patch,
                      };
                      setData({ ...data, startLocal: to24h(merged) });
                    };
                    const minutes = [
                      0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55,
                    ];
                    const hourValue = startSet ? t.hour : '';
                    const minuteValue = startSet
                      ? minutes.includes(t.minute)
                        ? t.minute
                        : 0
                      : '';
                    const errDescribedBy = errors.startLocal
                      ? `${startHourId}-err`
                      : undefined;
                    return (
                      <>
                        <div className="hna-field-row">
                          <select
                            id={startHourId}
                            className="hna-input"
                            value={hourValue}
                            aria-required="true"
                            aria-invalid={
                              errors.startLocal ? true : undefined
                            }
                            aria-describedby={errDescribedBy}
                            onChange={(e) =>
                              updateTime({ hour: Number(e.target.value) })
                            }
                          >
                            {!startSet && (
                              <option value="" disabled>
                                — PICK —
                              </option>
                            )}
                            {Array.from({ length: 12 }, (_, i) => i + 1).map(
                              (h) => (
                                <option key={h} value={h}>
                                  {h}
                                </option>
                              ),
                            )}
                          </select>
                          <select
                            id={startMinuteId}
                            className="hna-input"
                            aria-label="Start minute"
                            value={minuteValue}
                            onChange={(e) =>
                              updateTime({ minute: Number(e.target.value) })
                            }
                          >
                            {!startSet && (
                              <option value="" disabled>
                                — :MM —
                              </option>
                            )}
                            {minutes.map((m) => (
                              <option key={m} value={m}>
                                {String(m).padStart(2, '0')}
                              </option>
                            ))}
                          </select>
                          <select
                            id={startMeridiemId}
                            className="hna-input"
                            aria-label="Start meridiem (AM/PM)"
                            value={t.meridiem}
                            onChange={(e) =>
                              updateTime({
                                meridiem: e.target.value as 'AM' | 'PM',
                              })
                            }
                          >
                            <option value="AM">AM</option>
                            <option value="PM">PM</option>
                          </select>
                        </div>
                        {errors.startLocal && (
                          <p
                            id={`${startHourId}-err`}
                            className="hna-input-error"
                          >
                            {errors.startLocal}
                          </p>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
            )}

            {isWeekly && (
              <div className="hna-field">
                <label htmlFor={timezoneId}>
                  Timezone
                  <span className="hna-required" aria-hidden="true">
                    *
                  </span>
                </label>
                <select
                  id={timezoneId}
                  className="hna-input"
                  value={data.timezone ?? ''}
                  aria-required="true"
                  aria-invalid={errors.timezone ? true : undefined}
                  aria-describedby={
                    errors.timezone ? `${timezoneId}-err` : undefined
                  }
                  onChange={(e) =>
                    setData({ ...data, timezone: e.target.value })
                  }
                >
                  {!data.timezone && (
                    <option value="" disabled>
                      — PICK ZONE —
                    </option>
                  )}
                  {timezoneOptions.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
                {errors.timezone && (
                  <p id={`${timezoneId}-err`} className="hna-input-error">
                    {errors.timezone}
                  </p>
                )}
              </div>
            )}

            {(data.kind ?? 'weekly') === 'weekly' && (
              <div className="hna-field">
                <label>Reminders</label>
                <ReminderMinutesEditor
                  value={data.reminderMinutes ?? []}
                  onChange={(next) =>
                    setData({ ...data, reminderMinutes: next })
                  }
                />
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                  Discord pings to fire before the net starts. Leave empty for
                  no reminders on this net.
                </div>
              </div>
            )}

            <div className="hna-field">
              <label htmlFor={themeId}>
                Theme (this week&rsquo;s topic cue)
              </label>
              <Input
                id={themeId}
                value={data.theme ?? ''}
                onChange={(e) => setData({ ...data, theme: e.target.value })}
              />
            </div>

            <div className="hna-field">
              {/*
                "Script category" is now fully associated with the select via
                htmlFor/id (scriptCategoryId already exists from useId above).
                The saved-script picker's own "Category" filter is still
                reachable by `getByLabelText(/Category/i)` from tests when
                scoped to the picker dialog via `within(pickerDialog)` —
                see ScriptLibraryPicker.test.tsx.
              */}
              <label
                htmlFor={scriptCategoryId}
                className="hna-field-caption"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--color-fg-muted)',
                  fontWeight: 500,
                }}
              >
                Script category
                <span className="hna-required" aria-hidden="true">
                  *
                </span>
              </label>
              <select
                id={scriptCategoryId}
                className="hna-input"
                value={data.scriptCategory ?? 'general'}
                aria-required="true"
                aria-invalid={errors.scriptCategory ? true : undefined}
                aria-describedby={
                  errors.scriptCategory ? `${scriptCategoryId}-err` : undefined
                }
                onChange={(e) =>
                  setData({
                    ...data,
                    scriptCategory: e.target.value as ScriptCategory,
                  })
                }
              >
                <option value="weekly">Weekly</option>
                <option value="general">General</option>
                <option value="impromptu">Impromptu</option>
              </select>
              {errors.scriptCategory && (
                <p
                  id={`${scriptCategoryId}-err`}
                  className="hna-input-error"
                >
                  {errors.scriptCategory}
                </p>
              )}
            </div>

            <div className="hna-field">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                <label>Script</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => setScriptPickerOpen(true)}
                    style={scriptToolbarBtnStyle}
                  >
                    Use saved script…
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveAsScript()}
                    style={scriptToolbarBtnStyle}
                  >
                    Save as saved script
                  </button>
                  <button
                    type="button"
                    onClick={() => setScriptImportOpen(true)}
                    style={scriptToolbarBtnStyle}
                  >
                    Import…
                  </button>
                </div>
              </div>
              {(loadedScriptTitle || saveScriptStatus) && (
                <div
                  style={{
                    fontSize: 12,
                    opacity: 0.75,
                    margin: '4px 0 6px',
                  }}
                >
                  {loadedScriptTitle && (
                    <span data-testid="loaded-script-title">
                      Loaded from saved script: <strong>{loadedScriptTitle}</strong>
                    </span>
                  )}
                  {loadedScriptTitle && saveScriptStatus && <span> · </span>}
                  {saveScriptStatus && (
                    <span data-testid="save-script-status">{saveScriptStatus}</span>
                  )}
                </div>
              )}
              <ScriptEditor
                value={data.scriptMd ?? ''}
                onChange={(md) => setData({ ...data, scriptMd: md })}
              />
            </div>
          </div>
          <div className="hna-modal-actions">
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
      <ScriptImportModal
        open={scriptImportOpen}
        onClose={() => setScriptImportOpen(false)}
        onImport={(md, mode) => {
          const current = data.scriptMd ?? '';
          const next =
            mode === 'replace'
              ? md
              : current
                ? `${current}\n\n${md}`
                : md;
          setData({ ...data, scriptMd: next });
        }}
      />
      <ScriptLibraryPicker
        open={scriptPickerOpen}
        onClose={() => setScriptPickerOpen(false)}
        onPick={applySavedScript}
        preferredCategory={data.scriptCategory ?? 'general'}
      />
      <ConfirmModal
        open={pendingReplaceScript !== null}
        title="Replace script"
        message={
          pendingReplaceScript
            ? `Replace the current script with "${pendingReplaceScript.title}"? This cannot be undone.`
            : ''
        }
        confirmLabel="Replace"
        onConfirm={confirmReplaceScript}
        onClose={() => setPendingReplaceScript(null)}
      />
    </>
  );
}

const scriptToolbarBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  padding: '2px 8px',
  cursor: 'pointer',
  color: 'var(--color-fg)',
  fontSize: 12,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  fontWeight: 600,
};

interface ReminderEditorProps {
  value: readonly number[];
  onChange: (next: number[]) => void;
}

/**
 * Compact editor for a net's reminder lead times (minutes-before-start).
 * Renders the current chips, lets the user toggle preset chips on/off, and
 * provides a custom-minutes input for one-off values.
 */
function ReminderMinutesEditor({ value, onChange }: ReminderEditorProps) {
  const [custom, setCustom] = useState('');
  const sorted = [...value].sort((a, b) => b - a);

  function remove(min: number): void {
    onChange(value.filter((m) => m !== min));
  }
  function add(min: number): void {
    if (!Number.isFinite(min) || min <= 0) return;
    const floored = Math.floor(min);
    if (value.includes(floored)) return;
    if (value.length >= 10) return;
    const next = [...value, floored].sort((a, b) => b - a);
    onChange(next);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        aria-label="Current reminders"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minHeight: 28 }}
      >
        {sorted.length === 0 && (
          <span style={{ fontSize: 12, opacity: 0.7, fontStyle: 'italic' }}>
            No reminders for this net.
          </span>
        )}
        {sorted.map((m) => (
          <span
            key={m}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 8px',
              borderRadius: 12,
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg-elev)',
              fontSize: 13,
            }}
          >
            {formatReminderLead(m)}
            <button
              type="button"
              aria-label={`Remove ${formatReminderLead(m)} reminder`}
              onClick={() => remove(m)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--color-danger)',
                cursor: 'pointer',
                fontSize: 14,
                padding: 0,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {REMINDER_PRESETS.map((p) => {
          const active = value.includes(p.minutes);
          return (
            <button
              key={p.minutes}
              type="button"
              onClick={() => (active ? remove(p.minutes) : add(p.minutes))}
              style={{
                padding: '4px 10px',
                borderRadius: 4,
                border: '1px solid var(--color-border)',
                background: active
                  ? 'var(--color-accent, #5b8def)'
                  : 'transparent',
                color: active ? '#fff' : 'inherit',
                cursor: 'pointer',
                fontSize: 12,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                fontWeight: 600,
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Custom minutes"
          aria-label="Custom reminder minutes"
          style={{ maxWidth: 160 }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const n = Number(custom);
              if (Number.isFinite(n) && n > 0) {
                add(n);
                setCustom('');
              }
            }
          }}
        />
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            const n = Number(custom);
            if (Number.isFinite(n) && n > 0) {
              add(n);
              setCustom('');
            }
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

function formatReminderLead(minutes: number): string {
  if (minutes <= 0) return '0m';
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days}d`;
  }
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins === 0 ? `${hours}h` : `${hours}h${mins}m`;
  }
  return `${minutes}m`;
}
