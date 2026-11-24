import fs from 'fs';
import {
  createFile,
  DataStream,
  MP4BoxBuffer,
  type Box,
  type Item,
  type ISOFile,
  type Sample,
  type VisualSampleEntry,
} from '../entries/all';
import type { auxCBox } from '../src/boxes/auxC';
import type { hvcCBox } from '../src/boxes/hvcC';
import type { ispeBox } from '../src/boxes/ispe';
import { getFilePath, loadAndGetInfo } from './common';

/**
 * An editor hands a single coded image from a HEIF file to a playback chain
 * that only accepts video tracks by calling `itemToFragmentedTrackFile`:
 * the selected item becomes the sample description of a one-sample track.
 *
 * These tests pin down both ways of selecting the item — an explicit `itemId`
 * (the alpha auxiliary image of C006) and the default, which follows `pitm`
 * (the thumbnail that C005 marks primary) — and check that the resulting track
 * describes the selected image on its own, both in memory and after writing it
 * out and reading it back.
 */

interface HeifItemProperties {
  boxes: Array<Box>;
  auxC?: auxCBox;
  hvcC?: hvcCBox;
  ispe?: ispeBox;
}

// The item property boxes are attached to the sample entry as they are.
type OutputSampleEntry = VisualSampleEntry & { auxC?: auxCBox; ispe?: ispeBox };

function propertiesOf(item: Item) {
  return item.properties as HeifItemProperties;
}

async function loadHeifFixture(name: string) {
  const { testFile } = getFilePath('heif', name);
  // Keep the media data so the items' coded bytes are available to convert.
  const { mp4 } = await loadAndGetInfo(testFile, true, true);
  return { mp4, bytes: fs.readFileSync(testFile) };
}

/** Read the bytes backing an item straight from the file, not via getItem(). */
function itemBytes(bytes: Buffer, item: Item) {
  return Buffer.concat(
    item.extents.map(extent => bytes.subarray(extent.offset, extent.offset + extent.length)),
  );
}

function boxBytes(box: Box) {
  const stream = new DataStream();
  box.write(stream);
  return Buffer.from(stream.buffer);
}

/** Convert an item and describe the resulting single-sample track. */
function convertItem(mp4: ISOFile, itemId?: number) {
  const file = mp4.itemToFragmentedTrackFile(itemId === undefined ? {} : { itemId });
  if (!file) throw new Error(`Expected an output track for item ${itemId ?? '(primary)'}`);

  expect(file.moov.traks).toHaveLength(1);
  const trak = file.moov.traks[0];
  expect(trak.mdia.minf.stbl.stsd.entries).toHaveLength(1);
  // The output is plain ISO BMFF, not another item-based HEIF file.
  expect(file.meta).toBeUndefined();

  return { file, trak, entry: trak.mdia.minf.stbl.stsd.entries[0] as OutputSampleEntry };
}

/** Write the converted file, read it back and extract what a player would see. */
async function writeAndReparse(file: ISOFile) {
  const stream = new DataStream();
  file.write(stream);
  const binary = Buffer.from(stream.buffer);

  const reparsed = createFile(true);
  reparsed.appendBuffer(
    MP4BoxBuffer.fromArrayBuffer(
      binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength),
      0,
    ),
    true,
  );
  reparsed.flush();

  const info = reparsed.getInfo();
  expect(info.tracks).toHaveLength(1);
  expect(info.videoTracks).toHaveLength(1);

  const trackId = info.tracks[0].id;
  reparsed.setExtractionOptions(trackId, undefined, { nbSamples: 10 });
  const samples = await new Promise<Array<Sample>>(resolve => {
    reparsed.onSamples = (_id, _user, extracted) => resolve(extracted);
    reparsed.start();
  });

  return {
    info,
    entry: reparsed.moov.traks[0].mdia.minf.stbl.stsd.entries[0] as OutputSampleEntry,
    samples,
  };
}

/**
 * Check that a track describes `item` and that its only sample is `item`'s data.
 */
function expectTrackMatchesItem(
  trak: ISOFile['moov']['traks'][number],
  entry: OutputSampleEntry,
  item: Item,
  bytes: Buffer,
) {
  const properties = propertiesOf(item);

  // The output track is presented to the player as a video track.
  expect(trak.mdia.hdlr.handler).toBe('vide');
  expect(entry.type).toBe(item.type);
  expect(entry.getCodec()).toBeTruthy();
  expect(entry.width).toBe(properties.ispe.image_width);
  expect(entry.height).toBe(properties.ispe.image_height);
  expect(trak.tkhd.width >> 16).toBe(entry.width);
  expect(trak.tkhd.height >> 16).toBe(entry.height);

  expect(trak.samples).toHaveLength(1);
  expect(trak.samples[0].size).toBe(item.size);
  expect(Buffer.from(trak.samples[0].data)).toEqual(itemBytes(bytes, item));
}

/** C005: `pitm` designates the 128x72 thumbnail; the other item is 1280x720. */
function c005Items(mp4: ISOFile) {
  const primary = mp4.items[mp4.meta.pitm.item_id];
  const thumbnailRef = primary.ref_to.find(reference => reference.type === 'thmb');
  const fullSize = mp4.items[thumbnailRef.id.to_item_ID];
  return { primary, fullSize };
}

/** C006: `pitm` designates the image; a second item is its alpha mask. */
function c006Items(mp4: ISOFile) {
  const primary = mp4.items[mp4.meta.pitm.item_id];
  const auxiliaries = mp4.items.filter(
    item => item !== undefined && item.ref_to.some(reference => reference.type === 'auxl'),
  );
  expect(auxiliaries).toHaveLength(1);
  return { primary, aux: auxiliaries[0] };
}

describe('HEIF item to single-sample video track', () => {
  describe('when using the file primary image', () => {
    it('describes the primary item and carries only its data', async () => {
      const { mp4, bytes } = await loadHeifFixture('C005.heic');
      const { primary, fullSize } = c005Items(mp4);
      const properties = propertiesOf(primary);

      expect(primary.primary).toBe(true);
      expect(fullSize.primary).toBeUndefined();
      // The two items differ in size and dimensions, so picking the wrong one
      // cannot go unnoticed below.
      expect(fullSize.size).not.toBe(primary.size);
      expect(propertiesOf(fullSize).ispe.image_width).not.toBe(properties.ispe.image_width);

      const { file, trak, entry } = convertItem(mp4);
      expectTrackMatchesItem(trak, entry, primary, bytes);

      const { info, entry: reparsedEntry, samples } = await writeAndReparse(file);

      // A standalone video file whose description comes from the item.
      expect(info.tracks[0].type).toBe('video');
      expect(info.tracks[0].nb_samples).toBe(1);
      expect(info.tracks[0].codec).toBe(reparsedEntry.getCodec());
      expect(info.tracks[0].video).toEqual({
        width: properties.ispe.image_width,
        height: properties.ispe.image_height,
      });

      expect(reparsedEntry.type).toBe(primary.type);
      expect(boxBytes(reparsedEntry.hvcC)).toEqual(boxBytes(properties.hvcC));
      expect(boxBytes(reparsedEntry.ispe)).toEqual(boxBytes(properties.ispe));

      expect(samples).toHaveLength(1);
      expect(samples[0].size).toBe(primary.size);
      expect(Buffer.from(samples[0].data)).toEqual(itemBytes(bytes, primary));
    });

    it('does not adopt the auxiliary image of the same file', async () => {
      const { mp4, bytes } = await loadHeifFixture('C006.heic');
      const { primary, aux } = c006Items(mp4);

      const { trak, entry } = convertItem(mp4);
      expectTrackMatchesItem(trak, entry, primary, bytes);

      // The primary image has no auxiliary type, and its own decoder
      // configuration stays in place.
      expect(entry.auxC).toBeUndefined();
      expect(boxBytes(entry.hvcC)).toEqual(boxBytes(propertiesOf(primary).hvcC));
      expect(boxBytes(entry.hvcC)).not.toEqual(boxBytes(propertiesOf(aux).hvcC));
    });
  });

  describe('when explicitly selecting another image', () => {
    it('describes the requested item even when it is not the primary one', async () => {
      const { mp4, bytes } = await loadHeifFixture('C005.heic');
      const { primary, fullSize } = c005Items(mp4);
      const properties = propertiesOf(fullSize);

      const { file, trak, entry } = convertItem(mp4, fullSize.id);
      expectTrackMatchesItem(trak, entry, fullSize, bytes);

      // The track follows the request, not `pitm`.
      expect(entry.width).not.toBe(propertiesOf(primary).ispe.image_width);
      expect(trak.samples[0].size).not.toBe(primary.size);

      const { info, entry: reparsedEntry, samples } = await writeAndReparse(file);

      expect(info.tracks[0].nb_samples).toBe(1);
      expect(info.tracks[0].video).toEqual({
        width: properties.ispe.image_width,
        height: properties.ispe.image_height,
      });
      expect(boxBytes(reparsedEntry.hvcC)).toEqual(boxBytes(properties.hvcC));
      expect(boxBytes(reparsedEntry.ispe)).toEqual(boxBytes(properties.ispe));

      expect(samples).toHaveLength(1);
      expect(samples[0].size).toBe(fullSize.size);
      expect(Buffer.from(samples[0].data)).toEqual(itemBytes(bytes, fullSize));
    });

    it('keeps the coding method and auxiliary type of an alpha image', async () => {
      const { mp4, bytes } = await loadHeifFixture('C006.heic');
      const { primary, aux } = c006Items(mp4);
      const properties = propertiesOf(aux);
      const primaryProperties = propertiesOf(primary);

      expect(aux.id).not.toBe(primary.id);
      expect(aux.primary).toBeUndefined();
      expect(properties.auxC).toBeDefined();
      expect(primaryProperties.auxC).toBeUndefined();
      // The alpha mask is coded with its own hvcC; only the dimensions happen
      // to match the primary image.
      expect(boxBytes(properties.hvcC)).not.toEqual(boxBytes(primaryProperties.hvcC));
      expect(properties.ispe.image_width).toBe(primaryProperties.ispe.image_width);

      const { file, trak, entry } = convertItem(mp4, aux.id);
      expectTrackMatchesItem(trak, entry, aux, bytes);

      // The sample entry describes the mask itself: its own decoder
      // configuration, codec string and auxiliary type.
      expect(boxBytes(entry.hvcC)).toEqual(boxBytes(properties.hvcC));
      expect(entry.auxC).toBeDefined();
      expect(entry.auxC.aux_type).toBe(properties.auxC.aux_type);
      expect(entry.getCodec()).not.toBe(convertItem(mp4).entry.getCodec());

      // The unique sample is the mask, not the full-size image.
      expect(trak.samples[0].size).not.toBe(primary.size);

      const { info, entry: reparsedEntry, samples } = await writeAndReparse(file);

      expect(info.tracks[0].type).toBe('video');
      expect(info.tracks[0].nb_samples).toBe(1);
      expect(info.tracks[0].codec).toBe(reparsedEntry.getCodec());
      expect(info.tracks[0].video).toEqual({
        width: properties.ispe.image_width,
        height: properties.ispe.image_height,
      });

      expect(reparsedEntry.type).toBe(aux.type);
      expect(boxBytes(reparsedEntry.hvcC)).toEqual(boxBytes(properties.hvcC));
      expect(boxBytes(reparsedEntry.ispe)).toEqual(boxBytes(properties.ispe));
      expect(reparsedEntry.auxC).toBeDefined();
      expect(reparsedEntry.auxC.aux_type).toBe(properties.auxC.aux_type);

      expect(samples).toHaveLength(1);
      expect(samples[0].size).toBe(aux.size);
      expect(Buffer.from(samples[0].data)).toEqual(itemBytes(bytes, aux));
    });
  });
});
