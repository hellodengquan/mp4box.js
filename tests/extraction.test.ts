import fs from 'fs';
import { createFile, type ISOFile, type Sample } from '../entries/all';
import { getFilePath, getFileRange, loadAndGetInfo } from './common';

/**
 * Test-side stand-in for a media sample processor.
 *
 * Each extracted track gets its own processor: it keeps every batch delivered
 * through `onSamples`, records per-batch sizes and can pause extraction as soon
 * as a batch is received. Resuming is left to the test driving the processor.
 */
class SampleProcessor {
  public readonly id: number;
  public readonly batches: Array<Array<Sample>> = [];
  public paused = false;
  /** Total sample count observed each time this processor asked to pause. */
  public readonly pauseMarkers: Array<number> = [];
  /** Number of batches after which the processor asks to pause, if any. */
  private readonly pauseAfterBatch?: number;

  constructor(id: number, pauseAfterBatch?: number) {
    this.id = id;
    this.pauseAfterBatch = pauseAfterBatch;
  }

  get totalSamples(): number {
    return this.batches.reduce((total, batch) => total + batch.length, 0);
  }

  /** Sample numbers in delivery order, flattened across all batches. */
  get sampleNumbers(): Array<number> {
    return this.batches.flatMap(batch => batch.map(sample => sample.number));
  }

  get batchSizes(): Array<number> {
    return this.batches.map(batch => batch.length);
  }

  handleBatch(samples: Array<Sample>): boolean {
    this.batches.push(samples);
    if (this.pauseAfterBatch !== undefined && this.batches.length === this.pauseAfterBatch) {
      this.paused = true;
      this.pauseMarkers.push(this.totalSamples);
    }
    return this.paused;
  }
}

/** Reference expectations derived directly from the parsed track tables. */
interface TrackExpectation {
  processor: SampleProcessor;
  sampleCount: number;
  sampleNumbers: Array<number>;
  nbSamples: number;
}

interface ProcessorSetup {
  audioProcessor: SampleProcessor;
  videoProcessor: SampleProcessor;
  audioBatchSize: number;
  videoBatchSize: number;
}

function createProcessors(
  audioTrackId: number,
  videoTrackId: number,
  options: { audioPauseAfterBatch?: number; videoPauseAfterBatch?: number } = {},
): ProcessorSetup {
  // Batch sizes deliberately differ between tracks and do not divide sample counts evenly.
  const audioBatchSize = 30;
  const videoBatchSize = 17;
  const audioProcessor = new SampleProcessor(audioTrackId, options.audioPauseAfterBatch);
  const videoProcessor = new SampleProcessor(videoTrackId, options.videoPauseAfterBatch);
  return { audioProcessor, videoProcessor, audioBatchSize, videoBatchSize };
}

function attachProcessors(
  mp4: ISOFile<unknown, SampleProcessor>,
  setup: ProcessorSetup,
): { audioProcessor: SampleProcessor; videoProcessor: SampleProcessor } {
  const { audioProcessor, videoProcessor, audioBatchSize, videoBatchSize } = setup;
  const processors = [audioProcessor, videoProcessor];

  mp4.onSamples = (id, user, samples) => {
    const processor = processors.find(candidate => candidate.id === id);
    if (!processor) throw new Error(`Unexpected samples callback for track #${id}`);
    // The processor registered through setExtractionOptions is handed back unchanged.
    expect(user).toBe(processor);
    if (processor.handleBatch(samples)) mp4.stop();
  };

  mp4.setExtractionOptions(audioProcessor.id, audioProcessor, { nbSamples: audioBatchSize });
  mp4.setExtractionOptions(videoProcessor.id, videoProcessor, { nbSamples: videoBatchSize });
  return { audioProcessor, videoProcessor };
}

function buildExpectation(
  mp4: ISOFile,
  processor: SampleProcessor,
  nbSamples: number,
): TrackExpectation {
  const trak = mp4.getTrackById(processor.id);
  return {
    processor,
    sampleCount: trak.samples.length,
    sampleNumbers: trak.samples.map(sample => sample.number),
    nbSamples,
  };
}

/** All batches but the last one must carry exactly the requested batch size. */
function expectBatchSizes(expectation: TrackExpectation): void {
  const { processor, sampleCount, nbSamples } = expectation;
  expect(processor.totalSamples).toBe(sampleCount);

  const fullBatchCount = Math.floor(sampleCount / nbSamples);
  const remainder = sampleCount % nbSamples;
  const expectedBatchCount = fullBatchCount + (remainder > 0 ? 1 : 0);

  expect(processor.batches.length).toBe(expectedBatchCount);
  processor.batches.forEach((batch, index) => {
    const isLastBatch = index === processor.batches.length - 1;
    if (isLastBatch && remainder > 0) expect(batch.length).toBe(remainder);
    else expect(batch.length).toBe(nbSamples);
  });
}

/** Delivery must restart exactly where the previous batch ended, without gaps or duplicates. */
function expectOriginalSampleSequence(expectation: TrackExpectation): void {
  const { processor, sampleNumbers } = expectation;
  expect(processor.sampleNumbers).toEqual(sampleNumbers);
  expect(new Set(processor.sampleNumbers).size).toBe(processor.sampleNumbers.length);

  // Timestamps must follow the same strictly ordered timeline as the source track.
  const deliveredDts = processor.batches.flatMap(batch => batch.map(sample => sample.dts));
  const sortedDts = [...deliveredDts].sort((a, b) => a - b);
  expect(deliveredDts).toEqual(sortedDts);
}

async function loadMultiTrackFile() {
  const { testFile } = getFilePath('isobmff', '01_simple.mp4');
  const { mp4 } = await loadAndGetInfo(testFile, true, true);
  const info = mp4.getInfo();

  const audioTrack = info.audioTracks[0];
  const videoTrack = info.videoTracks[0];
  if (!audioTrack || !videoTrack) {
    throw new Error('Test fixture must contain both an audio and a video track');
  }

  return { mp4, audioTrack, videoTrack };
}

describe('Multi-track sample extraction', () => {
  it('delivers independent batches to audio and video processors', async () => {
    const { mp4, audioTrack, videoTrack } = await loadMultiTrackFile();
    const setup = createProcessors(audioTrack.id, videoTrack.id);
    const { audioProcessor, videoProcessor } = attachProcessors(mp4, setup);

    mp4.start();
    mp4.flush();

    const audioExpectation = buildExpectation(mp4, audioProcessor, setup.audioBatchSize);
    const videoExpectation = buildExpectation(mp4, videoProcessor, setup.videoBatchSize);

    expectBatchSizes(audioExpectation);
    expectBatchSizes(videoExpectation);
    expectOriginalSampleSequence(audioExpectation);
    expectOriginalSampleSequence(videoExpectation);

    // Each processor only ever receives samples from its own track.
    for (const batch of audioProcessor.batches) {
      expect(batch.every(sample => sample.track_id === audioTrack.id)).toBe(true);
    }
    for (const batch of videoProcessor.batches) {
      expect(batch.every(sample => sample.track_id === videoTrack.id)).toBe(true);
    }
  });

  it('resumes both tracks from where each processor paused and flushes their final partial batches', async () => {
    const { mp4, audioTrack, videoTrack } = await loadMultiTrackFile();
    // Each processor pauses after receiving its second batch.
    const setup = createProcessors(audioTrack.id, videoTrack.id, {
      audioPauseAfterBatch: 2,
      videoPauseAfterBatch: 2,
    });
    const { audioProcessor, videoProcessor } = attachProcessors(mp4, setup);
    const processors = [audioProcessor, videoProcessor];

    // Drive extraction rounds until every processor has reached its own pause point.
    // `stop()` is file-wide: when one processor pauses, the other track's remaining
    // samples for that round stay queued until the next resume.
    let rounds = 0;
    while (processors.some(processor => processor.pauseMarkers.length === 0)) {
      expect(rounds).toBeLessThan(10);
      rounds++;
      for (const processor of processors) processor.paused = false;
      mp4.start();
      expect(processors.some(processor => processor.paused)).toBe(true);
    }

    // Both processors recorded a pause after exactly two of their own batches.
    expect(audioProcessor.pauseMarkers).toEqual([setup.audioBatchSize * 2]);
    expect(videoProcessor.pauseMarkers).toEqual([setup.videoBatchSize * 2]);
    const audioAtPause = audioProcessor.totalSamples;
    const videoAtPause = videoProcessor.totalSamples;

    // Each track's extraction cursor is parked exactly at its pause point, so a
    // resume has to continue from the next sample rather than restart the track.
    expect(mp4.getTrackById(audioTrack.id).nextSample).toBe(audioAtPause);
    expect(mp4.getTrackById(videoTrack.id).nextSample).toBe(videoAtPause);

    // Nothing new is delivered while extraction stays stopped, even on flush.
    mp4.flush();
    expect(audioProcessor.totalSamples).toBe(audioAtPause);
    expect(videoProcessor.totalSamples).toBe(videoAtPause);

    // Resume and run to the end of the file.
    for (const processor of processors) processor.paused = false;
    mp4.start();
    mp4.flush();

    // After draining, both cursors point one past the last sample of their track.
    expect(mp4.getTrackById(audioTrack.id).nextSample).toBe(
      mp4.getTrackById(audioTrack.id).samples.length,
    );
    expect(mp4.getTrackById(videoTrack.id).nextSample).toBe(
      mp4.getTrackById(videoTrack.id).samples.length,
    );

    const audioExpectation = buildExpectation(mp4, audioProcessor, setup.audioBatchSize);
    const videoExpectation = buildExpectation(mp4, videoProcessor, setup.videoBatchSize);

    expectBatchSizes(audioExpectation);
    expectBatchSizes(videoExpectation);
    expectOriginalSampleSequence(audioExpectation);
    expectOriginalSampleSequence(videoExpectation);

    // Delivery after the resume continues the original numbering at the pause boundary.
    expect(audioProcessor.sampleNumbers[audioAtPause]).toBe(
      audioExpectation.sampleNumbers[audioAtPause],
    );
    expect(videoProcessor.sampleNumbers[videoAtPause]).toBe(
      videoExpectation.sampleNumbers[videoAtPause],
    );
  });

  it('keeps per-track progress across pause and resume while data is streamed in', async () => {
    const { testFile } = getFilePath('isobmff', '01_simple.mp4');
    const fileSize = fs.statSync(testFile).size;
    const mp4 = createFile(true);

    // Stream the file in small chunks until the moov is parsed and extraction can start.
    const chunkSize = 8192;
    let start = 0;
    const ready = new Promise<Awaited<ReturnType<ISOFile['getInfo']>>>(resolve => {
      mp4.onReady = resolve;
    });
    while (start < fileSize) {
      const end = Math.min(start + chunkSize - 1, fileSize - 1);
      await getFileRange(testFile, data => mp4.appendBuffer(data), start, end);
      start += chunkSize;
      if (mp4.moov) break;
    }
    if (!mp4.moov) throw new Error('moov was not received while streaming the fixture');
    const info = await ready;

    const audioTrack = info.audioTracks[0];
    const videoTrack = info.videoTracks[0];
    if (!audioTrack || !videoTrack) {
      throw new Error('Test fixture must contain both an audio and a video track');
    }

    const setup = createProcessors(audioTrack.id, videoTrack.id, {
      audioPauseAfterBatch: 1,
      videoPauseAfterBatch: 1,
    });
    const { audioProcessor, videoProcessor } = attachProcessors(mp4, setup);
    const processors = [audioProcessor, videoProcessor];
    mp4.start();

    // Keep streaming the remaining data, resuming whenever a processor paused.
    for (; start < fileSize; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, fileSize - 1);
      await getFileRange(testFile, data => mp4.appendBuffer(data), start, end);
      if (processors.some(processor => processor.paused)) {
        for (const processor of processors) processor.paused = false;
        mp4.start();
      }
    }
    for (const processor of processors) processor.paused = false;
    mp4.flush();

    // Pause/resume really occurred during the streaming, at least once on each track.
    expect(audioProcessor.pauseMarkers.length).toBeGreaterThan(0);
    expect(videoProcessor.pauseMarkers.length).toBeGreaterThan(0);

    const audioExpectation = buildExpectation(mp4, audioProcessor, setup.audioBatchSize);
    const videoExpectation = buildExpectation(mp4, videoProcessor, setup.videoBatchSize);

    expectBatchSizes(audioExpectation);
    expectBatchSizes(videoExpectation);
    expectOriginalSampleSequence(audioExpectation);
    expectOriginalSampleSequence(videoExpectation);
  });
});
