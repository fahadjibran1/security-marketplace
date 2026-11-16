/**
 * S4 Guard Profile — unsaved sensitive edits (Profile Phase 2D).
 *
 * Leaving a Profile section closes any open edit of a masked value and discards what was typed (Phase 2C, so a
 * half-typed NINO or account number never lingers off screen). Phase 2D asks first when something has actually been
 * typed: "Discard unsaved changes?" with Keep editing / Discard. An editor that is open but empty leaves silently, as
 * before. The Emergency controls never pass through this: they do not navigate between Profile sections.
 *
 * Pure: executed by scripts/guard-profile-foundations.spec.cjs.
 */

export interface SensitiveEditorState {
  editing: boolean;
  /** Every input of that editor (the bank editor has three). */
  inputs: ReadonlyArray<string | null | undefined>;
}

export interface SensitiveEditors {
  nino: SensitiveEditorState;
  utr: SensitiveEditorState;
  drivingLicence: SensitiveEditorState;
  bank: SensitiveEditorState;
}

/** True when an editor of a masked value is open AND something other than spaces has been typed into it. */
export function hasUnsavedSensitiveEdit(editors: SensitiveEditors): boolean {
  const all: SensitiveEditorState[] = [editors.nino, editors.utr, editors.drivingLicence, editors.bank];
  return all.some((editor) => editor.editing && editor.inputs.some((value: string | null | undefined) => String(value ?? '').trim() !== ''));
}

export const UNSAVED_EDIT_COPY = {
  title: 'Discard unsaved changes?',
  message: 'What you have typed has not been saved. If you leave now, it will be discarded.',
  keep: 'Keep editing',
  discard: 'Discard',
} as const;
