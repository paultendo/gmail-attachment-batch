# Technical notes

## Gmail integration

The userscript reads Gmail's page rather than using the Gmail API. It captures conversation IDs from the search results and opens each selected conversation to find its attachments. Capturing all pages checks Gmail's pagination controls and verifies each page before adding its results. An incomplete capture cannot be downloaded.

The captured list fixes which conversations will be processed. Messages and attachments are inspected when each conversation opens. Every supported attachment in that conversation is included, even if its message does not independently match the original search. Google documents [conversation view](https://support.google.com/mail/answer/5900?hl=en) and [differences between Gmail UI and API searches](https://developers.google.com/workspace/gmail/api/guides/filtering).

The script recognises Gmail's English **Older** and **Expand all** controls and attachment `download_url` attributes. It expands recognised controls, but hidden messages, additional “show more” controls, unusual message formats and delayed content may need manual checking. `no_visible_attachments` means no supported attachment tiles were found, not proof that a message contains no files.

The attachment DOM convention was checked against the [Gmail.js source](https://github.com/KartikTalwar/gmail.js/blob/master/src/gmail.js). Gmail.js is not a dependency. The installed script has no third-party runtime dependencies and does not load remote executable dependencies. Tampermonkey's update metadata points to the public repository.

## Downloads and reports

Downloads use `GM_download` sequentially. A file is recorded as saved only after Tampermonkey calls `onload`; this does not independently verify its contents or final filename on disk. Chrome or Tampermonkey may change a filename.

The script accepts the two listed Google attachment hosts and checks the Gmail account in download URLs. Drive links are reported separately. Files linked in message bodies, SharePoint links and embedded body images are not downloaded.

Folder and file names are sanitised for Windows and macOS and limited by UTF-8 byte length. Conversation folders include a stable ID, and attachment filenames are numbered to avoid collisions within a conversation.

**Pause** finishes the current file before waiting. **Stop now** attempts to abort an active request. A timeout or uncertain cancellation is recorded as **unknown** and is not automatically retried. Check Chrome Downloads before retrying these files.

Download history, the queue and the report are held in the Gmail tab's memory. They are cleared by reloading, closing the tab or capturing a new batch. Repeating the same batch skips its confirmed saved files; there is no persistent resume or cross-batch deduplication.

The CSV records the search, conversation and attachment details, requested paths and outcomes. It excludes signed attachment URLs and escapes spreadsheet formula prefixes. It does not include email bodies or attachment bytes.

## Testing

The automated suite uses synthetic Gmail DOM fixtures. It covers capture and pagination, routing and account checks, attachment identity, path handling, CSV escaping, download callbacks and uncertain outcomes, repeat-run behaviour, Trusted Types, toolbar alignment, setup checks and Help navigation.

Live checks in one English-language desktop Chrome Gmail account included:

- Capturing 567 conversations across 12 pages.
- Downloading two known PDFs into separate conversation folders, checking their PDF signatures and matching report paths against saved files.
- Matching one test PDF to an existing original by SHA-256.
- Repeating the same batch without creating duplicate PDFs.
- Saving the setup-check file and checking its contents on disk.
- Opening the public install URL in Tampermonkey and installing v0.4.5.

These checks cover one account, not every Gmail layout or message format. The aggregate record is in [verification.json](../verification.json). Private mail, reports and detailed local test records are excluded from the repository and release ZIP.

## Development

Node.js is needed for tests; Python 3 is also needed to build the ZIP.

```sh
npm ci --ignore-scripts
npm test
npm run build
```

Open `demo.html` for fictional mail and simulated downloads. It does not connect to Gmail or test real download permissions.

The build embeds the exact userscript in `install.html`, updates its SHA-256 in `verification.json` and creates the source ZIP from an explicit file list. See [PUBLISHING.md](../PUBLISHING.md) for releases and [CONTRIBUTING.md](../CONTRIBUTING.md) for contributions.
