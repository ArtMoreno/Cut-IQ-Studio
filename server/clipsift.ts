// URL normalization + video metadata helpers for Cut IQ.

export function extractVideoId(rawUrl: string): string | null {
  const input = rawUrl.trim();
  // Bare 11-char ID
  if (/^[\w-]{11}$/.test(input)) return input;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return /^[\w-]{11}$/.test(id) ? id : null;
  }
  if (["youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)) {
    const v = url.searchParams.get("v");
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const m = url.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/);
    if (m) return m[2];
  }
  return null;
}

export interface VideoMeta {
  title: string | null;
  channel: string | null;
  thumbnail: string | null;
}

export async function fetchVideoMeta(videoId: string): Promise<VideoMeta> {
  const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) throw new Error(`oEmbed ${res.status}`);
    const data = (await res.json()) as { title?: string; author_name?: string };
    return { title: data.title ?? null, channel: data.author_name ?? null, thumbnail };
  } catch {
    // Metadata is best-effort; playback/transcript must still work.
    return { title: null, channel: null, thumbnail };
  }
}
