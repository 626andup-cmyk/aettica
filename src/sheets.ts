/**
 * Turning a plain-text character sheet into notebook fields.
 *
 * Until stage 4, each channel had one character sheet: free text like
 *
 *   Name: Ilse Marrow
 *   Age: 34
 *   Appearance: Tall and wind-weathered, with salt-stiff dark hair
 *   usually tied back with twine.
 *
 * The notebook stores characters as labelled fields instead. This reads a
 * sheet line by line: a line starting with a short label and a colon starts
 * a new field, and any other line continues the field before it. Text
 * before the first label, or straight after the one-line `Name:`, becomes
 * a "Notes" field, so nothing is lost.
 */

import type { EntryField } from "./types.ts";

/** A label: letters, digits, spaces and a few symbols, up to 30 characters, then a colon. */
const LABELLED_LINE = /^\s*([A-Za-z][\w '&/()-]{0,29}?)\s*:\s*(.*)$/;

/**
 * Read a sheet into fields. A `Name:` field is taken out and returned as
 * `name`, since an entry's name has its own place.
 */
export function parseSheet(sheet: string): { name: string | null; fields: EntryField[] } {
  const fields: EntryField[] = [];
  let current: EntryField | null = null;

  for (const line of sheet.split("\n")) {
    const match = line.match(LABELLED_LINE);
    if (match) {
      current = { label: match[1]!.trim(), value: match[2]!.trim() };
      fields.push(current);
    } else if (current && current.label.toLowerCase() !== "name") {
      current.value = current.value === "" ? line.trim() : `${current.value}\n${line.trim()}`;
    } else if (line.trim() !== "") {
      // Text before the first label, or after a name (which is one line),
      // goes in a Notes field.
      current = { label: "Notes", value: line.trim() };
      fields.push(current);
    }
  }

  // Blank lines inside a field become paragraph breaks; trailing ones go.
  for (const field of fields) field.value = field.value.replace(/\n{3,}/g, "\n\n").trim();

  const nameIndex = fields.findIndex((f) => f.label.toLowerCase() === "name");
  const name = nameIndex >= 0 ? fields.splice(nameIndex, 1)[0]!.value || null : null;
  return { name, fields: fields.filter((f) => f.value !== "") };
}
