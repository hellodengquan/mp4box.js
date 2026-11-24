# 负的合成时间偏移在分片写回中的丢失

本文分析 mp4box.js 在「把一个带重排帧（B 帧）的时间线写成连续 MP4 片段，再重新打开」这条路径上
对合成时间偏移（composition time offset / CTTS）的二进制编码，并用一个跨片段的数字例子说明
哪些表示能保留原时间线、哪些会让播放器得到不同的显示次序。

结论先行：

- **非分片重写是安全的**：`ctts` 写入时会自己检查偏移符号并选 `version=1`
  （`src/boxes/ctts.ts:40`），所以同一批样本写成普通 MP4 后重开，显示次序不变。
- **分片写回不安全**：`createMoof()` 把 `cts - dts` 交给 `trun`，但从不设置 `trun.version`，
  而 `FullBox.version` 默认是 0（`src/box.ts:199`）。`trun` 的 version 0 语义是**无符号** 32 位
  （`src/boxes/trun.ts:58-62`、`109-113`），于是任何负偏移都会以 0xFFFFFF.. 的形式落盘，
  被自己和播放器读成一个接近 2^32 的巨大正偏移。
- 本库自己的解析器还额外忽略**除第一个 traf 之外**的 `tfdt`（`src/isofile.ts:1917-1927`），
  所以跨片段的解码时间间隙在「用本库重开」时会消失。写出的 `tfdt` 字节本身是对的，
  但这一点决定了「什么条件下二进制能保留时间线」必须同时考虑 `trun` 与 `tfdt`。

---

## 1. 写回路径

视频编辑器通常走两条 API 之一，二者最终都汇到 `ISOFile.createMoof()`：

| 路径 | 入口 | 说明 |
| --- | --- | --- |
| 逐样本追加 | `addSample()`（`src/isofile.ts:2913`） | 每个样本立即生成一个 `moof`+`mdat`（`src/isofile.ts:2980`） |
| 分段写回 | `setSegmentOptions()` + `initializeSegmentation()` + `start()` → `createFragment()`（`src/isofile.ts:1215`） | 每 N 个样本一个 `moof`，多个 `moof` 累积成一个 segment |

`createMoof()`（`src/isofile.ts:2992`）写入的定时信息只有三处：

```
src/isofile.ts:3022   tfdt.baseMediaDecodeTime = samples[0].dts - (trak.first_dts || 0);
src/isofile.ts:3026   trun.flags = DATA_OFFSET | DURATION | SIZE | FLAGS | CTS_OFFSET;
src/isofile.ts:3045   trun.sample_composition_time_offset.push(sample.cts - sample.dts);
```

注意这里没有任何一处根据偏移的符号去选版本：

```
src/boxes/trun.ts:108-114
      if (this.flags & TRUN_FLAGS_CTS_OFFSET) {
        if (this.version === 0) {
          stream.writeUint32(this.sample_composition_time_offset[i]);
        } else {
          stream.writeInt32(this.sample_composition_time_offset[i]); //signed
        }
      }
```

而 `trunBox` 继承 `FullBox`，`version` 初值为 0（`src/box.ts:199`），`createMoof()` 也没有赋值，
所以**分片输出里的每个 `trun` 都是 version 0**，无论偏移是正是负。

对比 `ctts` 的写入：

```
src/boxes/ctts.ts:40
    this.version = this.sample_offsets.some(offset => offset < 0) ? 1 : 0;
```

同样的 `cts - dts` 数据，走 `ctts` 会得到 version 1 + `writeInt32`，走 `trun` 得到 version 0 +
`writeUint32`。两者的磁盘比特其实**完全相同**（-40 → `ff ff ff d8`，见 §5），差别只在版本位。

还有一层：分片初始化段会清空 `moov` 里的 `stts`/`ctts` 内容
（`ISOFile.resetTables()`，`src/isofile.ts:1473-1495`），所以分片文件里**唯一**承载显示时间的
就是 `trun.sample_composition_time_offset`。一旦这里编码错，`moov` 里没有 `ctts` 可以补救。

## 2. 解析路径

重新打开时，两处代码决定 cts：

- 分片：`src/isofile.ts:1930-1933`

  ```
  let cts = dts;
  if (trun.flags & TRUN_FLAGS_CTS_OFFSET) {
    cts = dts + trun.sample_composition_time_offset[k];
  }
  ```

- 非分片：`src/isofile.ts:1776-1786`（走 `ctts.sample_offsets`）

`trun.sample_composition_time_offset[k]` 的正负完全由 `trun.version` 决定
（`src/boxes/trun.ts:58-62`）：

```
if (this.version === 0) this.sample_composition_time_offset[i] = stream.readUint32();
else                    this.sample_composition_time_offset[i] = stream.readInt32();
```

这里和 `ctts` 的解析还不一致：`ctts` 即使在 version 0 也按有符号读，并且对负值只发一条警告
（`src/boxes/ctts.ts:22-27`），因此对「版本位写错的旧文件」有容错；`trun` 没有这个容错。

## 3. 跨片段数字例子

时间刻度 `timescale = 1000`，每帧 `duration = 40`。解码顺序为 I P B1 B2，显示顺序为 I B1 B2 P：

| 样本 | 角色 | dts | cts | cts − dts |
| --- | --- | --- | --- | --- |
| s0 | I | 0 | 0 | 0 |
| s1 | P | 40 | 120 | +80 |
| s2 | B1 | 80 | 40 | **−40** |
| s3 | B2 | 120 | 80 | **−40** |

用 `setSegmentOptions({ nbSamplesPerFragment: 2, rapAlignement: false })` 切成两个片段：
片段 1 = [s0, s1]，片段 2 = [s2, s3]。`createMoof()` 实际写出的字节（每个样本 4 字节负载；
`data_offset = 0x7c` 是 `moof` 长度 116 加 8 字节 `mdat` 头，与时间无关）：

```
片段 1  trun  v=0  flags=0x0f01  count=2
  00 00 00 34  74 72 75 6e | 00 00 0f 01 | 00 00 00 02 | 00 00 00 7c
  s0: 00 00 00 28 | 00 00 00 04 | 02 00 00 00 | 00 00 00 00      duration=40 size=4 flags  cto=0
  s1: 00 00 00 28 | 00 00 00 04 | 00 01 00 00 | 00 00 00 50      duration=40 size=4 flags  cto=+80
片段 1  tfdt
  00 00 00 10  74 66 64 74 | 00 00 00 00 | 00 00 00 00           version=0  baseMediaDecodeTime=0

片段 2  trun  v=0  flags=0x0f01  count=2
  00 00 00 34  74 72 75 6e | 00 00 0f 01 | 00 00 00 02 | 00 00 00 7c
  s2: 00 00 00 28 | 00 00 00 04 | 00 01 00 00 | ff ff ff d8      duration=40 size=4 flags  cto=−40
  s3: 00 00 00 28 | 00 00 00 04 | 00 01 00 00 | ff ff ff d8      duration=40 size=4 flags  cto=−40
片段 2  tfdt
  00 00 00 10  74 66 64 74 | 00 00 00 00 | 00 00 00 50           version=0  baseMediaDecodeTime=80
```

（`trun` 头部第 9 个字节 `00` 就是 version；两个片段的 `tfdt` 同理。）

### 3.1 从这些字节重建解码时刻

`tfdt` 与 `duration` 足以还原 dts，且本例中片段间无间隙，本库解析器与规范一致：

- 片段 1：`tfdt = 0` → s0 `dts = 0`；s1 `dts = 0 + 40 = 40`
- 片段 2：`tfdt = 80`（= 40 + 40，与累加值相同）→ s2 `dts = 80`；s3 `dts = 80 + 40 = 120`

### 3.2 按 version 0 重建显示时刻（文件现在写出来的样子）

`s2`、`s3` 的 4 个字节 `ff ff ff d8` 被 `readUint32` 读成 **4294967256**：

| 样本 | dts | cto（按 v0 读） | cts = dts + cto | 在 1000 Hz 下的时刻 |
| --- | --- | --- | --- | --- |
| s0 | 0 | 0 | 0 | 0 s |
| s1 | 40 | 80 | 120 | 0.12 s |
| s2 | 80 | **4294967256** | **4294967336** | **≈ 49.7 天** |
| s3 | 120 | **4294967256** | **4294967376** | **≈ 49.7 天** |

按 cts 排序得到显示次序：**s0 → s1 → s2 → s3**，即 I → P → B1 → B2。
原时间线是 I → B1 → B2 → P。两个 B 帧被推到约 49.7 天之后，实际播放器要么永远不显示它们，
要么在 I/P 之后卡住等待，无论哪种都不是原来的画面次序。解码器仍然按 dts 解出 s0..s3，
问题只出在"何时显示"。

### 3.3 按 version 1 重建显示时刻（只改版本位）

把两个 `trun` 的第 9 个字节从 `00` 改成 `01`，其余字节一个不动：

| 样本 | dts | cto（按 v1 读） | cts |
| --- | --- | --- | --- |
| s0 | 0 | 0 | 0 |
| s1 | 40 | 80 | 120 |
| s2 | 80 | **−40** | 40 |
| s3 | 120 | **−40** | 80 |

按 cts 排序：**s0(0) → s2(40) → s3(80) → s1(120)**，即 I → B1 → B2 → P，与原时间线一致。
这证明信息本身没丢，丢的只是那个版本位。

## 4. 二进制表示在什么条件下保留原时间线

逐条列出，全部对应到代码：

1. **有负偏移的 `trun` 必须是 version 1。**
   规范里 version 0 的 `sample_composition_time_offset` 是无符号 32 位，version 1 才是有符号。
   当前 `createMoof()`（`src/isofile.ts:2992-3050`）不设置 `trun.version`，`trunBox` 继承的默认值是 0
   （`src/box.ts:199`），所以**只要某一片段内出现 `cts < dts`，该片段一定丢次序**。
   这正是 §3 的情形。
2. **偏移必须落在所选版本的取值范围内。**
   v0：`[0, 2^32−1]`；v1：`[−2^31, 2^31−1]`（`writeUint32`/`writeInt32` 分别走
   `DataStream.ts:1243` / `1188`）。反向也要留意：若某个偏移 ≥ 2^31（合法的正偏移，
   例如时间刻度过大），version 0 能写，但按有符号读的播放器会读成负数；若此时又切到 version 1，
   则超出 2^31 的值不合法。判断条件应是「存在 < 0 或 > 2^31−1 的偏移」，而不只是「存在 < 0」。
3. **`tfdt.baseMediaDecodeTime` 必须非负且可表示。**
   `src/boxes/tfdt.ts:23` 只在 `> MAX_UINT32` 时切 version 1，负值会走 `writeUint32`
   并环绕：实测 `baseMediaDecodeTime = -1000` 写成 `00 00 00 00 ff ff fc 18`，
   重开读回 4294966296。这会发生在 `addSample()` 路径下——`first_dts` 记的是**第一个被加入的**
   样本的 dts（`src/isofile.ts:2974-2975`），如果之后加入的样本 dts 比它小，
   `samples[0].dts - first_dts` 就是负数。分段路径（`createFragment`）不设 `first_dts`，
   `tfdt` 直接用绝对 dts，只在源文件首帧 dts ≥ 0 时安全。
4. **片段内的 `duration` 必须等于解码时间的步长，且片段间的解码时间要连续。**
   本库解析器在 `updateSampleLists()` 里对每个 traf 的首个样本也按
   `上一个样本.dts + 上一个样本.duration` 累加，**只在整条轨道的第一个 traf 使用 `tfdt`**
   （`src/isofile.ts:1917-1927`，`first_traf_merged` 一旦置位就不再读 `tfdt`）。
   实测：源 dts `0, 40, 1000, 1040`、每帧 duration 40，写出的 `tfdt` 分别是 0 和 1000（正确），
   但用本库重开得到 dts `0, 40, 80, 120`，显示次序从 s0 s1 s2 s3 变成 s0 s2 s3 s1。
   所以：
   - 对**遵守 `tfdt` 的播放器**，只要 `tfdt` 正确、非负，跨片段解码时间可以被表示；
   - 对**本库自己的解析器**，跨片段解码时间**不连续就表示不了**，`duration` 必须严格等于
     下一帧 dts 的增量，否则重建出的时间线会漂移。
5. **`cslg` / `elst` 需要与新的时间线一致。**
   分片初始化段会原样保留源文件的 `cslg` 与 `elst`（`writeInitializationSegment()`，
   `src/isofile.ts:1275`），写回时不重算。`cslg.compositionToDTSShift` /
   `elst.media_time` 决定显示时间轴的起点。本例首帧 cts = 0，所以与它无关；
   但如果为了消掉负偏移而整体上移 cts（见 §6 的方案 b），却不更新 `elst.media_time`，
   播放器会从错误的显示时刻起播。

## 5. 字节层面：修不修版本位，落盘比特是一样的

实测 `DataStream` 的两种写法的输出：

```
writeUint32(-40) -> ff ff ff d8
writeInt32(-40)  -> ff ff ff d8
```

也就是说本例中片段 2 的 `cto` 字段 `ff ff ff d8` 本身是二进制补码的正确表示；
**唯一错误的字节就是 `trun` 头部那个 version 位**。这也解释了为什么「把 version 字节改成 1
之后，显示次序立刻恢复」（§3.3），以及为什么 `ctts` 的做法是可以直接移植的。

## 6. 哪些偏移/写法会让播放器得到不同显示次序

| # | 情况 | 写入后的字节 | 播放器读到的 | 显示次序 |
| --- | --- | --- | --- | --- |
| 1 | 任意片段内出现 `cts − dts < 0`，`trun` version 0（**现状**） | `ff ff ff d8` + version `00` | 4294967256 | B 帧被推到 ~2^32 tick 之后 |
| 2 | 同上，但把 `trun` version 改成 1 | 同样的 `ff ff ff d8` + version `01` | −40 | 正确 |
| 3 | 正偏移 ≥ 2^31 且 `trun` version 1 | `80 00 00 00` + version `01` | −2147483648 | 该帧被拽到最前 |
| 4 | 正偏移 ≥ 2^31 且 `trun` version 0，但接收端内部按 int32 处理 | `80 00 00 00` + version `00` | 按规范应为 2147483648，按 int32 则为 −2147483648 | 同上；同一文件在不同实现下不一致 |
| 5 | `tfdt` 为负（`addSample()` 路径中后续样本 dts 更小） | `ff ff fc 18` | 4294966296 | 整段被推到 ~49.7 天后；遵守 `tfdt` 的播放器受影响，本库解析器因忽略后续 `tfdt` 反而"看不出问题" |
| 6 | 片段间解码时间不连续，而 `duration` 不反映该间隙 | `tfdt` 正确 | 本库忽略后续 `tfdt` | 用本库重开时时间线被压缩，cts 次序变化（§4.4 的实测） |
| 7 | 为消除负偏移而整体上移 cts，但 `elst.media_time`/`cslg` 未更新 | timing 字段都对 | 起播时刻偏移 | 次序可能对，但整条显示时间轴平移 |

情况 1 是本仓库当前分片写回的实际行为；情况 2 是最小修复；情况 3/4 是范围问题；
情况 5/6/7 是 `tfdt` 与编辑列表的边界。

真实素材上的旁证：仓库测试用的 `17_negative_ctso.mp4` 源文件里 `ctts` 是 version 1，
偏移序列 `0, 8, 0, −8, 8, 0, −8, …`，1250 个样本中 400 个为负，`cslg` 的
`leastDecodeToDisplayDelta = −8`、`compositionToDTSShift = 8`。

- **非分片重写**（直接 `mp4.write()`）：`ctts.write()` 自动选 version 1，重开后前 12 个样本的
  显示次序仍是 `0, 3, 2, 1, 6, 5, 4, 9, 8, 7, 11, 10`，与原文件一致。
- **分片写回**（`setSegmentOptions` + `initializeSegmentation` + `start`）：写出的 `trun` 全是
  version 0，重开后第 3、6、9 号样本的 cts 变成 `4294967300`、`4294967312`、`4294967324`，
  前 12 个样本的显示次序变成 `0, 2, 1, 5, 4, 8, 7, 11, 10, 3, 6, 9`。

同一批数据、同一份代码，只是走的写回 API 不同，结果一个保留时间线、一个不保留。

## 7. 最小修复方向

1. `createMoof()` 里按偏移选版本，和 `ctts` 保持一致：
   ```ts
   const cto = samples.map(s => s.cts - s.dts);
   trun.version = cto.some(o => o < 0 || o > 0x7fffffff) ? 1 : 0;
   trun.sample_composition_time_offset.push(...cto);
   ```
   （或者在 `trunBox.write()` 里像 `cttsBox.write()` 那样自决版本，覆盖所有调用方。）
2. `tfdt` 负值：要么在写入前把整条轨道平移到非负解码时间并同步 `elst`，要么至少显式报错，
   不要静默环绕（`src/boxes/tfdt.ts:23`）。
3. 解析侧让每个 traf 都尊重 `tfdt`（`src/isofile.ts:1917-1927`），或至少在
   `tfdt.baseMediaDecodeTime` 与累加值不一致时以 `tfdt` 为准，否则本库无法读回自己写出的
   带解码时间间隙的片段。
4. `cslg` / `elst` 在改写时间线时重算，避免显示轴起点偏移。

## 附：复现方式

用 `createFile(true)` + `addTrack({ timescale: 1000 })`，把 §3 的 4 个样本通过
`setSegmentOptions(track, undefined, { nbSamplesPerFragment: 2, rapAlignement: false })`
切成两段；或者用现成的 `17_negative_ctso.mp4`：

```ts
const mp4 = createFile(true);
mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(bytes, 0)); mp4.flush();
mp4.setSegmentOptions(1, undefined, { nbSamples: 3, nbSamplesPerFragment: 3, rapAlignement: false });
mp4.onSegment = (_id, _u, buf) => segments.push(buf);
mp4.initializeSegmentation(); mp4.start(); mp4.flush();
// 写出的每个 trun 版本字节均为 0；offsets 中可见 -8
// 重开：sample 3 的 cts = 4294967300，而不是 4
```

在仓库里验证时使用了同级目录已安装的 vitest（本工作目录没有 `node_modules`），
脚本放在独立的临时测试文件里，运行后已删除，未改动仓库源码。
