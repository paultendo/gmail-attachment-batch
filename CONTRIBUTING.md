# Contributing

Small, focused contributions are welcome: reproducible bug reports, clearer instructions, Gmail compatibility fixes and improvements to the review table. Open an issue before starting a larger feature so we can agree its scope.

## Get running

1. Install Node.js and Python 3 (used only for packaging).
2. Run `npm ci --ignore-scripts`, then `npm test`.
3. Open `demo.html` for fictional mail and simulated downloads.
4. For a live check, install `gmail-attachment-batch.user.js` in Tampermonkey and use a small search with known attachments.

Implementation details and test coverage are described in [technical notes](docs/TECHNICAL.md).

## Before a pull request

- Keep the change focused and explain what users will notice.
- Run `npm test` and `npm run build`. Update the docs if the workflow changes.
- For UI changes, check the demo and include a screenshot using fictional mail.
- For download/capture changes, test the affected behaviour, including failure and stop outcomes where relevant. Distinguish synthetic tests from checks in a real Gmail account.
- Preserve the author credit and legal notices in the source and Help/About, following [ATTRIBUTION.md](ATTRIBUTION.md). You can add your own contribution credit too.
- Use fictional fixtures. Do not submit email content, attachments, signed download URLs or private CSV reports.

## Review and approval

Paul Wood FRSA maintains the official project and decides which contributions are accepted, merged and released. Every contribution is subject to his review and approval. Submitting an issue or pull request does not guarantee acceptance or grant merge or release permissions. A contribution may be declined or sent back for changes.

The licence terms below let us review and, if approved, include your work without separate paperwork. They do not replace maintainer approval. Contributors retain copyright in their contributions; acceptance does not transfer ownership.

## Licence and credit

By intentionally submitting a contribution for inclusion, you agree to license it under **GPL-3.0-only**, subject to the project's [section 7(b) attribution notice](ATTRIBUTION.md). You keep copyright in your work. No copyright transfer, CLA or separate sign-up is required. Only submit work you are entitled to contribute, and retain any applicable third-party notices.

Keep “Paul Wood FRSA (paultendo on GitHub)” and the profile link in the source and Help/About legal notices. Your own author credits are welcome. If you distribute a modified covered version, provide its corresponding source to recipients under GPLv3. Private changes do not need to be published; a public GitHub repository is not required. The full terms are in [LICENSE](LICENSE) and [ATTRIBUTION.md](ATTRIBUTION.md).

Contributors are recognised through pull requests and commit history. You may also add your preferred public name/profile and a short description to [CONTRIBUTORS.md](CONTRIBUTORS.md). Credit additional work accurately; do not imply endorsement by the original author.
