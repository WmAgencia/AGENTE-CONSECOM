import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_VIDEO_BYTES, validateVideoSize } from '../services/media.limits.js';

test('vídeo abaixo de 100 MB é aceito', () => {
  assert.equal(validateVideoSize(MAX_VIDEO_BYTES - 1, 'video/mp4'), null);
});

test('vídeo exatamente em 100 MB é aceito', () => {
  assert.equal(validateVideoSize(MAX_VIDEO_BYTES, 'video/mp4'), null);
});

test('vídeo acima de 100 MB é rejeitado', () => {
  assert.match(validateVideoSize(MAX_VIDEO_BYTES + 1, 'video/mp4') ?? '', /100 MB/);
});

test('o limite de vídeo não altera outros tipos de arquivo', () => {
  assert.equal(validateVideoSize(MAX_VIDEO_BYTES + 1, 'image/jpeg'), null);
  assert.equal(validateVideoSize(MAX_VIDEO_BYTES + 1, 'application/pdf'), null);
});
