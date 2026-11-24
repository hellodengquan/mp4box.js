import { createFile, MP4BoxBuffer, type ISOFile, type Sample } from '../entries/all';

/**
 * Multi-track seeking integration tests.
 *
 * A player scrubs a single timeline while feeding an audio track and a video
 * track whose decode order contains B-frame reordering. The two tracks use
 * different media timescales. These tests pin down, independently:
 *
 *  - the sample each track starts decoding from (must be a sync/RAP sample
 *    when `useRap` is set) and the playback time returned for that track;
 *  - the byte offset handed to the network/range layer, including the
 *    adjustment to the end of an already buffered contiguous range;
 *  - the end-to-end caller flow: request the missing bytes at the returned
 *    offset, append them, and extract every remaining sample per track with
 *    intact bytes and timestamps continuous from the returned time.
 *
 * The fixture is a small, fully specified progressive MP4 (ftyp + moov +
 * mdat) generated in memory so that every byte offset and timestamp is known
 * exactly and the tests do not depend on conformance downloads.
 */

/* ------------------------------------------------------------------ */
/* Minimal MP4 byte builder                                            */
/* ------------------------------------------------------------------ */

const concat = (...parts: Array<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const fourCc = (s: string) => {
  const b = new Uint8Array(4);
  for (let i = 0; i < 4; i++) b[i] = s.charCodeAt(i);
  return b;
};
const u8 = (n: number) => new Uint8Array([n & 0xff]);
const u16 = (n: number) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n);
  return b;
};
const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
};
const i32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n | 0);
  return b;
};
const box = (type: string, payload: Uint8Array = new Uint8Array(0)) =>
  concat(u32(8 + payload.length), fourCc(type), payload);
const fullBox = (version: number, flags: number, body: Uint8Array) =>
  concat(u8(version), u8((flags >>> 16) & 0xff), u8((flags >>> 8) & 0xff), u8(flags & 0xff), body);

/* ------------------------------------------------------------------ */
/* Fixture definition                                                  */
/* ------------------------------------------------------------------ */

const AUDIO_ID = 101;
const VIDEO_ID = 201;
const AUDIO_TIMESCALE = 48_000;
const VIDEO_TIMESCALE = 24_000;
const SAMPLE_COUNT = 12;
const AUDIO_DURATION = 4_000; // 12 samples * 4000 / 48000 = 1.0 s
const VIDEO_DURATION = 2_000; // 12 samples * 2000 / 24000 = 1.0 s
const AUDIO_SIZE = 64;
const VIDEO_SIZE = 128;

/**
 * Composition offsets in decode/storage order. Combined with dts = j * 2000
 * they produce a non-monotonic CTS sequence (B-frame reordering):
 *   cts = [0, 4000, 2000, 6000, 8000, 12000, 10000, 14000, ...]
 */
// prettier-ignore
const VIDEO_CTTS_OFFSETS = [0, 2000, -2000, 0, 0, 2000, -2000, 0, 0, 2000, -2000, 0];
/** Sync samples, 1-based: sample 1 (j=0) and sample 7 (j=6). */
const VIDEO_SYNC_NUMBERS = [1, 7];

function samplePayload(marker: number, index: number, size: number): Uint8Array {
  const data = new Uint8Array(size);
  data[0] = marker;
  new DataView(data.buffer).setUint16(1, index);
  for (let i = 4; i < size; i++) data[i] = (index * 31 + i) & 0xff;
  return data;
}

interface MultiTrackFixture {
  bytes: Uint8Array;
  /** Absolute file offset of the first byte of mdat payload. */
  mediaStart: number;
  audioOffsets: Array<number>;
  videoOffsets: Array<number>;
  audioPayloads: Array<Uint8Array>;
  videoPayloads: Array<Uint8Array>;
}

function buildMultiTrackFile(): MultiTrackFixture {
  const ftyp = box(
    'ftyp',
    concat(fourCc('isom'), u32(0), fourCc('isom'), fourCc('iso2'), fourCc('mp41')),
  );

  const mvhd = box(
    'mvhd',
    fullBox(
      0,
      0,
      concat(
        u32(0), // creation
        u32(0), // modification
        u32(1000), // movie timescale
        u32(1000), // duration: 1.0 s
        u32(0x0001_0000), // rate 1.0
        u16(0x0100), // volume 1.0
        u16(0),
        new Uint8Array(8),
        // identity matrix
        u32(0x10000),
        u32(0),
        u32(0),
        u32(0),
        u32(0x10000),
        u32(0),
        u32(0),
        u32(0),
        u32(0x4000_0000),
        new Uint8Array(24), // pre-defined
        u32(3), // next track id
      ),
    ),
  );

  const tkhd = (id: number, volume: number, width: number, height: number) =>
    box(
      'tkhd',
      fullBox(
        0,
        0x7, // enabled | in movie | in preview
        concat(
          u32(0),
          u32(0),
          u32(id),
          u32(0),
          u32(1000), // duration
          new Uint8Array(8),
          u16(0), // layer
          u16(0), // alternate group
          u16(volume),
          u16(0),
          // identity matrix
          u32(0x10000),
          u32(0),
          u32(0),
          u32(0),
          u32(0x10000),
          u32(0),
          u32(0),
          u32(0),
          u32(0x4000_0000),
          u32(width << 16),
          u32(height << 16),
        ),
      ),
    );

  const mdhd = (timescale: number, duration: number) =>
    box(
      'mdhd',
      fullBox(0, 0, concat(u32(0), u32(0), u32(timescale), u32(duration), u16(0), u16(0))),
    );

  const hdlr = (handler: string) =>
    box(
      'hdlr',
      fullBox(0, 0, concat(u32(0), fourCc(handler), new Uint8Array(12), new Uint8Array(1))),
    );

  const dinf = box(
    'dinf',
    box('dref', fullBox(0, 0, concat(u32(1), box('url ', fullBox(0, 1, new Uint8Array(0)))))),
  );

  // 28 bytes reserved/header fields after the 8-byte sample entry header.
  const mp4aEntry = box(
    'mp4a',
    concat(
      new Uint8Array(6),
      u16(1), // data reference index
      u16(0), // version
      u16(0), // revision
      u32(0), // vendor
      u16(2), // channels
      u16(16), // sample size
      u16(0), // compression id
      u16(0), // packet size
      u32(48_000 << 16), // sample rate 16.16
    ),
  );

  // 70 bytes of fixed visual sample entry fields after the 8-byte header.
  const avc1Entry = box(
    'avc1',
    concat(
      new Uint8Array(6),
      u16(1),
      u16(0),
      u16(0),
      u32(0),
      u32(0),
      u32(0),
      u16(320),
      u16(240),
      u32(0x0048_0000),
      u32(0x0048_0000),
      u32(0),
      u16(1),
      new Uint8Array(32), // compressor name
      u16(0x0018), // depth
      u16(0xffff),
    ),
  );

  const stsd = (entry: Uint8Array) => box('stsd', fullBox(0, 0, concat(u32(1), entry)));
  const stts = (delta: number) =>
    box(
      'stts',
      fullBox(
        0,
        0,
        concat(
          u32(SAMPLE_COUNT),
          ...Array.from({ length: SAMPLE_COUNT }, () => concat(u32(1), u32(delta))),
        ),
      ),
    );
  const ctts = (offsets: Array<number>) =>
    box(
      'ctts',
      fullBox(
        1, // version 1: signed composition offsets
        0,
        concat(u32(offsets.length), ...offsets.map(o => concat(u32(1), i32(o)))),
      ),
    );
  const stss = (numbers: Array<number>) =>
    box('stss', fullBox(0, 0, concat(u32(numbers.length), ...numbers.map(u32))));
  const stsc = box('stsc', fullBox(0, 0, concat(u32(1), u32(1), u32(1), u32(1))));
  const stsz = (size: number) =>
    box(
      'stsz',
      fullBox(
        0,
        0,
        concat(
          u32(0), // variable sizes
          u32(SAMPLE_COUNT),
          ...Array.from({ length: SAMPLE_COUNT }, () => u32(size)),
        ),
      ),
    );
  const stco = (offsets: Array<number>) =>
    box('stco', fullBox(0, 0, concat(u32(offsets.length), ...offsets.map(u32))));

  const buildMoov = (audioOffsets: Array<number>, videoOffsets: Array<number>) => {
    const audioStbl = box(
      'stbl',
      concat(stsd(mp4aEntry), stts(AUDIO_DURATION), stsc, stsz(AUDIO_SIZE), stco(audioOffsets)),
    );
    const audioMinf = box(
      'minf',
      concat(box('smhd', fullBox(0, 0, concat(u16(0), u16(0)))), dinf, audioStbl),
    );
    const audioTrak = box(
      'trak',
      concat(
        tkhd(AUDIO_ID, 0x0100, 0, 0),
        box(
          'mdia',
          concat(mdhd(AUDIO_TIMESCALE, SAMPLE_COUNT * AUDIO_DURATION), hdlr('soun'), audioMinf),
        ),
      ),
    );

    const videoStbl = box(
      'stbl',
      concat(
        stsd(avc1Entry),
        stts(VIDEO_DURATION),
        ctts(VIDEO_CTTS_OFFSETS),
        stss(VIDEO_SYNC_NUMBERS),
        stsc,
        stsz(VIDEO_SIZE),
        stco(videoOffsets),
      ),
    );
    const videoMinf = box(
      'minf',
      concat(box('vmhd', fullBox(0, 1, concat(u16(0), u16(0), u16(0), u16(0)))), dinf, videoStbl),
    );
    const videoTrak = box(
      'trak',
      concat(
        tkhd(VIDEO_ID, 0, 320, 240),
        box(
          'mdia',
          concat(mdhd(VIDEO_TIMESCALE, SAMPLE_COUNT * VIDEO_DURATION), hdlr('vide'), videoMinf),
        ),
      ),
    );

    return box('moov', concat(mvhd, audioTrak, videoTrak));
  };

  // stco values do not affect box sizes, so measure moov with placeholders,
  // compute absolute offsets, then rebuild with the real values.
  const placeholders = Array.from({ length: SAMPLE_COUNT }, () => 0);
  const moovSize = buildMoov(placeholders, placeholders).length;
  const mediaStart = ftyp.length + moovSize + 8; // + mdat header

  const audioOffsets = Array.from({ length: SAMPLE_COUNT }, (_, k) => mediaStart + k * AUDIO_SIZE);
  const videoOffsets = Array.from(
    { length: SAMPLE_COUNT },
    (_, j) => mediaStart + SAMPLE_COUNT * AUDIO_SIZE + j * VIDEO_SIZE,
  );

  const moov = buildMoov(audioOffsets, videoOffsets);
  if (moov.length !== moovSize) throw new Error('moov size must not depend on stco values');

  const audioPayloads = Array.from({ length: SAMPLE_COUNT }, (_, k) =>
    samplePayload(0xa1, k, AUDIO_SIZE),
  );
  const videoPayloads = Array.from({ length: SAMPLE_COUNT }, (_, j) =>
    samplePayload(0xb2, j, VIDEO_SIZE),
  );
  const mdat = box('mdat', concat(...audioPayloads, ...videoPayloads));

  return {
    bytes: concat(ftyp, moov, mdat),
    mediaStart,
    audioOffsets,
    videoOffsets,
    audioPayloads,
    videoPayloads,
  };
}

/* ------------------------------------------------------------------ */
/* Test helpers                                                        */
/* ------------------------------------------------------------------ */

function appendRange(mp4: ISOFile, file: Uint8Array, start: number, end = file.length) {
  const chunk = file.buffer.slice(start, end) as ArrayBuffer;
  mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(chunk, start));
}

async function createParserReadyAt(
  fixture: MultiTrackFixture,
  bufferedEnd: number,
  keepMdatData: boolean,
): Promise<ISOFile> {
  const mp4 = createFile(keepMdatData);
  const ready = new Promise<void>(resolve => {
    mp4.onReady = () => resolve();
  });
  appendRange(mp4, fixture.bytes, 0, bufferedEnd);
  await ready;
  return mp4;
}

/** Stand-in for the network/range layer: records every requested resume position. */
class RangeNetwork {
  readonly requests: Array<number> = [];
  constructor(private readonly fixture: MultiTrackFixture) {}

  /** Returns the bytes an HTTP range response starting at `position` would carry. */
  resumeAt(position: number): ArrayBuffer {
    this.requests.push(position);
    return this.fixture.bytes.buffer.slice(position, this.fixture.bytes.length) as ArrayBuffer;
  }

  feed(mp4: ISOFile, position: number, last = true) {
    mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(this.resumeAt(position), position), last);
  }
}

type Trak = NonNullable<ReturnType<ISOFile['getTrackById']>>;

function track(mp4: ISOFile, id: number): Trak {
  const t = mp4.getTrackById(id);
  if (!t) throw new Error(`missing track ${id}`);
  return t;
}

function expectMatchingSamples(
  batches: Partial<Record<number, Array<Sample>>>,
  id: number,
  payloads: Array<Uint8Array>,
  startIndex: number,
): Array<Sample> {
  const samples = batches[id];
  if (!samples) throw new Error(`no samples extracted for track ${id}`);
  expect(samples).toHaveLength(payloads.length - startIndex);
  samples.forEach((sample, i) => {
    const index = startIndex + i;
    expect(sample.number).toBe(index);
    const actual = Buffer.from(sample.data as Uint8Array);
    const expected = Buffer.from(payloads[index]);
    if (!actual.equals(expected)) {
      throw new Error(`track ${id} sample ${index} bytes do not match the source range`);
    }
  });
  return samples;
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('multi-track seeking', () => {
  it('fixture pins distinct timescales, reordering and exact byte anchors', () => {
    const fx = buildMultiTrackFile();
    // Exact layout constants (ftyp=28 bytes, moov=1436 bytes).
    expect(fx.mediaStart).toBe(1472);
    expect(fx.audioOffsets[6]).toBe(1856);
    expect(fx.mediaStart + 6 * AUDIO_SIZE).toBe(1856);
    expect(fx.audioOffsets[10]).toBe(2112);
    expect(fx.videoOffsets[6]).toBe(3008);
    expect(fx.mediaStart + SAMPLE_COUNT * AUDIO_SIZE + 6 * VIDEO_SIZE).toBe(3008);
    expect(fx.bytes.length).toBe(3776);
  });

  it('selects independently decodable start samples per track and reports each resume time', async () => {
    const fx = buildMultiTrackFile();
    // Only ftyp + moov are buffered, as after an initial metadata fetch.
    const mp4 = await createParserReadyAt(fx, fx.mediaStart - 8, true);

    const audio = track(mp4, AUDIO_ID);
    const video = track(mp4, VIDEO_ID);
    expect(audio.mdia.mdhd.timescale).toBe(AUDIO_TIMESCALE);
    expect(video.mdia.mdhd.timescale).toBe(VIDEO_TIMESCALE);

    // The video composition timeline is genuinely reordered in decode order.
    const cts = video.samples.map(s => s.cts as number);
    expect(cts.some((value, i) => i > 0 && value < cts[i - 1])).toBe(true);

    const target = 0.3;

    // Without RAP alignment the video lands on sample j=3, which is not a
    // sync sample and therefore is not independently decodable.
    const videoPrecise = mp4.seekTrack(target, false, video);
    expect(video.nextSample).toBe(3);
    expect(video.samples[3].is_sync).toBe(false);
    expect(videoPrecise.time).toBe(6000 / VIDEO_TIMESCALE);
    expect(videoPrecise.offset).toBe(fx.videoOffsets[3]);

    // With RAP alignment the same wall-clock time restarts video at j=0.
    const videoRap = mp4.seekTrack(target, true, video);
    expect(video.nextSample).toBe(0);
    expect(video.samples[0].is_sync).toBe(true);
    expect(videoRap).toEqual({ offset: fx.videoOffsets[0], time: 0 });

    // Audio has no stss table so every sample is a sync sample. At 0.3 s the
    // selected sample is j=3 on the 48 kHz timescale (cts 12000 -> 0.25 s).
    const audioRap = mp4.seekTrack(target, true, audio);
    expect(audio.nextSample).toBe(3);
    expect(audio.samples[3].is_sync).toBe(true);
    expect(audioRap).toEqual({ offset: fx.audioOffsets[3], time: 12_000 / AUDIO_TIMESCALE });
  });

  it('resumes from the buffered end and reconnects both tracks when the RAP range is partially buffered', async () => {
    const fx = buildMultiTrackFile();

    // Partial media buffer: 400 bytes into mdat payload, cutting 16 bytes
    // inside audio sample #6. It covers the earliest per-track RAP offset
    // (audio #6 at 1856) but not all of that sample.
    const bufferedEnd = fx.mediaStart + 400; // 1872
    expect(bufferedEnd).toBe(1872);
    const mp4 = await createParserReadyAt(fx, bufferedEnd, true);

    mp4.setExtractionOptions(AUDIO_ID, undefined, { nbSamples: 1000 });
    mp4.setExtractionOptions(VIDEO_ID, undefined, { nbSamples: 1000 });

    const target = 0.5;
    const audioSeek = mp4.seekTrack(target, true, track(mp4, AUDIO_ID));
    const videoSeek = mp4.seekTrack(target, true, track(mp4, VIDEO_ID));

    // Each track starts at its own independently decodable sample ...
    expect(audioSeek).toEqual({ offset: fx.audioOffsets[6], time: 0.5 });
    expect(videoSeek.offset).toBe(fx.videoOffsets[6]);
    expect(videoSeek.time).toBe(10_000 / VIDEO_TIMESCALE);
    expect(track(mp4, AUDIO_ID).samples[6].is_sync).toBe(true);
    expect(track(mp4, VIDEO_ID).samples[6].is_sync).toBe(true);

    // ... while the combined seek reports the earliest byte offset and the
    // earliest resume time across tracks, adjusted to the end of the
    // contiguous buffer already held by the network layer.
    const seekInfo = mp4.seek(target, true);
    expect(seekInfo.time).toBe(Math.min(audioSeek.time, videoSeek.time));
    expect(seekInfo.time).toBe(10_000 / VIDEO_TIMESCALE);
    expect(seekInfo.offset).toBe(bufferedEnd);

    // The network layer is asked to continue exactly at that position, never
    // earlier, and the caller feeds the returned missing range back in.
    const network = new RangeNetwork(fx);
    const missing = network.resumeAt(seekInfo.offset);
    expect(network.requests).toEqual([1872]);
    mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(missing, seekInfo.offset));

    const batches: Partial<Record<number, Array<Sample>>> = {};
    mp4.onSamples = (id, _user, samples) => {
      batches[id] = samples;
    };
    mp4.start();
    mp4.flush();

    // Both tracks continue from their RAP sample to the end of the file, and
    // every byte - including the sample split by the old buffer boundary -
    // is reconstructed correctly from prefix + resumed range.
    const audioSamples = expectMatchingSamples(batches, AUDIO_ID, fx.audioPayloads, 6);
    const videoSamples = expectMatchingSamples(batches, VIDEO_ID, fx.videoPayloads, 6);

    const audioFirst = audioSamples[0];
    const videoFirst = videoSamples[0];
    expect(audioFirst.is_sync).toBe(true);
    expect(videoFirst.is_sync).toBe(true);
    expect(audioFirst.timescale).toBe(AUDIO_TIMESCALE);
    expect(videoFirst.timescale).toBe(VIDEO_TIMESCALE);
    expect(audioFirst.cts / AUDIO_TIMESCALE).toBe(audioSeek.time);
    expect(videoFirst.cts / VIDEO_TIMESCALE).toBe(videoSeek.time);
  });

  it('issues a range at the earliest RAP offset and resumes both tracks across an unbuffered gap', async () => {
    const fx = buildMultiTrackFile();

    // Only the mdat header and 8 media bytes have been buffered; the seek
    // target lies far ahead, leaving a gap between the old prefix and the
    // resumed range.
    const bufferedEnd = fx.mediaStart + 8;
    const mp4 = await createParserReadyAt(fx, bufferedEnd, false);

    mp4.setExtractionOptions(AUDIO_ID, undefined, { nbSamples: 1000 });
    mp4.setExtractionOptions(VIDEO_ID, undefined, { nbSamples: 1000 });
    // Playback/extraction was running before the scrub, as in a player.
    mp4.start();

    const target = 0.9;
    const seekInfo = mp4.seek(target, true);

    // Audio RAP #10 (cts 40000 / 48000 = 5/6 s, offset 2112) is earlier in
    // the file than video RAP #6 (offset 3008), so it drives the network
    // resume position. Neither offset is covered by the tiny prefix, hence
    // no buffered-end adjustment happens.
    expect(track(mp4, AUDIO_ID).nextSample).toBe(10);
    expect(track(mp4, AUDIO_ID).samples[10].is_sync).toBe(true);
    expect(track(mp4, VIDEO_ID).nextSample).toBe(6);
    expect(track(mp4, VIDEO_ID).samples[6].is_sync).toBe(true);
    expect(seekInfo.offset).toBe(fx.audioOffsets[10]);
    expect(seekInfo.offset).toBe(2112);
    expect(seekInfo.time).toBe(10_000 / VIDEO_TIMESCALE);

    const network = new RangeNetwork(fx);
    const batches: Partial<Record<number, Array<Sample>>> = {};
    mp4.onSamples = (id, _user, samples) => {
      batches[id] = samples;
    };
    // Extraction is already started, so feeding the range delivers the final
    // batches immediately; flush covers any trailing samples.
    network.feed(mp4, seekInfo.offset, true);
    mp4.flush();

    expect(network.requests).toEqual([2112]);

    const audioSamples = expectMatchingSamples(batches, AUDIO_ID, fx.audioPayloads, 10);
    const videoSamples = expectMatchingSamples(batches, VIDEO_ID, fx.videoPayloads, 6);

    expect(audioSamples[0].cts / AUDIO_TIMESCALE).toBe(40_000 / AUDIO_TIMESCALE);
    expect(videoSamples[0].cts / VIDEO_TIMESCALE).toBe(10_000 / VIDEO_TIMESCALE);
  });
});
