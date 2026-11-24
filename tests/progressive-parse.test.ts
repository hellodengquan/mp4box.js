import {
  Box,
  createFile,
  DataStream,
  MP4BoxBuffer,
  MultiBufferStream,
  type ISOFile,
  type Movie,
  type Sample,
} from '../entries/all';
import { avcCBox } from '../src/boxes/avcC';
import { dinfBox, mdiaBox, minfBox, moovBox, stblBox, trakBox } from '../src/boxes/defaults';
import { drefBox } from '../src/boxes/dref';
import { ftypBox } from '../src/boxes/ftyp';
import { hdlrBox } from '../src/boxes/hdlr';
import { mdhdBox } from '../src/boxes/mdhd';
import { mvhdBox } from '../src/boxes/mvhd';
import { avc1SampleEntry } from '../src/boxes/sampleentries/sampleentry';
import { stcoBox } from '../src/boxes/stco';
import { stscBox } from '../src/boxes/stsc';
import { stsdBox } from '../src/boxes/stsd';
import { stssBox } from '../src/boxes/stss';
import { stszBox } from '../src/boxes/stsz';
import { sttsBox } from '../src/boxes/stts';
import { tkhdBox } from '../src/boxes/tkhd';
import { urlBox } from '../src/boxes/url';
import { vmhdBox } from '../src/boxes/vmhd';

/**
 * Integration test for the progressive-read chain of an MP4 whose movie index
 * (`moov`) is stored *after* the media data (`mdat`):
 *
 *   [ftyp][mdat ...][moov]
 *
 * The player receives the file in arbitrary chunks, forwards each chunk with
 * `appendBuffer()`, and uses the returned file position to decide the next
 * range to fetch. While the index has not been seen the parser must not ask
 * for the media bytes; it must jump straight to the `moov`. Once the index is
 * parsed the track information must be published (`onMoovStart` then
 * `onReady`) and the next request must be the byte offset of the first sample
 * as recorded in the index. The sample payloads eventually delivered through
 * `onSamples` must be byte-identical to the media data stored at those offsets
 * in the original file.
 *
 * The fixture is generated in memory (no network fixtures) but is a complete,
 * parseable non-fragmented MP4 so the test exercises the real parser.
 */

const SAMPLE_PAYLOADS = [
  new Uint8Array([0x10, 0x11, 0x12, 0x13, 0x14]),
  new Uint8Array([0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26]),
  new Uint8Array([0x30, 0x31, 0x32]),
  new Uint8Array([0x40, 0x41, 0x42, 0x43, 0x44, 0x45]),
];

const SAMPLE_DURATION = 100;
const TIMESCALE = 100;

function ascii(value: string) {
  return new TextEncoder().encode(value);
}

/** Serializes a box using the library's own writer, to keep the fixture spec-correct. */
function serialize(box: Box) {
  const stream = new DataStream();
  box.write(stream as unknown as MultiBufferStream);
  return new Uint8Array(stream.buffer);
}

interface ProgressiveFixture {
  fileBytes: Uint8Array;
  payloads: Array<Uint8Array>;
  sampleOffsets: Array<number>;
  ftypLength: number;
  mdatStart: number;
  mdatSize: number;
  moovStart: number;
  payloadStart: number;
  fileEnd: number;
}

function buildIndexAfterMediaFile(): ProgressiveFixture {
  const payloads = SAMPLE_PAYLOADS.map(payload => payload.slice());
  const payloadLength = payloads.reduce((total, payload) => total + payload.length, 0);

  const ftyp = new ftypBox();
  ftyp.major_brand = 'isom';
  ftyp.minor_version = 0;
  ftyp.compatible_brands = ['isom', 'iso2', 'avc1', 'mp41'];
  const ftypBytes = serialize(ftyp);

  // Layout: ftyp | mdat(header + samples) | moov
  const ftypLength = ftypBytes.length;
  const mdatStart = ftypLength;
  const mdatSize = 8 + payloadLength;
  const payloadStart = mdatStart + 8;
  const moovStart = mdatStart + mdatSize;

  const sampleOffsets: Array<number> = [];
  let offset = payloadStart;
  for (const payload of payloads) {
    sampleOffsets.push(offset);
    offset += payload.length;
  }

  // --- moov (non-fragmented) ---
  const moov = new moovBox();

  const mvhd = moov.addBox(new mvhdBox());
  mvhd.creation_time = 0;
  mvhd.modification_time = 0;
  mvhd.timescale = TIMESCALE;
  mvhd.duration = SAMPLE_DURATION * payloads.length;
  mvhd.rate = 1 << 16;
  mvhd.volume = 1;
  mvhd.matrix = [1 << 16, 0, 0, 0, 1 << 16, 0, 0, 0, 0x40000000];
  mvhd.next_track_id = 2;

  const trak = moov.addBox(new trakBox());

  const tkhd = trak.addBox(new tkhdBox());
  tkhd.flags = 0x3; // enabled | in movie
  tkhd.creation_time = 0;
  tkhd.modification_time = 0;
  tkhd.track_id = 1;
  tkhd.duration = SAMPLE_DURATION * payloads.length;
  tkhd.layer = 0;
  tkhd.alternate_group = 0;
  tkhd.volume = 1;
  tkhd.matrix = [1 << 16, 0, 0, 0, 1 << 16, 0, 0, 0, 0x40000000];
  tkhd.width = 320 << 16;
  tkhd.height = 240 << 16;

  const mdia = trak.addBox(new mdiaBox());

  const mdhd = mdia.addBox(new mdhdBox());
  mdhd.creation_time = 0;
  mdhd.modification_time = 0;
  mdhd.timescale = TIMESCALE;
  mdhd.duration = SAMPLE_DURATION * payloads.length;
  mdhd.language = 0x55c4; // 'und'

  const hdlr = mdia.addBox(new hdlrBox());
  hdlr.handler = 'vide';
  hdlr.name = 'VideoHandler';

  const minf = mdia.addBox(new minfBox());

  const vmhd = minf.addBox(new vmhdBox());
  vmhd.graphicsmode = 0;
  vmhd.opcolor = [0, 0, 0];

  const dinf = minf.addBox(new dinfBox());
  const dref = dinf.addBox(new drefBox());
  dref.addEntry(new urlBox());

  const stbl = minf.addBox(new stblBox());

  const stsd = stbl.addBox(new stsdBox());
  const sampleEntry = new avc1SampleEntry();
  sampleEntry.data_reference_index = 1;
  sampleEntry.width = 320;
  sampleEntry.height = 240;
  sampleEntry.horizresolution = 0x00480000;
  sampleEntry.vertresolution = 0x00480000;
  sampleEntry.frame_count = 1;
  sampleEntry.compressorname = 'avc1';
  sampleEntry.depth = 0x18;
  const avcC = sampleEntry.addBox(new avcCBox());
  avcC.configurationVersion = 1;
  avcC.AVCProfileIndication = 0x64;
  avcC.profile_compatibility = 0;
  avcC.AVCLevelIndication = 0x1f;
  avcC.lengthSizeMinusOne = 3;
  avcC.nb_SPS_nalus = 1;
  avcC.SPS = [{ length: 4, data: new Uint8Array([0x67, 0x64, 0x00, 0x1f]) }];
  avcC.nb_PPS_nalus = 1;
  avcC.PPS = [{ length: 2, data: new Uint8Array([0x68, 0xee]) }];
  stsd.addEntry(sampleEntry);

  const stts = stbl.addBox(new sttsBox());
  stts.sample_counts = [payloads.length];
  stts.sample_deltas = [SAMPLE_DURATION];

  const stsc = stbl.addBox(new stscBox());
  stsc.first_chunk = [1];
  stsc.samples_per_chunk = [payloads.length];
  stsc.sample_description_index = [1];

  const stsz = stbl.addBox(new stszBox());
  stsz.sample_size = 0;
  stsz.sample_sizes = payloads.map(payload => payload.length);

  // All samples live in a single chunk that starts at the first payload byte.
  const stco = stbl.addBox(new stcoBox());
  stco.chunk_offsets = [payloadStart];

  const stss = stbl.addBox(new stssBox());
  stss.sample_numbers = [1];

  const moovBytes = serialize(moov);
  const fileEnd = moovStart + moovBytes.length;

  const fileBytes = new Uint8Array(fileEnd);
  fileBytes.set(ftypBytes, 0);
  const view = new DataView(fileBytes.buffer);
  view.setUint32(mdatStart, mdatSize);
  fileBytes.set(ascii('mdat'), mdatStart + 4);
  for (const [index, payload] of payloads.entries()) {
    fileBytes.set(payload, sampleOffsets[index]);
  }
  fileBytes.set(moovBytes, moovStart);

  return {
    fileBytes,
    payloads,
    sampleOffsets,
    ftypLength,
    mdatStart,
    mdatSize,
    moovStart,
    payloadStart,
    fileEnd,
  };
}

interface RecordedRun {
  mp4: ISOFile;
  requests: Array<number | undefined>;
  batches: Array<Array<Sample>>;
  events: Array<string>;
  errors: Array<string>;
  readyInfo?: Movie;
}

function recordCallbacks(mp4: ISOFile): RecordedRun {
  const run: RecordedRun = { mp4, requests: [], batches: [], events: [], errors: [] };

  mp4.onMoovStart = () => {
    run.events.push('moov-start');
  };
  mp4.onReady = info => {
    run.events.push('ready');
    run.readyInfo = info;
    // A player reacts to the track information: it starts extracting the
    // samples it needs as soon as the playback pipeline is configured.
    mp4.setExtractionOptions(1, undefined, { nbSamples: 2 });
    mp4.start();
  };
  mp4.onSamples = (_id, _user, samples) => {
    run.batches.push(samples);
    run.events.push('samples:' + samples.map(sample => sample.number).join(','));
  };
  mp4.onError = (module, message) => {
    run.errors.push(module + ': ' + message);
  };

  return run;
}

function feed(run: RecordedRun, fileBytes: Uint8Array, start: number, end: number) {
  const chunk = fileBytes.slice(start, end);
  const next = run.mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(chunk.buffer, start));
  run.requests.push(next);
  return next;
}

function allSamples(run: RecordedRun) {
  return run.batches.flat();
}

describe('Progressive parsing with the movie index after the media data', () => {
  it('requests the index, publishes the tracks, then requests exactly the sample bytes', () => {
    const fixture = buildIndexAfterMediaFile();
    const { fileBytes, payloads, sampleOffsets, ftypLength, mdatStart, mdatSize, moovStart } =
      fixture;

    const mp4 = createFile();
    const run = recordCallbacks(mp4);

    // 1. A first fragment that is too small to even hold a box header. The
    //    parser can only ask for the bytes directly following it.
    expect(feed(run, fileBytes, 0, 4)).toBe(4);

    // 2. The rest of ftyp arrives. The next box (mdat) is already complete
    //    from the reader's point of view: it must ask for the media start.
    expect(feed(run, fileBytes, 4, ftypLength)).toBe(ftypLength);
    expect(mp4.getBox('ftyp')?.major_brand).toBe('isom');

    // 3. Only the mdat *header* arrives. The parser learns the media extent
    //    without the payload and jumps to the index that follows it, instead
    //    of pulling the media bytes it cannot interpret yet.
    expect(feed(run, fileBytes, mdatStart, mdatStart + 8)).toBe(moovStart);
    expect(mp4.moov).toBeUndefined();
    expect(mp4.mdats).toHaveLength(1);
    expect(mp4.mdats[0].start).toBe(mdatStart);
    expect(mp4.mdats[0].size).toBe(mdatSize);
    expect(run.events).toEqual([]);

    // 4. The beginning of moov arrives, but not the whole box. The parser
    //    signals that it is now reading the movie index (`onMoovStart`), and
    //    the next request continues the index (end of contiguous data).
    const moovPrefix = 20;
    expect(feed(run, fileBytes, moovStart, moovStart + moovPrefix)).toBe(moovStart + moovPrefix);
    expect(run.events).toEqual(['moov-start']);
    expect(run.readyInfo).toBeUndefined();
    expect(mp4.getInfo().hasMoov).toBe(false);

    // 5. The rest of moov completes the index. Track information is published
    //    exactly once, and the next request is the first sample's file offset
    //    as written in the sample table (inside the media data).
    expect(feed(run, fileBytes, moovStart + moovPrefix, fixture.fileEnd)).toBe(
      fixture.payloadStart,
    );
    expect(run.events).toEqual(['moov-start', 'ready']);
    expect(run.readyInfo).toBeDefined();
    expect(run.readyInfo.tracks).toHaveLength(1);
    expect(run.readyInfo.tracks[0].id).toBe(1);
    expect(run.readyInfo.tracks[0].nb_samples).toBe(payloads.length);
    expect(run.readyInfo.tracks[0].codec).toBe('avc1.64001f');
    expect(run.readyInfo.videoTracks).toHaveLength(1);
    expect(mp4.getTrackById(1).samples[0].offset).toBe(fixture.payloadStart);

    // 6. Media bytes arrive. The chunk stops in the middle of sample #1, so
    //    only sample #0 can be completed; the next request resumes at the
    //    first byte the parser has not consumed (no re-fetch of the sample
    //    start, no re-download of the already consumed prefix). No batch is
    //    emitted yet because the extraction window is two samples.
    const firstChunkEnd = fixture.payloadStart + payloads[0].length + 3;
    expect(feed(run, fileBytes, fixture.payloadStart, firstChunkEnd)).toBe(firstChunkEnd);
    expect(run.batches).toHaveLength(0);
    expect(mp4.getTrackById(1).samples[0].alreadyRead).toBe(payloads[0].length);
    expect(mp4.getTrackById(1).samples[1].alreadyRead).toBe(3);

    // 7. The remainder of sample #1 arrives: the first batch is handed over.
    expect(feed(run, fileBytes, firstChunkEnd, sampleOffsets[2])).toBe(sampleOffsets[2]);
    expect(run.events).toEqual(['moov-start', 'ready', 'samples:0,1']);

    // 8. The last media chunk completes the track.
    expect(feed(run, fileBytes, sampleOffsets[2], fixture.mdatStart + fixture.mdatSize)).toBe(
      fixture.fileEnd,
    );
    expect(run.events).toEqual(['moov-start', 'ready', 'samples:0,1', 'samples:2,3']);

    mp4.flush();
    expect(run.events).toEqual(['moov-start', 'ready', 'samples:0,1', 'samples:2,3']);
    expect(run.errors).toEqual([]);

    // The full sequence of positions handed back to the player.
    expect(run.requests).toEqual([
      4,
      ftypLength, // start of the media box
      moovStart, // skip the media data, fetch the index
      moovStart + moovPrefix, // continue the index
      fixture.payloadStart, // first sample offset from the index
      firstChunkEnd, // resume the partially read sample
      sampleOffsets[2], // next sample
      fixture.fileEnd, // end of file
    ]);

    // Traceability: every delivered payload is byte-identical to the original
    // file at the offset the parser read from the sample table.
    const samples = allSamples(run);
    expect(samples.map(sample => sample.number)).toEqual([0, 1, 2, 3]);
    expect(samples.map(sample => sample.offset)).toEqual(sampleOffsets);
    for (const [index, sample] of samples.entries()) {
      expect(sample.size).toBe(payloads[index].length);
      expect(sample.alreadyRead).toBe(sample.size);
      expect(sample.description.type).toBe('avc1');
      expect(Array.from(sample.data)).toEqual(Array.from(payloads[index]));
      expect(Array.from(fileBytes.subarray(sample.offset, sample.offset + sample.size))).toEqual(
        Array.from(payloads[index]),
      );
    }
    expect(samples.map(sample => sample.is_sync)).toEqual([true, false, false, false]);
    expect(samples.map(sample => sample.dts)).toEqual([0, 100, 200, 300]);
  });

  it('delivers the same payloads when the whole file arrives in one buffer', () => {
    const fixture = buildIndexAfterMediaFile();

    const mp4 = createFile();
    const run = recordCallbacks(mp4);

    mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(fixture.fileBytes.slice().buffer, 0));
    mp4.flush();

    expect(run.errors).toEqual([]);
    expect(run.events).toEqual(['moov-start', 'ready', 'samples:0,1', 'samples:2,3']);

    const samples = allSamples(run);
    expect(samples.map(sample => sample.number)).toEqual([0, 1, 2, 3]);
    expect(samples.map(sample => sample.offset)).toEqual(fixture.sampleOffsets);
    expect(samples.map(sample => Array.from(sample.data))).toEqual(
      fixture.payloads.map(payload => Array.from(payload)),
    );
  });
});
