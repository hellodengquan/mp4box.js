# 共享初始化段与单轨初始化段：轨道、时长和编码描述分析

本文结合 MP4Box.js 当前分段源码，说明同一份含一条音轨、一条视频轨的 MP4 素材，如何分别供给：

- **单轨缓冲区播放器**：每个 `SourceBuffer` / 解码缓冲区只接收一条轨道的初始化段和媒体片段，对应 `initializeSegmentation('per-track')`。
- **共用缓冲区播放器**：一个复用缓冲区接收包含全部轨道描述的初始化段，随后分别追加各轨道的 `moof + mdat`，对应默认的 `initializeSegmentation()` 或显式的 `initializeSegmentation('combined')`。

下面的轨道编号和时基取一组典型值：

| 素材轨道 | `track_id` | handler | 媒体时基 `mdhd.timescale` | 典型样本增量 | 单样本时长 | 编码描述 |
|---|---:|---|---:|---:|---:|---|
| 音轨 AAC | `1` | `soun` | `48000` | `1024` | `1024 / 48000 = 21.333 ms` | `mp4a` sample entry + `esds` |
| 视频轨 AVC | `2` | `vide` | `90000` | `3000` | `3000 / 90000 = 33.333 ms` | `avc1` sample entry + `avcC` |

这些数值是示例；实际文件应以各轨 `mdhd.timescale` 和样本表为准。源码不会把时基写死为 `48000` 或 `90000`。

---

## 1. 两种初始化方式各自交出的轨道

入口在 [`src/isofile.ts:1380-1455`](src/isofile.ts#L1380-L1455)。

参与初始化的轨道不是“原文件 `moov` 里的所有轨”，而是所有已经通过 `setSegmentOptions()` 注册到 `fragmentedTracks`、且仍能在当前文件中找到的轨道：

```ts
const tracksToInitialize = [];
for (const fragmentedTrack of this.fragmentedTracks) {
  const trak = this.getTrackById(fragmentedTrack.id);
  if (!trak) {
    Log.warn(...);
    continue;
  }
  tracksToInitialize.push({ id: fragmentedTrack.id, user: fragmentedTrack.user, trak });
}
```

见 [`src/isofile.ts:1400-1411`](src/isofile.ts#L1400-L1411)。因此，如果只对音轨调用了 `setSegmentOptions()`，无论原素材里有多少轨，两种初始化结果都只会包含音轨。

### 1.1 总览

| 使用方 | 调用 | 返回形态 | 初始化段中的 `trak` | `mvex/trex` |
|---|---|---|---|---|
| 单轨缓冲区 | `mp4.initializeSegmentation('per-track')` | 数组：`[{ id, user, buffer }, ...]` | 每个 buffer 只有一个被选中的 `trak` | 每个 buffer 只有与该轨对应的一个 `trex` |
| 共用复用缓冲区 | `mp4.initializeSegmentation()` 或 `mp4.initializeSegmentation('combined')` | 单个对象：`{ tracks: [{ id, user }], buffer }` | 一个 buffer 包含全部被选中的 `trak` | 每个选中轨道一个 `trex` |

返回类型定义见 [`entries/types.ts:129-143`](entries/types.ts#L129-L143)，README 说明见 [`README.md:292-316`](README.md#L292-L316)。

### 1.2 `per-track`：N 个独立初始化段

核心构造是为每条轨新建一个只放 `mvhd` 和当前 `trak` 的 `moov`：

```ts
if (mode === 'per-track') {
  return tracksToInitialize.map(({ id, user, trak }) => {
    const moov = new moovBox();
    moov.addBox(this.moov.mvhd);
    moov.addBox(trak);

    return {
      id,
      user,
      buffer: ISOFile.writeInitializationSegment(
        this.ftyp,
        moov,
        fragmentDuration,
        normalizeAudioSampleEntryTrackIds,
      ),
    };
  });
}
```

见 [`src/isofile.ts:1420-1437`](src/isofile.ts#L1420-L1437)。

对示例素材，得到两个对象：

```text
音频初始化段 init-audio
└─ ftyp
└─ moov
   ├─ mvhd
   ├─ trak(track_id=1)
   │  └─ mdia
   │     ├─ mdhd(timescale=48000)
   │     └─ minf/stbl/stsd/mp4a/esds
   └─ mvex
      └─ trex(track_id=1, default_sample_duration=1024, ...)

视频初始化段 init-video
└─ ftyp
└─ moov
   ├─ mvhd
   ├─ trak(track_id=2)
   │  └─ mdia
   │     ├─ mdhd(timescale=90000)
   │     └─ minf/stbl/stsd/avc1/avcC
   └─ mvex
      └─ trex(track_id=2, default_sample_duration=3000, ...)
```

每个 buffer 都以同一个 `ftyp` 对象的序列化结果开头，因此每个单轨初始化段都能独立交给对应播放器。

测试 “with one init segment per fragmented track” 明确验证：两个分段轨道会产生两个初始化段；每段重新解析后只有一个 track、一个 `trex`，且 ID 与返回对象一致，见 [`tests/segmentation.test.ts:369-396`](tests/segmentation.test.ts#L369-L396)。

### 1.3 `combined` / 默认方式：一个包含全部轨道的共享初始化段

共享方式只创建一个 `moov`，加入共享的 `mvhd`，然后依次加入所有选中轨道：

```ts
const moov = new moovBox();
moov.addBox(this.moov.mvhd);
for (const track of tracksToInitialize) {
  moov.addBox(track.trak);
}

return {
  tracks: tracksToInitialize.map(({ id, user }) => ({ id, user })),
  buffer: ISOFile.writeInitializationSegment(
    this.ftyp,
    moov,
    fragmentDuration,
    normalizeAudioSampleEntryTrackIds,
  ),
};
```

见 [`src/isofile.ts:1439-1454`](src/isofile.ts#L1439-L1454)。

示例素材的共享初始化段为：

```text
shared-init
├─ ftyp
└─ moov
   ├─ mvhd
   ├─ trak(track_id=1)
   │  ├─ mdhd(timescale=48000)
   │  └─ stsd/mp4a/esds
   ├─ trak(track_id=2)
   │  ├─ mdhd(timescale=90000)
   │  └─ stsd/avc1/avcC
   └─ mvex
      ├─ trex(track_id=1, default_sample_description_index=1,
      │       default_sample_duration=1024, ...)
      └─ trex(track_id=2, default_sample_description_index=1,
               default_sample_duration=3000, ...)
```

显式 `'combined'` 与无参数默认值等价。测试验证二者返回的 track ID 列表一致，且解析出的初始化段包含两条轨，见 [`tests/segmentation.test.ts:398-422`](tests/segmentation.test.ts#L398-L422)。

需要注意：**combined 只合并初始化描述，不把音视频样本合进同一个 `moof`。** 后续 `onSegment` 仍按 `id` 逐条给出单轨 `moof + mdat`。`createMoof()` 甚至会拒绝混合不同 `track_id` 的样本，见 [`src/isofile.ts:2992-3000`](src/isofile.ts#L2992-L3000)。共用缓冲区播放器是在同一个复用缓冲区中依次接收“包含两条轨描述的 init”和“只描述某一条轨的媒体片段”。

---

## 2. 初始化段保留了什么、清空了什么

第一次调用 `initializeSegmentation()` 时会执行：

```ts
if (!this.isFragmentationInitialized) {
  this.isFragmentationInitialized = true;
  this.resetTables();
}
```

见 [`src/isofile.ts:1395-1398`](src/isofile.ts#L1395-L1398)。

`resetTables()` 会把电影头、轨头和媒体头中的持续时间置零，并清空原普通 MP4 的样本表：

- `mvhd.duration`、`tkhd.duration`、`mdhd.duration` 置零；
- 清空 `stco/co64.chunk_offsets`；
- 清空 `stsc`；
- 清空 `stsz/stz2.sample_sizes`；
- 清空 `stts.sample_counts/sample_deltas`；
- 清空 `ctts`；
- 移除 `stss` 同步样本表。

见 [`src/isofile.ts:1473-1500`](src/isofile.ts#L1473-L1500)。

但它**不修改 `mdhd.timescale`，也不清空 `stsd.entries`**。所以初始化段仍然保留：

1. 每条轨自己的媒体时基；
2. 样本入口和解码器配置，例如 `mp4a/esds`、`avc1/avcC`；
3. 音视频的宽高、声道、采样率等 sample entry 字段。

这正是接收端解释后续片段所需的两类静态信息：**时间单位**和**编码描述**。

另外，`resetTables()` 清空的是将要序列化的 box 表，并不清空 `trak.samples` 这个 JavaScript 样本记录数组。这一点对理解 `trex.default_sample_duration` 的来源非常关键。

---

## 3. `trex` 中的“新片段默认参数”从哪里来

`writeInitializationSegment()` 为传入 `moov` 中的每条轨添加一个 `trex`：

```ts
const mvex = moov.addBox(new mvexBox());
if (total_duration) {
  const mehd = mvex.addBox(new mehdBox());
  mehd.fragment_duration = total_duration;
}

for (let i = 0; i < moov.traks.length; i++) {
  const trex = mvex.addBox(new trexBox());
  trex.track_id = moov.traks[i].tkhd.track_id;
  trex.default_sample_description_index = 1;
  trex.default_sample_duration = moov.traks[i].samples[0]?.duration ?? 0;
  trex.default_sample_size = 0;
  trex.default_sample_flags = 1 << 16;
}
```

见 [`src/isofile.ts:1292-1307`](src/isofile.ts#L1292-L1307)。

这四个 `default_*` 是给 movie fragment 用的回退参数：

| `trex` 字段 | 当前分段器设置的值 | 含义 |
|---|---:|---|
| `default_sample_description_index` | `1` | 当 `tfhd` 没有显式指定 description index 时，使用 `stsd` 中第 1 个样本入口；ISO 索引从 1 开始 |
| `default_sample_duration` | `trak.samples[0]?.duration ?? 0` | 仅当 `tfhd` 和 `trun` 都没有给出时长时作为回退；值来自原素材第一条样本的 JS 记录 |
| `default_sample_size` | `0` | 没有默认可用大小；当前分段器生成的 `trun` 总会显式写每个样本大小 |
| `default_sample_flags` | `1 << 16`（`0x00010000`） | 按 MP4Box 解析逻辑，该位表示 non-sync；当前分段器生成的 `trun` 会显式写每个样本 flags |

`trex` 的二进制字段顺序见 [`src/boxes/trex.ts:14-33`](src/boxes/trex.ts#L14-L33)。

因此，示例中的两个默认时长分别是：

```text
trex(track_id=1).default_sample_duration = 原素材音轨 samples[0].duration = 1024
trex(track_id=2).default_sample_duration = 原素材视频轨 samples[0].duration = 3000
```

这并不表示“新片段中的所有样本永远都是 1024 或 3000”。它只是写入初始化段的默认回退值。

---

## 4. 原素材的样本记录不是新片段的默认参数

### 4.1 原素材样本记录的构造

解析普通 MP4 时，`buildTrakSampleLists()` 根据原始样本表逐条构造 `trak.samples[]`：

```ts
const sample = {
  number: j,
  track_id: trak.tkhd.track_id,
  timescale: trak.mdia.mdhd.timescale,
  alreadyRead: 0,
  size: stsz.sample_sizes[j],
} as Sample;
```

见 [`src/isofile.ts:1695-1702`](src/isofile.ts#L1695-L1702)。

随后补充：

- 编码描述索引和对象：

  ```ts
  sample.description_index =
    stsc.sample_description_index[sample.chunk_run_index] - 1;
  sample.description = stsd.entries[sample.description_index];
  ```

  见 [`src/isofile.ts:1754-1755`](src/isofile.ts#L1754-L1755)。这里转成了 **0-based** 索引。

- DTS 和 duration，来自 `stts`：见 [`src/isofile.ts:1761-1775`](src/isofile.ts#L1761-L1775)。
- CTS / composition offset，来自 `ctts`：见 [`src/isofile.ts:1776-1787`](src/isofile.ts#L1776-L1787)。
- 同步样本标记，来自 `stss`；没有 `stss` 时认为都是 sync：见 [`src/isofile.ts:1788-1806`](src/isofile.ts#L1788-L1806)。
- 最后一条样本的 duration 会用 `mdhd.duration - last_dts` 做尾部修正：见 [`src/isofile.ts:1823-1826`](src/isofile.ts#L1823-L1826)。

所以，“原素材的样本记录”是解析后存在于内存中的、逐样本的 `Sample` 对象，包含真实的 `duration`、`size`、`dts/cts`、`description_index`、`is_sync` 和 `timescale`。

### 4.2 与初始化段参数的区别

| 信息 | 原素材记录 | 新初始化段 / 新片段 |
|---|---|---|
| 时基 | `mdhd.timescale`，并复制到每个 `Sample.timescale` | `mdhd.timescale` 原样保留；`trex` 不另设时基 |
| 样本时长 | 每个 `Sample.duration` 可能不同；末帧可能是修正值 | `trex.default_sample_duration` 只复制 `samples[0].duration`；实际值仍由新 `trun` 逐条写出 |
| 样本大小 | `stsz` → 每个 `Sample.size` | `trex.default_sample_size=0`；新 `trun` 逐条写 `sample_size` |
| 样本 flags | `stss/sdtp` 等 → `Sample.is_sync` 等 | `trex` 给 non-sync 默认 flags；新 `trun` 逐条写 `sample_flags` |
| 编码描述 | `stsc` 给出每个样本的 1-based entry index，代码转成 `Sample.description_index`（0-based） | `stsd` 整体保留；`trex.default_sample_description_index=1`（1-based）作为片段默认值 |
| 时间戳 | `stts/ctts` 构造出的 `dts/cts` | 新片段写 `tfdt` 和 `trun` 的 duration / composition offset |
| 原始样本表 box | `stts/stsz/stsc/stco/...` | `resetTables()` 清空这些表，输出碎片化布局所需的空表和 `mvex/trex` |

一句话：**`samples[0].duration` 是从原素材第一条样本“借”来作为 `trex` 默认值的；它不是重新计算出的片段固定帧长，也不代表后续每条新片段样本都相等。真正的逐样本参数在生成的 `trun` 中。**

---

## 5. 新媒体片段实际写出了什么

当样本可用并到达分段边界时，`processSamples()` 调用 `createFragment()`，随后通过 `onSegment(id, user, buffer, ...)` 回调，见 [`src/isofile.ts:855-910`](src/isofile.ts#L855-L910)。

`createFragment()` 先按样本号从 `trak.samples` 取回原始记录，再调用 `createMoof()`，见 [`src/isofile.ts:1229-1247`](src/isofile.ts#L1229-L1247)。

`createMoof()` 写出的关键字段如下：

```ts
const tfhd = traf.addBox(new tfhdBox());
tfhd.track_id = trackId;
tfhd.flags = TFHD_FLAG_DEFAULT_BASE_IS_MOOF;

const tfdt = traf.addBox(new tfdtBox());
tfdt.baseMediaDecodeTime = samples[0].dts - (trak.first_dts || 0);

const trun = traf.addBox(new trunBox());
trun.flags =
  TRUN_FLAGS_DATA_OFFSET |
  TRUN_FLAGS_DURATION |
  TRUN_FLAGS_SIZE |
  TRUN_FLAGS_FLAGS |
  TRUN_FLAGS_CTS_OFFSET;

for (const sample of samples) {
  ...
  trun.sample_duration.push(sample.duration);
  trun.sample_size.push(sample.size);
  trun.sample_flags.push(sample_flags);
  trun.sample_composition_time_offset.push(sample.cts - sample.dts);
}
```

见 [`src/isofile.ts:3017-3046`](src/isofile.ts#L3017-L3046)。

因此，MP4Box.js 当前生成的片段：

- `tfhd` 只设置 `track_id` 和 `default-base-is-moof`（`0x020000`）；
- **没有**设置 `TFHD_FLAG_SAMPLE_DESC`（`0x02`）；
- **没有**设置 `TFHD_FLAG_SAMPLE_DUR`（`0x08`）；
- `trun` 总是带 `sample_duration`、`sample_size`、`sample_flags` 和 CTS offset。

这意味着 `trex` 中的 duration/size/flags 在这些由 MP4Box.js 新生成的片段里主要是规范要求的默认项和兼容回退；正常解析时，`trun` 的逐样本字段优先。

---

## 6. 接收端如何解释样本时长

MP4Box.js 自己的碎片化解析逻辑就是一份清晰的接收端参考实现，位于 `updateSampleLists()`。

### 6.1 先用 `tfhd.track_id` 找到轨道和 `trex`

```ts
const trak = this.getTrackById(traf.tfhd.track_id);
const trex = this.getTrexById(traf.tfhd.track_id);
```

见 [`src/isofile.ts:1851-1853`](src/isofile.ts#L1851-L1853)。

这一步把媒体片段绑定到初始化段中的：

- `trak/mdia/mdhd/timescale`；
- `trak/mdia/minf/stbl/stsd`；
- 同 ID 的 `trex`。

### 6.2 默认值的覆盖顺序

时长解析顺序为：

```ts
if (traf.tfhd.flags & TFHD_FLAG_SAMPLE_DUR) {
  default_sample_duration = traf.tfhd.default_sample_duration;
} else {
  default_sample_duration = trex ? trex.default_sample_duration : 0;
}

...

let duration = default_sample_duration;
if (trun.flags & TRUN_FLAGS_DURATION) {
  duration = trun.sample_duration[k];
}
```

见 [`src/isofile.ts:1859-1863`](src/isofile.ts#L1859-L1863) 和 [`src/isofile.ts:1910-1913`](src/isofile.ts#L1910-L1913)。

优先级可以概括为：

```text
trun.sample_duration[k]
    > tfhd.default_sample_duration（仅当 tfhd 设置 0x08）
    > trex.default_sample_duration
    > 0
```

样本最终还会带上所属轨的时基：

```ts
const sample = {
  ...
  duration,
  timescale: trak.mdia.mdhd.timescale,
  track_id: trak.tkhd.track_id,
};
```

见 [`src/isofile.ts:1942-1955`](src/isofile.ts#L1942-L1955)。

### 6.3 必须使用对应轨的 `mdhd.timescale`

样本物理时长为：

```text
duration_seconds = trun.sample_duration[k] / trak.mdia.mdhd.timescale
```

不能统一使用 `mvhd.timescale`。`mvhd` 是电影级时间线，而 `mdhd` 是每条媒体轨自己的时间基；音轨和视频轨时基不同是正常现象。

对示例：

```text
音轨：1024 / 48000 = 0.021333... s
视频：3000 / 90000 = 0.033333... s
```

解码时间和呈现时间可按下列关系理解：

```text
DTS_k = tfdt.baseMediaDecodeTime + Σ(j<k) duration_j
CTS_k = DTS_k + trun.sample_composition_time_offset[k]
时间_秒 = DTS_k 或 CTS_k / 该轨 mdhd.timescale
```

如果视频是可变帧率，`trun` 中每个 duration 可能不同；如果有 B 帧，CTS offset 也可能不为零。初始化段中的 `trex.default_sample_duration` 仍只是第一条原样本时长的副本，不能替代 `trun`。

浏览器 MSE/媒体管线虽然内部实现不同，但读取的是同一套 ISO BMFF 规则：初始化段建立 track ID、时基、解码器描述和 `trex` 默认值，媒体片段中的 `tfhd/tfdt/trun` 再给出本片段的时间信息。

---

## 7. 接收端如何找到编码描述

### 7.1 description index 的解析顺序

MP4Box.js 解析片段时先确定 1-based 的 description index：

```ts
if (traf.tfhd.flags & TFHD_FLAG_SAMPLE_DESC) {
  default_sample_description_index =
    traf.tfhd.default_sample_description_index;
} else {
  default_sample_description_index = trex
    ? trex.default_sample_description_index
    : 1;
}
```

见 [`src/isofile.ts:1854-1858`](src/isofile.ts#L1854-L1858)。

然后转成 0-based 下标并从初始化段保留的 `stsd.entries` 中取对象：

```ts
const description_index = default_sample_description_index - 1;
...
description: trak.mdia.minf.stbl.stsd.entries[description_index],
```

见 [`src/isofile.ts:1895`](src/isofile.ts#L1895) 和 [`src/isofile.ts:1942-1946`](src/isofile.ts#L1942-L1946)。

编码描述的定位链是：

```text
tfhd.track_id
  → 对应 trak
  → tfhd.default_sample_description_index（若存在）
     否则 trex.default_sample_description_index
  → 减 1 得到 stsd.entries 下标
  → sample entry 中的 esds / avcC / hvcC / av1C / ...
```

当前 MP4Box.js 分段器生成的 `tfhd` 不带 sample-description flag，所以总是使用：

```text
trex.default_sample_description_index = 1
  → stsd.entries[0]
```

对常见的“一条轨只有一个编码配置”的素材，这没有问题。初始化段中的 sample entry 才包含真正的解码器初始化字节，例如：

- AAC：`mp4a` 内的 `esds` / `AudioSpecificConfig`；
- AVC：`avc1` 内的 `avcC`，其中有 SPS/PPS、profile/level 等；
- HEVC：`hvc1` 或 `hev1` 内的 `hvcC`；
- AV1：`av01` 内的 `av1C`。

MSE 创建 `SourceBuffer` 时还需要 codecs MIME 字符串；MP4Box.js 的 `getInfo()` 会从 sample entry 计算 `track.codec`，并汇总 `movie.mime`，见 [`src/isofile.ts:654-668`](src/isofile.ts#L654-L668) 和 [`src/isofile.ts:734-747`](src/isofile.ts#L734-L747)。但真正供初始化解码器的二进制配置仍在 `stsd` 内。

### 7.2 多 sample description 的边界

原始普通文件可以通过 `stsc.sample_description_index` 让不同样本使用不同 sample description；该索引保存在每条 `Sample.description_index` 中。

但当前 `initializeSegmentation()` 路径把 `trex.default_sample_description_index` 固定为 `1`，而 `createMoof()` 又没有把每个原样本的 `description_index` 写成 `tfhd.default_sample_description_index`。因此，当前分段输出实际上依赖“每条被分段轨道使用同一个 sample description”这一常见前提。若原素材在同一条轨中切换编码配置，需要额外在 `tfhd` 中写出 description index 或使用片段内 sample group 等机制；不能仅凭现在的 `trex=1` 认为每个原样本的描述切换都已保留。

### 7.3 QuickTime `wave.esds` 音频兼容处理

对于放在 QuickTime 风格 `wave` 盒里的 ESDS，MP4Box.js 默认会在写初始化段时临时把它提升为 `mp4a` 下的直接 `esds`，以提高 MSE 兼容性：

- `setSegmentOptions()` 中 `normalizeAudioSampleEntriesForMSE` 默认为 `true`，见 [`src/isofile.ts:253-258`](src/isofile.ts#L253-L258)；
- 初始化时收集未显式关闭规范化的轨道 ID，见 [`src/isofile.ts:1413-1418`](src/isofile.ts#L1413-L1418)；
- `normalizeAudioSampleEntriesForMSEFragmentedInit()` 临时修改并注册恢复逻辑，见 [`src/isofile.ts:1335-1377`](src/isofile.ts#L1335-L1377)；
- `finally` 中恢复源对象，见 [`src/isofile.ts:1309-1313`](src/isofile.ts#L1309-L1313)。

两种初始化模式传入的是同一个 `normalizeAudioSampleEntryTrackIds`，所以该音频规范化对 per-track 和 combined 输出同时生效。相关行为测试见 [`tests/segmentation.test.ts:424-495`](tests/segmentation.test.ts#L424-L495)。

---

## 8. 同一份素材同时服务两类播放器

推荐数据流如下：

```text
material.mp4
  │
  ▼
MP4Box.createFile(true)
  │  （true 保留媒体数据；moov 位于文件尾部时尤其重要）
  ├─ setSegmentOptions(audioId, route, { nbSamples, ... })
  ├─ setSegmentOptions(videoId, route, { nbSamples, ... })
  │
  ├─ initializeSegmentation('per-track')
  │    ├─ audio init  → 单轨音频 SourceBuffer
  │    └─ video init  → 单轨视频 SourceBuffer
  │
  ├─ initializeSegmentation('combined')
  │    └─ shared init → 一个 codecs 包含音视频的共用 SourceBuffer
  │
  ├─ mp4.onSegment = (id, user, buffer, nextSample, last) => {
  │      按 id 找到单轨 SourceBuffer，排队追加；
  │      同时向共用 SourceBuffer 排队追加。
  │    }
  │
  └─ mp4.start()
```

实现时注意：

1. **单轨播放器使用 per-track init**：音频缓冲区只收 `id=1` 的 init 和后续 `id=1` segment，视频同理。
2. **共用播放器使用 combined init**：只追加一次 combined buffer；之后 `id=1`、`id=2` 的 segment 都进入同一个复用缓冲区。
3. **MIME/codecs 要匹配**：
   - 单轨音频缓冲区使用音频 codec；
   - 单轨视频缓冲区使用视频 codec；
   - 共用缓冲区的 MIME 必须同时声明音频和视频 codec。
4. **媒体片段按 ID 路由**：`onSegment` 的第一个参数就是轨道 ID，`user` 来自对应的 `setSegmentOptions()`。
5. **MSE 追加必须排队**：等待 `updateend` 后再追加下一块，不能并发调用 `appendBuffer()`。
6. 如果同一个 `ArrayBuffer` 要交给两个可能转移或分离 buffer 的运行时，应为不同目标复制数据，避免一侧消费后另一侧拿到 detached buffer。
7. 也可以为两类播放器分别建立 MP4Box.js 解析实例；盒结构解释完全相同，区别只是调用哪种初始化模式以及如何路由 `onSegment`。

不要交叉使用初始化段：

- 不要把 combined init 放进只声明了单个 codec 的单轨缓冲区；
- 不要只把音频 per-track init 放进共用缓冲区后再期待视频片段拥有编码描述；
- 共用缓冲区必须先收到包含两条 `trak` 和两个 `trex` 的 combined init，才能解释后续两个 track ID 的片段。

---

## 9. 结论

- `initializeSegmentation('per-track')` 交出 **N 个初始化段**，每段一条 `trak`、一个对应 `trex`，适合音视频各自独立的单轨缓冲区。
- `initializeSegmentation('combined')`（含默认调用）交出 **一个初始化段**，其中包含所有通过 `setSegmentOptions()` 注册的轨道及对应 `trex`，适合一个音视频共用的复用缓冲区。
- 两种方式都保留各轨 `mdhd.timescale` 和 `stsd` 编码描述，并通过 `trex.track_id` / `tfhd.track_id` 与后续片段关联。
- 接收端按“`trun` 字段优先，其次 `tfhd` 默认值，最后 `trex` 默认值”的顺序解析时长；再除以对应轨的 `mdhd.timescale` 得到秒数。
- 编码描述按“`tfhd` description index 或 `trex` 的 `1` → `stsd.entries[index-1]` → `esds/avcC/...`”定位。
- 原素材的 `trak.samples[]` 是逐样本真实记录；`trex.default_sample_duration` 只是把其中 `samples[0].duration` 复制为回退默认值。MP4Box.js 新生成片段的真实时长、大小、flags 和时间偏移仍逐条写在 `trun` 中。
