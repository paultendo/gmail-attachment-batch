# Release checklist

Public repository: https://github.com/paultendo/gmail-attachment-batch

Licence: GPL-3.0-only, with the section 7(b) author-attribution term in `ATTRIBUTION.md`.

1. Keep changes focused. Update the userscript version, Help version, package version and verification notes when releasing.
2. Run `npm ci --ignore-scripts`, `npm test`, then `npm run build`. The build refreshes the offline installer, script hash and source ZIP. Node.js and Python 3 are required.
3. Inspect the public files enumerated by `scripts/package.mjs`. Never include `node_modules`, downloaded attachments, CSV reports, real-mail screenshots or `verification.private.json`. Screenshots must show fictional mail or cropped controls without email content.
4. Commit the corresponding source, unchanged GPL text and attribution notice. Check the installer embeds the exact userscript and that `verification.json` matches its SHA-256.
5. Push the reviewed source and tag the matching release. Attach `gmail-attachment-batch-prototype.zip` and checksums to the GitHub release.
6. Verify the public raw install URL, README images, Help repository/Issues links and release download. Test changes against a small known-result Gmail search where relevant; distinguish local fixtures from live checks.

The userscript's homepage, support, update and download metadata point to this repository. Tampermonkey controls update checks; users can also reinstall from the README link. Only publish reviewed code to the default branch because it is the userscript's update source.

The public verification file contains aggregate checks only. Detailed local records are ignored and excluded from the package.
