/**
 * Errors with a meaning the server understands, so it can answer with the
 * right status (see the error handling in `src/server.ts`).
 */

/** Thrown when something is looked up by an id that doesn't exist. */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`That ${what} doesn't exist.`);
    this.name = "NotFoundError";
  }
}

/**
 * Thrown when a request contains invalid data, or asks for something that
 * doesn't make sense: a missing name, a temperature out of range. The
 * message says what's wrong and is shown to you.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Thrown when someone asks for something the notebook's permissions don't
 * allow them: changing an entry that's locked to them, hiding an entry that
 * isn't theirs, accepting their own suggestion.
 */
export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}
