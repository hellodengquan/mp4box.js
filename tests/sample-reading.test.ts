import { createFile, DataStream, Endianness, MP4BoxBuffer, type Sample } from '../entries/all';

/**
 * Integration tests for pull-based sample reading (getTrackSample /
 * releaseUsedSamples) on a file that is appended progressively, as a
 * VOD client would receive it.
 *
 * The media file is built in memory with two tracks so that the tests can
 * verify, sample by sample:
 *  - the distinction between "waiting for more bytes" (getTrackSample
 *    returns undefined) and "complete payload" (it returns the sample),
 *  - that the delivered bytes are exactly the sample bytes in the media,
 *  - that the reported memory usage (getAllocatedSampleDataSize) is
 *    explained by the individual samples read but not yet released,
 *  - that releasing samples on one track retains the other track's data.
 */

/** Sample sizes, deliberately not multiples of the append chunk size. */
const TRACK_1_SIZES = [5000, 1200, 2600];
const TRACK_2_SIZES = [768, 512];

/** Deterministic payload so delivered bytes can be checked exactly. */
function makePayload(trackId: number, sampleNumber: number, size: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    data[i] = (trackId * 7 + sampleNumber * 13 + i * 31) % 251;
  }
  return data;
}

function payloadKey(trackId: number, sampleNumber: number) {
  return `${trackId}:${sampleNumber}`;
}

function mustGet(payloads: Map<string, Uint8Array>, trackId: number, sampleNumber: number) {
  const payload = payloads.get(payloadKey(trackId, sampleNumber));
  if (!payload) throw new Error(`No payload for track ${trackId} sample ${sampleNumber}`);
  return payload;
}

function mustGetSample(mp4: ReturnType<typeof createFile>, trackId: number, sampleNumber: number) {
  const sample = mp4.getTrackSample(trackId, sampleNumber);
  if (!sample) throw new Error(`Sample ${sampleNumber} of track ${trackId} is not complete`);
  return sample;
}

/** Builds a fragmented MP4 in memory and returns its bytes plus the source payloads. */
function buildMediaFile() {
  const mp4 = createFile();
  const track1 = mp4.addTrack({ timescale: 90000 });
  const track2 = mp4.addTrack({ timescale: 48000 });

  const payloads = new Map<string, Uint8Array>();
  const addSamples = (trackId: number, sizes: Array<number>) => {
    sizes.forEach((size, i) => {
      const data = makePayload(trackId, i, size);
      payloads.set(payloadKey(trackId, i), data);
      mp4.addSample(trackId, data, {
        duration: 1000,
        cts: i * 1000,
        dts: i * 1000,
        is_sync: i === 0,
      });
    });
  };
  addSamples(track1, TRACK_1_SIZES);
  addSamples(track2, TRACK_2_SIZES);

  const stream = new DataStream();
  stream.endianness = Endianness.BIG_ENDIAN;
  mp4.write(stream);

  return { fileBytes: new Uint8Array(stream.buffer), track1, track2, payloads };
}

/** Appends one chunk of the "download" to the reader file. */
function appendChunk(
  mp4: ReturnType<typeof createFile>,
  fileBytes: Uint8Array,
  pos: number,
  chunkSize: number,
) {
  const end = Math.min(pos + chunkSize, fileBytes.byteLength);
  // slice() copies, so each appended buffer owns its bytes
  mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(fileBytes.slice(pos, end).buffer, pos));
  return end;
}

describe('Sample reading on a progressively appended file', () => {
  it('reports "waiting" until a chunked sample is complete, then delivers the exact bytes', () => {
    const { fileBytes, track1, payloads } = buildMediaFile();
    const mp4 = createFile(true); // keep mdat bytes so sample payloads can be read back

    const CHUNK = 1000; // smaller than the first sample (5000 bytes): it arrives in pieces
    const target = mustGet(payloads, track1, 0);

    const waitingProgress: Array<number> = [];
    let allocatedBeforeFirstRead = -1;
    let delivered: Sample | undefined;

    for (let pos = 0; pos < fileBytes.byteLength && !delivered;) {
      pos = appendChunk(mp4, fileBytes, pos, CHUNK);

      const infos = mp4.getTrackSamplesInfo(track1);
      if (!infos || infos.length === 0) continue; // moov/moof not parsed yet

      if (allocatedBeforeFirstRead === -1) {
        allocatedBeforeFirstRead = mp4.getAllocatedSampleDataSize();
      }

      const sample = mp4.getTrackSample(track1, 0);
      if (!sample) {
        // Waiting state: no payload yet, but the allocation is already reported
        // and partial progress is visible on the sample info.
        waitingProgress.push(infos[0].alreadyRead ?? 0);
        expect(mp4.getAllocatedSampleDataSize()).toBe(target.byteLength);
        expect(infos[0].alreadyRead).toBeLessThan(target.byteLength);
      } else {
        delivered = sample;
      }
    }

    // No memory was held before the sample was first requested.
    expect(allocatedBeforeFirstRead).toBe(0);

    // The sample genuinely arrived in several installments: at least two
    // waiting observations with strictly increasing partial progress.
    expect(waitingProgress.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < waitingProgress.length; i++) {
      expect(waitingProgress[i]).toBeGreaterThan(waitingProgress[i - 1]);
    }

    // Complete state: the caller gets the full payload.
    if (!delivered) throw new Error('Sample was never delivered');
    expect(delivered.alreadyRead).toBe(target.byteLength);
    expect(delivered.data).toEqual(target);
    // ... and those bytes are exactly the ones at the sample's offset in the media.
    expect(delivered.data).toEqual(
      fileBytes.slice(delivered.offset, delivered.offset + delivered.size),
    );

    // Memory is still accounted per sample: exactly this sample's size.
    expect(mp4.getAllocatedSampleDataSize()).toBe(target.byteLength);
  });

  it('accounts memory per sample across reads and releases, retaining other tracks', () => {
    const { fileBytes, track1, track2, payloads } = buildMediaFile();
    const mp4 = createFile(true);

    // Append the whole file in chunks (download completes).
    const CHUNK = 1000;
    for (let pos = 0; pos < fileBytes.byteLength;) {
      pos = appendChunk(mp4, fileBytes, pos, CHUNK);
    }

    expect(mp4.getAllocatedSampleDataSize()).toBe(0);

    // Read three samples on track 1 and one on track 2.
    const t1s0 = mustGetSample(mp4, track1, 0);
    const t1s1 = mustGetSample(mp4, track1, 1);
    const t1s2 = mustGetSample(mp4, track1, 2);
    const t2s0 = mustGetSample(mp4, track2, 0);

    const readSamples: Array<[Sample, number, number]> = [
      [t1s0, track1, 0],
      [t1s1, track1, 1],
      [t1s2, track1, 2],
      [t2s0, track2, 0],
    ];
    for (const [sample, trackId, num] of readSamples) {
      expect(sample.data).toEqual(mustGet(payloads, trackId, num));
    }

    const [s0, s1, s2, a0] = [
      TRACK_1_SIZES[0],
      TRACK_1_SIZES[1],
      TRACK_1_SIZES[2],
      TRACK_2_SIZES[0],
    ];
    const total = s0 + s1 + s2 + a0;

    // The reported usage is exactly the sum of the read-but-unreleased samples.
    expect(mp4.getAllocatedSampleDataSize()).toBe(total);

    // Re-reading an already delivered sample changes nothing.
    expect(mp4.getTrackSample(track1, 0)).toBe(t1s0);
    expect(mp4.getAllocatedSampleDataSize()).toBe(total);

    // Releasing track 1 samples one by one: each step is explained by that
    // sample's size, and track 2's delivered-but-unreleased data is retained.
    mp4.releaseUsedSamples(track1, 1);
    expect(mp4.getAllocatedSampleDataSize()).toBe(s1 + s2 + a0);

    mp4.releaseUsedSamples(track1, 2);
    expect(mp4.getAllocatedSampleDataSize()).toBe(s2 + a0);

    // Track 2's sample is still intact after track 1's releases.
    expect(mustGetSample(mp4, track2, 0).data).toEqual(mustGet(payloads, track2, 0));

    mp4.releaseUsedSamples(track1, 3);
    expect(mp4.getAllocatedSampleDataSize()).toBe(a0);

    // A track 2 sample never read so far is still fetchable and correct.
    const t2s1 = mustGetSample(mp4, track2, 1);
    expect(t2s1.data).toEqual(mustGet(payloads, track2, 1));
    expect(mp4.getAllocatedSampleDataSize()).toBe(a0 + TRACK_2_SIZES[1]);

    // Releasing the rest brings the reported usage back to zero.
    mp4.releaseUsedSamples(track2, 2);
    expect(mp4.getAllocatedSampleDataSize()).toBe(0);
  });
});
