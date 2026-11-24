import { createFile, MP4BoxBuffer, type ISOFile } from '../entries/all';

/**
 * HEIF item-location tests.
 *
 * A coded image item is an ordered list of extents. Those extents do not have
 * to be adjacent, and their physical storage order does not have to match the
 * order in `iloc`. Extents with construction_method 0 live in an `mdat` box;
 * extents with construction_method 1 live in the payload of an `idat` box.
 *
 * The fixture below deliberately stores the third logical extent first in the
 * file, puts metadata between media boxes, and shuffles bytes inside `idat`.
 * The assertions therefore check real reassembly, not a contiguous slice.
 */

const FILE_ITEM_ID = 101;
const IDAT_ITEM_ID = 202;

const ascii = (value: string) => new Uint8Array(Array.from(value, char => char.charCodeAt(0)));

const u8 = (...values: Array<number>) => Uint8Array.from(values);

const u16 = (value: number) => {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value);
  return bytes;
};

const u32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0);
  return bytes;
};

const cString = (value: string) => concat(ascii(value), u8(0));

function concat(...parts: Array<Uint8Array>): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function box(type: string, ...payload: Array<Uint8Array>): Uint8Array {
  const body = concat(...payload);
  return concat(u32(8 + body.length), ascii(type), body);
}

function fullBox(
  type: string,
  version: number,
  flags: number,
  ...payload: Array<Uint8Array>
): Uint8Array {
  return box(type, u32(((version << 24) | flags) >>> 0), ...payload);
}

/** Deterministic, tagged bytes make an offset/reassembly mistake obvious. */
function codedChunk(tag: string, seed: number, length = 16): Uint8Array {
  const bytes = new Uint8Array(length);
  const prefix = ascii(tag);
  bytes.set(prefix.subarray(0, Math.min(prefix.length, length)));
  for (let i = prefix.length; i < length; i++) {
    bytes[i] = (seed * 17 + i * 31) & 0xff;
  }
  return bytes;
}

function hdlrBox() {
  return fullBox('hdlr', 0, 0, u32(0), ascii('pict'), new Uint8Array(12), cString(''));
}

function infeBox(id: number, type: string, name: string) {
  // infe version 2: item_ID, protection_index, item_type, item_name.
  return fullBox('infe', 2, 0, u16(id), u16(0), ascii(type), cString(name));
}

function iinfBox(entries: Array<Uint8Array>) {
  return fullBox('iinf', 0, 0, u16(entries.length), concat(...entries));
}

function pitmBox(id: number) {
  return fullBox('pitm', 0, 0, u16(id));
}

interface IlocExtent {
  offset: number;
  length: number;
}

interface IlocItem {
  id: number;
  constructionMethod: 0 | 1;
  extents: Array<IlocExtent>;
}

function ilocBox(items: Array<IlocItem>) {
  const payload: Array<Uint8Array> = [
    u8(0x44), // offset_size = 4, length_size = 4
    u8(0x00), // base_offset_size = 0, index_size = 0
    u16(items.length),
  ];

  for (const item of items) {
    payload.push(u16(item.id));
    // iloc version 1 introduces construction_method in the low nibble.
    payload.push(u16(item.constructionMethod));
    payload.push(u16(0)); // data_reference_index = 0: this file
    payload.push(u16(item.extents.length));

    for (const extent of item.extents) {
      payload.push(u32(extent.offset));
      payload.push(u32(extent.length));
    }
  }

  return fullBox('iloc', 1, 0, ...payload);
}

interface HeifFixture {
  bytes: Uint8Array;
  expectedFileItem: Uint8Array;
  expectedIdatItem: Uint8Array;
}

function buildShuffledHeifFile(): HeifFixture {
  // Logical delivery order for the item whose extents are in mdat boxes.
  const filePart1 = codedChunk('FILE-1', 0x11);
  const filePart2 = codedChunk('FILE-2', 0x27);
  const filePart3 = codedChunk('FILE-3', 0x43);
  const expectedFileItem = concat(filePart1, filePart2, filePart3);

  // Logical delivery order for the item whose extents are in idat.
  const idatPart1 = codedChunk('IDAT-1', 0x55);
  const idatPart2 = codedChunk('IDAT-2', 0x71);
  const idatPart3 = codedChunk('IDAT-3', 0x89);
  const expectedIdatItem = concat(idatPart1, idatPart2, idatPart3);

  // Store idat bytes physically as 3, 1, 2 rather than logical 1, 2, 3.
  const idatPayload = concat(idatPart3, idatPart1, idatPart2);
  const idatPart1Offset = idatPart3.length;
  const idatPart2Offset = idatPart3.length + idatPart1.length;
  const idatPart3Offset = 0;

  const ftyp = box('ftyp', ascii('mif1'), u32(0), ascii('mif1'), ascii('heic'));

  // The third logical extent is physically before meta and the other mdats.
  const earlyMdat = box('mdat', filePart3);
  const mdat1 = box('mdat', filePart1);
  const mdat2 = box('mdat', filePart2);

  const itemInfos = iinfBox([
    infeBox(FILE_ITEM_ID, 'hvc1', 'mdat-backed coded image'),
    infeBox(IDAT_ITEM_ID, 'hvc1', 'idat-backed coded image'),
  ]);

  const buildMeta = (filePart1Offset: number, filePart2Offset: number) =>
    fullBox(
      'meta',
      0,
      0,
      hdlrBox(),
      pitmBox(FILE_ITEM_ID),
      itemInfos,
      box('idat', idatPayload),
      ilocBox([
        // Declare the idat item first to show that iloc item order is not file order.
        {
          id: IDAT_ITEM_ID,
          constructionMethod: 1,
          extents: [
            { offset: idatPart1Offset, length: idatPart1.length },
            { offset: idatPart2Offset, length: idatPart2.length },
            { offset: idatPart3Offset, length: idatPart3.length },
          ],
        },
        {
          id: FILE_ITEM_ID,
          constructionMethod: 0,
          extents: [
            { offset: filePart1Offset, length: filePart1.length },
            { offset: filePart2Offset, length: filePart2.length },
            // ftyp length + mdat header gives the payload start of earlyMdat.
            { offset: ftyp.length + 8, length: filePart3.length },
          ],
        },
      ]),
    );

  // iloc fields have fixed width, so a zero-offset preliminary meta has the
  // same size as the real one and can be used to calculate absolute offsets.
  const preliminaryMeta = buildMeta(0, 0);
  const mdat1Start = ftyp.length + earlyMdat.length + preliminaryMeta.length;
  const filePart1Offset = mdat1Start + 8;
  const filePart2Offset = filePart1Offset + mdat1.length;
  const meta = buildMeta(filePart1Offset, filePart2Offset);
  expect(meta.length).toBe(preliminaryMeta.length);

  return {
    bytes: concat(ftyp, earlyMdat, meta, mdat1, mdat2),
    expectedFileItem,
    expectedIdatItem,
  };
}

function readWholeFile(fixture: HeifFixture, keepMdatData: boolean): ISOFile {
  const mp4 = createFile(keepMdatData);
  mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(fixture.bytes.buffer, 0), true);
  mp4.flush();
  return mp4;
}

describe('HEIF item reading', () => {
  it('builds a fixture whose box order differs from iloc declaration order', () => {
    const fixture = buildShuffledHeifFile();
    const mp4 = readWholeFile(fixture, true);

    expect(mp4.boxes.map(box => box.type)).toEqual(['ftyp', 'mdat', 'meta', 'mdat', 'mdat']);
    expect(mp4.meta?.iloc?.items.map(item => item.item_ID)).toEqual([IDAT_ITEM_ID, FILE_ITEM_ID]);
    expect(mp4.meta?.idat?.start).toBeGreaterThan(0);
  });

  it.each([false, true])(
    'reassembles mdat and idat extents into the selected item bytes (keepMdatData=%s)',
    keepMdatData => {
      const fixture = buildShuffledHeifFile();
      const mp4 = readWholeFile(fixture, keepMdatData);

      const fileItem = mp4.getItem(FILE_ITEM_ID);
      const idatItem = mp4.getItem(IDAT_ITEM_ID);

      expect(fileItem?.size).toBe(fixture.expectedFileItem.length);
      expect(fileItem?.data).toEqual(fixture.expectedFileItem);

      expect(idatItem?.size).toBe(fixture.expectedIdatItem.length);
      expect(idatItem?.data).toEqual(fixture.expectedIdatItem);

      // The primary item is the mdat-backed item declared second in iloc.
      expect(mp4.getPrimaryItem()?.data).toEqual(fixture.expectedFileItem);
    },
  );

  it('rereads the complete selected bytes after releaseItem', () => {
    const fixture = buildShuffledHeifFile();
    const mp4 = readWholeFile(fixture, false);

    const fileItem = mp4.getItem(FILE_ITEM_ID);
    const idatItem = mp4.getItem(IDAT_ITEM_ID);
    expect(fileItem?.data).toEqual(fixture.expectedFileItem);
    expect(idatItem?.data).toEqual(fixture.expectedIdatItem);

    expect(mp4.releaseItem(FILE_ITEM_ID)).toBe(fixture.expectedFileItem.length);
    expect(mp4.releaseItem(IDAT_ITEM_ID)).toBe(fixture.expectedIdatItem.length);

    // Releasing clears the assembled buffer and extent progress. Reading again
    // must rebuild from the original locations rather than return empty bytes.
    expect(mp4.getItem(FILE_ITEM_ID)?.data).toEqual(fixture.expectedFileItem);
    expect(mp4.getItem(IDAT_ITEM_ID)?.data).toEqual(fixture.expectedIdatItem);
  });

  it('keeps another item intact when releasing and rereading the selected item', () => {
    const fixture = buildShuffledHeifFile();
    const mp4 = readWholeFile(fixture, true);

    expect(mp4.getItem(FILE_ITEM_ID)?.data).toEqual(fixture.expectedFileItem);
    const idatItem = mp4.getItem(IDAT_ITEM_ID);
    expect(idatItem?.data).toEqual(fixture.expectedIdatItem);

    mp4.releaseItem(FILE_ITEM_ID);

    expect(mp4.getItem(FILE_ITEM_ID)?.data).toEqual(fixture.expectedFileItem);
    expect(mp4.getItem(IDAT_ITEM_ID)).toBe(idatItem);
    expect(idatItem?.data).toEqual(fixture.expectedIdatItem);
  });
});
