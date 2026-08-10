# echomirror

Bun CLI for mirroring EchoVideo/Echo360 recordings from every enrolled course, or a selected course.

## Authentication

Echo360 authentication is read from `./cookies` in the current working directory. The file contains the raw value of the `Cookie` request header; do not include the literal `Cookie:` prefix.

To obtain it, login to Echo360, open DevTools -> Network, reload the page, select an Echo360 request, and copy the complete `Cookie` request-header value. Save it as `./cookies` or pass it once with:

```sh
bun run echomirror.ts --token 'PASTE_COOKIE_VALUE'
```

`--token` validates the supplied cookie and stores it in `./cookies` for later runs. Cached cookies are validated again on restore. If an embedded CloudFront policy or `ECHO_JWT` expiry is already past, echomirror stops before making requests and asks for a fresh cookie. Lesson-page `Set-Cookie` values are merged automatically before HLS requests, and retries reload the lesson page so refreshed media authorization can be picked up.

## CLI

```sh
bun run echomirror.ts --help
bun run echomirror.ts --list
bun run echomirror.ts --course 2026_1:comp4403
bun run echomirror.ts --course comp4403
bun run echomirror.ts --all
```

`--list` prints stable course IDs. A plain course code can be passed to `--course` when that code appears in only one enrolled term; otherwise use the full ID printed by `--list`.

## Destination templates

Default:

```text
~/Downloads/Docs/uq/{year_sem}/{course}/recordings/{week}_{lecnum}_{lecname}.mp4
```

Example override:

```sh
bun run echomirror.ts --all \
  --dest '~/Downloads/Docs/uq/{year}/{course}/recording/{week}_{lecnum}_{lecname}'
```

If the rendered filename has no extension, `.mp4` is appended.

Supported fields:

- `{year}` — `2026`
- `{semester}` — `1`
- `{year_sem}` — `2026_1`
- `{course}` — `comp4403`
- `{week}` — zero-padded week, e.g. `01`
- `{lecnum}` — zero-padded lecture number within that week, e.g. `02`
- `{lecname}` — sanitized lecture title
- `{id}` — Echo360 lesson ID

Relative templates are resolved from the current working directory. `~` is expanded to the current user's home directory.

## Ledger and renames

A `.ledger.json` is written at the static root of the destination template. With the default template this is:

```text
~/Downloads/Docs/uq/.ledger.json
```

The file is deliberately a simple map from rendered recording path to Echo lesson ID:

```json
{
  "2026_1/comp4403/recordings/01_01_introduction.mp4": "0f00-example-lesson-id"
}
```

On each run, echomirror finds a lesson ID in the ledger before downloading. If the same ID exists at an old rendered path, it renames/moves that file to the new template path and updates the ledger instead of downloading it again. Existing files at the desired path are adopted into the ledger. Template collisions between two different lesson IDs are rejected rather than overwriting a recording.

The ledger root is the longest directory prefix before the first template field. Keep that static root the same if you want a new template to reuse/rename files recorded by the old template.

## Concurrency

`ECHO_CONCURRENCY` controls recording-level concurrency (default `6`). `ECHO_HTTP_CONCURRENCY` is a global cap on Echo media HTTP requests and defaults to twice the recording concurrency (so `12` with the default settings). `ECHO_SEGMENT_CONCURRENCY` controls the number of workers inside one HLS stream (default `8`), but those workers still pass through the global HTTP cap. Streams within one recording are cached sequentially to avoid multiplying audio/video/subtitle fan-out.

## Development checks

```sh
npm run typecheck
npm test
npm run build
```

The source is written to run directly under Bun as `bun run echomirror.ts`; the TypeScript build also emits `dist/echomirror.js` for Node-compatible regression testing.


## Recovery behavior

If Echo returns a media `403`, echomirror treats it as a retryable media-authorization failure. A retry rebuilds the lesson task from the Echo lesson page instead of reusing stale HLS URLs/cookies. Compact UQ labels such as `COMP2701_S1_2026_STLUCIA_22477_IN_01` are also recognized for course/term metadata; when an enrollment omits term metadata entirely, the year/semester is inferred from the recording dates. Default section capture labels are not used as `{lecname}`.

## Skip reporting and terminal output

Interactive runs use a single transient status line instead of a multi-line cursor-rewriting display. Permanent messages clear and redraw that line, so warnings and errors do not become interleaved with progress output.

Every skipped recording is printed with its reason, for example:

```text
SKIP 2026_1/comp2701/recordings/03_01_lecture.mp4 — Echo player reports no downloadable video for this lesson
SKIP 2026_1/comp2701/recordings/04_01_parsing.mp4 — destination already exists
```

A player lesson that has no downloadable media is distinct from an already-present destination in the final summary.
