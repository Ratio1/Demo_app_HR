/**
 * Pure markup (see the login form's own comment for why). Plain HTML, no client script: a
 * normal POST to /api/password. Passwords are never pre-filled after a failed submit —
 * flows.md S2 clears all three fields on `invalid`, which this form already does by simply
 * never rendering a `defaultValue` for a password input.
 */
export function ChangePasswordForm({ csrf }: { csrf: string }) {
  return (
    <form method="post" action="/api/password">
      <input type="hidden" name="csrf" value={csrf} />

      <div className="field-row">
        <label htmlFor="current-password" className="field-label">
          Current password
        </label>
        <input
          id="current-password"
          className="field"
          type="password"
          name="current_password"
          autoComplete="current-password"
          required
          minLength={15}
          maxLength={128}
        />
      </div>

      <div className="field-row">
        <label htmlFor="new-password" className="field-label">
          New password
        </label>
        <input
          id="new-password"
          className="field"
          type="password"
          name="new_password"
          autoComplete="new-password"
          required
          minLength={15}
          maxLength={128}
          aria-describedby="new-password-hint"
        />
        <p id="new-password-hint" className="field__hint">
          15 to 128 characters. Not a commonly used password.
        </p>
      </div>

      <button type="submit" className="btn btn--primary">
        Change password
      </button>
    </form>
  );
}
