# video-blog-mcp

MCP server (stdio): **video in — blog post out**. No external
dependencies — just Node.js, `yt-dlp`, `ffmpeg` and a DeepInfra key.

There's a single chain: `yt-dlp` downloads the audio and metadata → Whisper transcribes →
DeepSeek rewrites the transcript into a post with a title and sections. Next to the post
there are always a transcript (with timecodes) and the metadata.

## Tools (4)

| Tool | What it does |
|---|---|
| `video_to_blog` | **the main one**: video link → a ready Markdown post, transcript and metadata |
| `video_transcribe` | transcription only: a link or a local file → text with timecodes |
| `blog_from_transcript` | the reverse: a ready transcript (as text or a file) → a post, without transcription |
| `blog_status` | whether the key is present, whether the binaries are downloaded, where the files will go; `install: true` downloads `yt-dlp` and `ffmpeg` in advance |

The transport is stdio only. There's deliberately no HTTP mode: the server works inside
the agent container, next to the keys and working folders, and there's nothing to expose
externally.

## Configuration

The key is the same one Icarus itself runs on: `DEEPINFRA_API_KEY` is already in the
container's environment, no separate one needed (you can override it with your own
`VIDEO_BLOG_API_KEY`).

| Variable | Meaning | Default |
|---|---|---|
| `DEEPINFRA_API_KEY` | DeepInfra key (or `VIDEO_BLOG_API_KEY`) | — |
| `VIDEO_BLOG_BASE_URL` | API address, OpenAI-compatible | `https://api.deepinfra.com/v1/openai` |
| `VIDEO_BLOG_ASR_MODEL` | transcription model | `openai/whisper-large-v3-turbo` |
| `VIDEO_BLOG_LLM_MODEL` | editor model | `deepseek-ai/DeepSeek-V4.1-Flash` |
| `VIDEO_BLOG_HOME` | cache of binaries and working directories | `<ICARUS_HOME>/tools/video-blog` |
| `VIDEO_BLOG_OUT_DIR` | result folder (can be set in the call) | `<working folder>/video-blog` |
| `VIDEO_BLOG_MAX_MINUTES` | duration ceiling | 240 |
| `VIDEO_BLOG_MAX_UPLOAD_MB` | above this size audio is split into parts | 24 |
| `VIDEO_BLOG_SPLIT_SECONDS` | part length when splitting | 900 |
| `VIDEO_BLOG_YTDLP`, `VIDEO_BLOG_FFMPEG` | ready-made binaries instead of downloading | — |

### In the Icarus panel — via a recipe

**panel → MCP → Recipes → "Video to blog post" → "Add"**. The recipe doesn't
ask for keys: it runs on the same DeepInfra key as Icarus itself. The server
arrives lazy (`lifecycle: lazy`), turned on for yourself with a single toggle.

### Where the server lives

The code is mounted into the agent container from the repository: `tools/video-blog-mcp` →
`/opt/icarus/tools/video-blog-mcp` (read-only). The binaries don't sit next to the code:
they're downloaded into `VIDEO_BLOG_HOME`, that is, into the service directory
`/workspaces/.icarus/tools/video-blog` — recreating the container doesn't wipe them.
`yt-dlp` is a static build from GitHub releases, `ffmpeg` — only when the audio
doesn't fit within the upload limit; **for short videos ffmpeg isn't needed at all**, because
Whisper accepts the raw audio stream (m4a/opus) as is.

## What it costs

Whisper on DeepInfra is `$0.0002` per minute of audio, the editor — fractions of a cent. A five-minute
video costs about **$0.002**; the server prints an estimate at the end of every run.

## Gotchas

- A link to a playlist or a search results page — a refusal before downloading, not the first clip
  from who knows where.
- An empty transcription is an error, not an empty file: it means there's no speech in the recording.
- A transcript longer than ~45 thousand characters goes through map-reduce (compression in parts,
  then assembling the post) — so an hour-long conversation doesn't blow the context.
- Audio larger than the limit is split by `ffmpeg` into 15-minute parts; timecodes are glued
  with an offset, not restarted in each part.
- The post is a retelling. For quotations you need the `.transcript.txt` next to it: that's where the speaker's words are.

## Verification

```bash
node tools/video-blog-mcp/test.mjs      # 10 checks: yt-dlp/ffmpeg/DeepInfra stubs, no network
```

A scenario over the real stdio protocol lives in
`packages/service/test/video-blog-mcp.test.ts` and is run by `./script/test`.
