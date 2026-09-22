/**
 * Pure markup, split out from the async page so it can be unit-rendered with
 * `react-dom/server`'s `renderToStaticMarkup` (tests/unit/login-form.test.tsx) without pulling
 * in the server-only CSRF helper. No client interactivity: this is a plain HTML form that
 * degrades to nothing (a normal POST to /api/login), matching the CSP's no-inline-script rule
 * and R-G's "page-driven, not JS-driven" reading.
 */
export function LoginForm({ csrf, email }: { csrf: string; email: string }) {
  return (
    <form method="post" action="/api/login" noValidate>
      <input type="hidden" name="csrf" value={csrf} />

      <div className="field-row">
        <label htmlFor="login-email" className="field-label">
          Email address
        </label>
        <input
          id="login-email"
          className="field"
          type="email"
          name="email"
          autoComplete="username"
          required
          maxLength={254}
          defaultValue={email}
        />
      </div>

      <div className="field-row">
        <label htmlFor="login-password" className="field-label">
          Password
        </label>
        <input
          id="login-password"
          className="field"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          minLength={15}
          maxLength={128}
        />
      </div>

      <button type="submit" className="btn btn--primary w-full">
        Sign in
      </button>
    </form>
  );
}
