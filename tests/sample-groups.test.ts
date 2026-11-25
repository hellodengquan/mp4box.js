import { type ISOFile, type Sample, type SampleGroup } from '../entries/all';
import { mfhdBox } from '../src/boxes/mfhd';
import { sbgpBox } from '../src/boxes/sbgp';
import { sgpdBox } from '../src/boxes/sgpd';
import { moofBox, trafBox } from '../src/boxes/defaults';
import { rollSampleGroupEntry } from '../src/boxes/samplegroups/roll';
import { tfhdBox } from '../src/boxes/tfhd';
import { trunBox } from '../src/boxes/trun';
import { TFHD_FLAG_DEFAULT_BASE_IS_MOOF, TRUN_FLAGS_SIZE } from '../src/constants';
import { getFilePath, loadAndGetInfo } from './common';

/**
 * Sample groups on a plain track followed by movie fragments.
 *
 * A sample-to-group box (`sbgp`) assigns runs of samples to descriptions, and
 * a sample-group-description box (`sgpd`) holds those descriptions. On a plain
 * track, both boxes live in `stbl`; in a fragment, they live in `traf`. The
 * index kept with each sample must say which of the two description boxes it
 * refers to: 1-based for the track's box, 0x10000 + n for the n-th entry of the
 * fragment's box, and 0 for "no group", which falls back to the default
 * description declared by the applicable `sgpd`.
 *
 * The fixture starts from a real video track and appends hand-built fragments
 * to it, so that every run, index and description is known exactly.
 */

const ROLL = 'roll';
const MOOF_START = 10_000;

/** A `roll` description; `roll_distance` identifies the entry in assertions. */
function roll(distance: number) {
  const entry = new rollSampleGroupEntry(ROLL);
  entry.description_length = 2;
  entry.roll_distance = distance;
  return entry;
}

/** Track- or fragment-level description box. Version 2 carries a default index. */
function createSgpd(rollDistances: Array<number>, defaultIndex?: number): sgpdBox {
  const box = new sgpdBox();
  box.version = defaultIndex === undefined ? 1 : 2;
  box.grouping_type = ROLL;
  box.default_length = 2;
  box.entries = rollDistances.map(roll);
  if (defaultIndex !== undefined) box.default_group_description_index = defaultIndex;
  return box;
}

/** Track- or fragment-level assignment of sample runs to description indices. */
function createSbgp(runs: Array<[sampleCount: number, groupDescriptionIndex: number]>): sbgpBox {
  const box = new sbgpBox();
  box.version = 0;
  box.grouping_type = ROLL;
  box.grouping_type_parameter = 0;
  box.entries = runs.map(([sample_count, group_description_index]) => ({
    sample_count,
    group_description_index,
  }));
  return box;
}

function createTraf(
  trackId: number,
  sampleSizes: Array<number>,
  groups: Array<sbgpBox>,
  descriptions: Array<sgpdBox>,
) {
  const traf = new trafBox();
  const tfhd = traf.addBox(new tfhdBox());
  tfhd.track_id = trackId;
  tfhd.flags = TFHD_FLAG_DEFAULT_BASE_IS_MOOF;
  for (const description of descriptions) traf.addBox(description);
  for (const group of groups) traf.addBox(group);
  const trun = traf.addBox(new trunBox());
  trun.flags = TRUN_FLAGS_SIZE;
  trun.sample_count = sampleSizes.length;
  trun.sample_size = sampleSizes;
  return traf;
}

/** Appends a movie fragment carrying one track fragment and lets the file index its samples. */
function appendMoof(mp4: ISOFile, traf: trafBox) {
  const moof = new moofBox();
  moof.start = MOOF_START;
  moof.addBox(new mfhdBox());
  moof.addBox(traf);
  mp4.moofs.push(moof);
  mp4.updateSampleLists();
}

/** The `roll/0` group of a sample. */
function groupOf(sample: Sample): SampleGroup {
  const groups = Object.values(sample.sample_groups ?? {}) as Array<SampleGroup>;
  const group = groups.find(candidate => candidate.grouping_type === ROLL);
  if (!group) throw new Error(`Sample ${sample.number} has no '${ROLL}' group`);
  return group;
}

/** What a sample's `roll` group resolves to, and which entry object it came from. */
function rollOf(sample: Sample) {
  const group = groupOf(sample);
  const description = group.description as rollSampleGroupEntry | undefined;
  return {
    index: group.group_description_index,
    distance: description?.roll_distance,
    description,
  };
}

async function loadTrackWithGroups(descriptions: Array<sgpdBox>, groups: Array<sbgpBox>) {
  const { testFile } = getFilePath('isobmff', '01_simple.mp4');
  const { mp4 } = await loadAndGetInfo(testFile, true);
  const trak = mp4.moov?.traks.find(candidate => candidate.mdia?.hdlr?.handler === 'vide');
  if (!trak) throw new Error('Missing video track');
  for (const description of descriptions) trak.mdia.minf.stbl.addBox(description);
  for (const group of groups) trak.mdia.minf.stbl.addBox(group);
  // The track was indexed when the file was parsed, before the groups existed.
  trak.sample_groups_info = undefined;
  mp4.buildTrakSampleLists(trak);
  return { mp4, trak, trackId: trak.tkhd.track_id };
}

describe('Sample groups across track and fragments', () => {
  it('attributes each sample to the description box of the track or of its fragment', async () => {
    const trackDescription = createSgpd([-1, 4]);
    const trackGroup = createSbgp([
      [50, 1],
      [200, 2],
    ]);
    const { mp4, trak, trackId } = await loadTrackWithGroups([trackDescription], [trackGroup]);

    const fragmentDescription = createSgpd([-7, -8]);
    const fragmentGroup = createSbgp([
      [2, 0x10001], // the fragment's 1st description
      [1, 1], // the track's 1st description, while inside a fragment
      [2, 0x10002], // the fragment's 2nd description
    ]);
    appendMoof(mp4, createTraf(trackId, [1, 1, 1, 1, 1], [fragmentGroup], [fragmentDescription]));

    // Track samples: the indices are plain 1-based references into the track's `sgpd`.
    expect(
      [0, 49, 50, 249].map(number => rollOf(trak.samples[number])).map(roll => roll.index),
    ).toEqual([1, 1, 2, 2]);
    expect(trak.samples[0].sample_groups?.['roll/0']?.description).toBe(
      trackDescription.entries[0],
    );
    expect(trak.samples[249].sample_groups?.['roll/0']?.description).toBe(
      trackDescription.entries[1],
    );

    // Fragment samples: the fragment's own indices select its `traf/sgpd`, a plain
    // index still selects the track's `stbl/sgpd`.
    const fragmentSamples = trak.samples.slice(250);
    expect(fragmentSamples.map(sample => rollOf(sample).index)).toEqual([
      0x10001, 0x10001, 1, 0x10002, 0x10002,
    ]);
    expect(fragmentSamples.map(sample => rollOf(sample).distance)).toEqual([-7, -7, -1, -8, -8]);
    expect(fragmentSamples[0].sample_groups?.['roll/0']?.description).toBe(
      fragmentDescription.entries[0],
    );
    expect(fragmentSamples[2].sample_groups?.['roll/0']?.description).toBe(
      trackDescription.entries[0],
    );
    expect(fragmentSamples[4].sample_groups?.['roll/0']?.description).toBe(
      fragmentDescription.entries[1],
    );
  });

  it('interprets runs the fragment does not cover with the declared default', async () => {
    // The track only declares a default description, no sample-to-group box.
    const trackDescription = createSgpd([3, 5], 2);
    const { mp4, trak, trackId } = await loadTrackWithGroups([trackDescription], []);

    // Every sample without an explicit group uses the declared default.
    expect(trak.samples.map(sample => rollOf(sample).index)).toEqual(
      new Array(trak.samples.length).fill(0),
    );
    expect(trak.samples[0].sample_groups?.['roll/0']?.description).toBe(
      trackDescription.entries[1],
    );

    // The first fragment assigns a group to its first two samples only. Its last
    // three samples are outside every run: the track's default covers them.
    appendMoof(mp4, createTraf(trackId, [1, 1, 1, 1, 1], [createSbgp([[2, 1]])], []));
    const firstFragment = trak.samples.slice(250, 255);
    expect(firstFragment.map(sample => rollOf(sample).index)).toEqual([1, 1, 0, 0, 0]);
    expect(firstFragment.map(sample => rollOf(sample).distance)).toEqual([3, 3, 5, 5, 5]);

    // The second fragment brings its own descriptions and defaults. Its samples
    // resolve against those, while the first fragment keeps its own sources.
    const secondDescription = createSgpd([9], 1);
    appendMoof(mp4, createTraf(trackId, [1, 1, 1], [createSbgp([[1, 0]])], [secondDescription]));
    const secondFragment = trak.samples.slice(255);
    expect(secondFragment.map(sample => rollOf(sample).index)).toEqual([0, 0, 0]);
    expect(secondFragment.map(sample => rollOf(sample).distance)).toEqual([9, 9, 9]);
    for (const sample of secondFragment) {
      expect(sample.sample_groups?.['roll/0']?.description).toBe(secondDescription.entries[0]);
    }

    expect(firstFragment[0].sample_groups?.['roll/0']?.description).toBe(
      trackDescription.entries[0],
    );
    expect(firstFragment[4].sample_groups?.['roll/0']?.description).toBe(
      trackDescription.entries[1],
    );
  });

  it('does not fail when the track only declares a default description', async () => {
    // A version 2 `sgpd` with no `sbgp` maps no run explicitly; its default is
    // the grouping rule for the whole track (as in the "static mapping" case).
    const trackDescription = createSgpd([11], 1);
    const { mp4, trak } = await loadTrackWithGroups([trackDescription], []);

    expect(() => mp4.buildTrakSampleLists(trak)).not.toThrow();
    for (const sample of trak.samples) {
      expect(rollOf(sample)).toMatchObject({ index: 0, distance: 11 });
    }
    expect(trak.samples.length).toBeGreaterThan(0);
  });

  it('leaves samples without any grouping declaration ungrouped', async () => {
    const { mp4, trak, trackId } = await loadTrackWithGroups([], []);

    appendMoof(mp4, createTraf(trackId, [1, 1], [], []));
    for (const sample of trak.samples.slice(-2)) {
      expect(sample.sample_groups).toBeUndefined();
    }
  });

  it('applies a fragment description default when the fragment has no sample-to-group box', async () => {
    const { mp4, trak, trackId } = await loadTrackWithGroups([], []);

    const fragmentDescription = createSgpd([12], 1);
    appendMoof(mp4, createTraf(trackId, [1, 1], [], [fragmentDescription]));

    for (const sample of trak.samples.slice(-2)) {
      const roll = rollOf(sample);
      expect(roll.index).toBe(0);
      expect(roll.description).toBe(fragmentDescription.entries[0]);
    }
  });

  it('parses fragment descriptions that keep their own size', async () => {
    // Version 1 `sgpd` gives each entry its length.
    const { mp4, trak, trackId } = await loadTrackWithGroups([], []);
    const fragmentDescription = createSgpd([-4, 6]);
    appendMoof(
      mp4,
      createTraf(
        trackId,
        [1, 1],
        [
          createSbgp([
            [1, 0x10001],
            [1, 0x10002],
          ]),
        ],
        [fragmentDescription],
      ),
    );

    const fragmentSamples = trak.samples.slice(-2);
    expect(fragmentSamples.map(sample => rollOf(sample).distance)).toEqual([-4, 6]);
  });
});
