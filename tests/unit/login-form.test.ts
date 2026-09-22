import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LoginForm } from "../../src/app/login/LoginForm.js";

/**
 * Cheap markup assertions for the /login form (slice 1 part C), run without a browser via
 * `react-dom/server`'s `renderToStaticMarkup` on the pure-markup component split out of the
 * async page (see LoginForm.tsx's own comment). Asserts exactly the contract the slice 1
 * brief fixes: field names `email`/`password`/`csrf`, the login-CSRF value rendered as the
 * hidden field, `autocomplete` per WCAG 2.2 §3.3.8, and every input labelled.
 *
 * Attribute assertions extract the whole `<input …>` tag first and then check for each
 * attribute independently, rather than chaining ordered substrings: React 19's static markup
 * does not preserve JSX prop-declaration order for form elements (verified directly against a
 * bare `renderToStaticMarkup` call, not particular to this component — `name` in particular
 * renders after `autoComplete`/`maxLength`), and HTML attribute order carries no meaning.
 */

function render(props: { csrf: string; email: string }): string {
  return renderToStaticMarkup(createElement(LoginForm, props));
}

function inputTag(html: string, name: string): string {
  const match = html.match(new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`, "i"));
  expect(match, `expected an <input name="${name}"> tag`).not.toBeNull();
  return match?.[0] ?? "";
}

describe("LoginForm markup", () => {
  it("posts to /api/login with the contracted field names and the csrf value", () => {
    const html = render({ csrf: "test-csrf-token-value", email: "" });

    expect(html).toContain('method="post"');
    expect(html).toContain('action="/api/login"');

    const csrfInput = html.match(/<input\b[^>]*type="hidden"[^>]*>/i)?.[0] ?? "";
    expect(csrfInput).toMatch(/name="csrf"/);
    expect(csrfInput).toMatch(/value="test-csrf-token-value"/);

    inputTag(html, "email");
    inputTag(html, "password");
  });

  it("carries the WCAG 2.2 §3.3.8 autocomplete values", () => {
    const html = render({ csrf: "tok", email: "" });

    expect(inputTag(html, "email")).toMatch(/autocomplete="username"/i);
    expect(inputTag(html, "password")).toMatch(/autocomplete="current-password"/i);
  });

  it("preserves a typed email and never pre-fills the password (flows.md S1)", () => {
    const html = render({ csrf: "tok", email: "person@example.test" });

    expect(inputTag(html, "email")).toMatch(/value="person@example\.test"/);
    expect(inputTag(html, "password")).not.toMatch(/value="/);
  });

  it("binds every input to a visible label via htmlFor/id", () => {
    const html = render({ csrf: "tok", email: "" });

    expect(html).toMatch(/<label for="login-email"[^>]*>Email address<\/label>/);
    expect(inputTag(html, "email")).toMatch(/id="login-email"/);
    expect(html).toMatch(/<label for="login-password"[^>]*>Password<\/label>/);
    expect(inputTag(html, "password")).toMatch(/id="login-password"/);
  });
});
