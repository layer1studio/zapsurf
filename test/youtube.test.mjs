import test from 'node:test';
import assert from 'node:assert/strict';
import { youtubeEmbedUrl } from '../js/youtube.mjs';

test('embeds YouTube watch, short, shorts, live, and embed links on the privacy-enhanced host', () => {
  for (const href of [
    'https://www.youtube.com/watch?v=vRsXcE7bfN0',
    'https://youtube.com/watch?si=shared&v=vRsXcE7bfN0',
    'https://m.youtube.com/watch?v=vRsXcE7bfN0',
    'https://music.youtube.com/watch?v=vRsXcE7bfN0',
    'https://youtu.be/vRsXcE7bfN0?si=shared',
    'https://www.youtube.com/shorts/vRsXcE7bfN0',
    'https://www.youtube.com/live/vRsXcE7bfN0',
    'https://www.youtube.com/embed/vRsXcE7bfN0',
    'https://www.youtube-nocookie.com/embed/vRsXcE7bfN0'
  ]) {
    assert.equal(youtubeEmbedUrl(href), 'https://www.youtube-nocookie.com/embed/vRsXcE7bfN0', href);
  }
});

test('leaves unrelated links, non-video pages, malformed IDs, and spoofed hosts alone', () => {
  for (const href of [
    'not a URL',
    'https://example.com/watch?v=vRsXcE7bfN0',
    'https://youtube.com.evil.example/watch?v=vRsXcE7bfN0',
    'https://evilyoutube.com/watch?v=vRsXcE7bfN0',
    'https://user:password@youtube.com/watch?v=vRsXcE7bfN0',
    'ftp://youtube.com/watch?v=vRsXcE7bfN0',
    'https://youtube.com/playlist?list=example',
    'https://youtube.com/@channel',
    'https://youtube.com/watch',
    'https://youtu.be/too-short',
    'https://youtu.be/vRsXcE7bfN0/extra',
    'https://youtube.com/watch?v=vRsXcE7bfN0%22'
  ]) {
    assert.equal(youtubeEmbedUrl(href), null, href);
  }
});