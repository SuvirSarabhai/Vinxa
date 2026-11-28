# Privacy and consent

28 November 2026. This describes application behavior; it is not a legal opinion
or a claim of completed release acceptance testing.

Vinxa records only after the user confirms consent in the setup window. The
announcement is available to copy; the user is responsible for informing other
participants and obtaining their permission. A local consent receipt records
time, statement version, mode, chosen sources and whether the announcement was
copied. Copying an announcement is not proof another participant agreed.

Microphone audio can include nearby household speech. Muting a microphone in
Teams, Zoom or Meet does not mute Vinxa. Use Vinxa Pause or Stop. The tray and
overlay show recording state. Closing or minimizing the overlay does not stop
recording. Optional call-window detection shows an offer only: clicking it opens
the existing consent flow. Window titles are inspected in memory, not logged or
stored; detection is approximate and browser calls remain manual.

Transcription and optional remote speaker clustering run locally. Clustering
does not identify people: labels are estimates scoped to a meeting. Uncertain
or mixed passages keep the Remote fallback. Model files must already be local;
no automatic download takes place. Microphone speech is not remotely clustered.

Local notes use an installed Ollama model. Cloud notes require the existing
explicit provider selection and transcript-sharing opt-in. OpenAI receives text,
not audio. API keys use Windows-backed Electron safeStorage. Ask Vinxa performs
local retrieval of saved transcript excerpts and does not send questions or
transcripts to a cloud model.

The mock CRM is a separate local demo service. A user-initiated, confirmed send
contains the meeting ID, chosen CRM record ID, decisions and actions (including
owners/due dates). It excludes transcript and audio. The supplied mock server
holds only hashes for retry deduplication in memory and does not log payloads.
Closing the server loses these hashes. A successful acknowledgement is recorded
in the meeting database; unknown delivery outcomes are marked failed, never sent.

Meeting text, notes, speaker labels, bookmarks and CRM delivery metadata are
stored in the profile database. WAVs, consent receipts and settings are also
local profile data. Without optional EFS, meeting contents are not encrypted by
Vinxa; API-key encryption alone does not encrypt meetings.

Optional Windows EFS protects files on a supported Windows/NTFS configuration.
The profile directory is marked for encryption so future files inherit it.
Conversion and verification happen before files are opened on a subsequent
launch. Failure preserves files and reports that conversion was incomplete.
Status is verified from actual current attributes, not a saved success flag.
EFS cannot protect files from a process running as the same logged-in user.
Back up the EFS certificate/private key using Windows `cipher /x`; losing the
Windows encryption key can make recordings unrecoverable. Exported copies,
previous plaintext backups and cloud-shared text are outside this protection.

Deleting a meeting removes its managed files, consent receipt, transcript, notes,
search entries, bookmarks, clustering labels and CRM delivery metadata. Exported
copies outside the managed folder and data already sent to another service are
not recalled. Overwriting cannot guarantee physical erasure on SSDs, backups or
synced storage. Diagnostics and application error messages should not contain
transcript content, raw model responses, tokens or CRM payloads.

Implementation references: [Microsoft EFS documentation](https://learn.microsoft.com/en-us/windows/win32/fileio/file-encryption)
and [Sherpa ONNX speaker diarization documentation](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/python.html).
