export function youtubeEmbedUrl(href) {
  try {
    const url = new URL(href);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    let videoId;
    if (host === 'youtu.be') {
      videoId = url.pathname.slice(1);
    } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
      if (url.pathname === '/watch') videoId = url.searchParams.get('v');
      else videoId = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)\/?$/)?.[1];
    }
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) return null;
    return `https://www.youtube-nocookie.com/embed/${videoId}`;
  } catch {
    return null;
  }
}