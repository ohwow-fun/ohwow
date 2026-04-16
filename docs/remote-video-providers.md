# Remote video providers

ohwow's video pipeline can splice AI-generated mp4 clips into a
`video-clip` visual layer. Clips are content-addressed and cached, so the
same prompt + seed hits the cache on every re-render.

Clips are **off by default**. Enable them with the `--clips` flag on
`ohwow video workspace`:

```bash
ohwow video workspace --brief="your direction" --clips
ohwow video workspace --clips --clips-provider=fal --clips-max-cost=100
ohwow video workspace --clips --clips-dry-run   # log router decisions, skip API calls
```

When clips are enabled, the storyboard author is allowed to include
`video-clip` layers. When they're disabled, the primitive is hidden from
the LLM and any leftover `video-clip` layers are stripped from the spec
before rendering.

## Providers

Exactly one provider needs to be configured. If multiple are configured,
the router picks the cheapest available.

| Provider         | Env vars required                                            | Priority |
| ---------------- | ------------------------------------------------------------ | -------- |
| `custom-http`    | `OHWOW_VIDEO_HTTP_URL`                                       | 10       |
| `fal`            | `FAL_KEY`                                                    | 20       |
| `replicate`      | `REPLICATE_API_TOKEN`, `REPLICATE_VIDEO_MODEL`               | 25       |
| `openrouter-veo` | `OPENROUTER_API_KEY`                                         | 30       |

Force a specific provider with `--clips-provider=<name>`.

## The custom-http contract (bring your own backend)

The `custom-http` adapter is the public/private bridge. It lets you point
ohwow at any HTTP endpoint (Modal, Fly, a local FastAPI server, whatever)
without shipping backend-specific code.

### Request

```
POST <OHWOW_VIDEO_HTTP_URL>
Content-Type: application/json
<AUTH_HEADER>: [<SCHEME> ]<AUTH_VALUE>

{
  "prompt": "slow dolly over a quiet home office at dawn",
  "duration_seconds": 4,
  "aspect_ratio": "16:9",
  "seed": 0
}
```

Override the body shape with a JSON template if your backend expects
something different:

```bash
export OHWOW_VIDEO_HTTP_PAYLOAD_TEMPLATE='{"input":{"text":"{{prompt}}","length":{{duration}},"seed":{{seed}}}}'
```

Placeholders: `{{prompt}}`, `{{duration}}`, `{{seed}}`, `{{aspect_ratio}}`,
`{{reference_image_url}}`, `{{negative_prompt}}`.

### Response

Two shapes are supported.

**Binary mp4 (preferred, one round trip):**

```
HTTP/1.1 200 OK
Content-Type: video/mp4
X-Cost-Cents: 12       (optional; tracked for cost telemetry)

<mp4 bytes>
```

**JSON with signed URL:**

```json
{
  "url": "https://r2.cloudflare.example/clip-abc.mp4",
  "cost_cents": 12
}
```

The adapter downloads the URL server-side before caching, so short-lived
signed URLs still produce durable cache entries. Customize the JSON paths
with `OHWOW_VIDEO_HTTP_RESPONSE_URL_PATH` / `OHWOW_VIDEO_HTTP_COST_PATH`.

### Auth

`OHWOW_VIDEO_HTTP_AUTH_HEADER` defaults to `Authorization`. When the
header is `Authorization`, the adapter prepends `Bearer ` to the value.
Override the scheme (including disabling it) with
`OHWOW_VIDEO_HTTP_AUTH_SCHEME`. Non-standard headers pass through
unchanged:

```bash
# Example: a Modal endpoint that checks X-Inference-Secret
export OHWOW_VIDEO_HTTP_URL=https://your-app.modal.run/v1/videos
export OHWOW_VIDEO_HTTP_AUTH_HEADER=X-Inference-Secret
export OHWOW_VIDEO_HTTP_AUTH=<secret>
```

## Caching

Successful clips are stored under `~/.ohwow/media/cache/video/<hash>.mp4`
and copied into `packages/video/public/clips/<hash>.mp4` for Remotion's
`staticFile()` to resolve. Cache key inputs include the provider name,
prompt, duration, aspect ratio, seed, and (for custom-http) the endpoint
URL.

Re-running the same brief twice will show `cached: true` in the logs and
skip any API calls.

## Fallback behavior

If no provider is available (no matching env vars) and clips are enabled,
`video-clip` layers are silently dropped from the storyboard and the
scene falls back to whatever other primitives the LLM chose. The engine
never errors out for a missing provider.

## Minimal self-hosted reference

A production example of the custom-http contract looks like:

```python
# FastAPI shim — example only, not part of the OSS repo
@app.post("/v1/videos")
def generate_video(req: VideoRequest) -> Response:
    mp4_bytes = model.generate(
        prompt=req.prompt,
        duration=req.duration_seconds,
        aspect_ratio=req.aspect_ratio,
        seed=req.seed,
    )
    return Response(
        content=mp4_bytes,
        media_type="video/mp4",
        headers={"X-Cost-Cents": str(estimated_cents)},
    )
```

That's it. No ohwow SDK, no specific schema beyond the contract above.
