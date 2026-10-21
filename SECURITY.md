# Security

## Reporting a problem

Please do not open a public issue for a security problem. Report it privately through GitHub's
"Report a vulnerability" button on the Security tab of this repository. You will get a reply within a week.

## How the plugin handles keys

- Keys are read from `ai.env` or real environment variables, only in the Cypress Node process. They never reach the browser.
- Keys and account ids are replaced with `[redacted]` in results files, HTML reports, recordings and error messages.
- Recordings store the model name, the prompt and the answer, never request URLs or headers.
