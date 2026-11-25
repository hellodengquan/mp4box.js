# 项目属性的归属：封面与缩略图为何能共享颜色描述、又各有画幅

> 分析对象：本仓库 `mp4box.js`（提交 `8d187c2`）的容器项目元数据实现。
> 涉及文件：`src/boxes/meta.ts`、`src/boxes/pitm.ts`、`src/boxes/iloc.ts`、`src/boxes/iinf.ts`、
> `src/boxes/infe.ts`、`src/boxes/iref.ts`、`src/boxes/ipma.ts`、`src/boxes/defaults.ts`（`iprp`/`ipco`）、
> `src/boxes/ispe.ts`、`src/boxes/colr.ts`、`src/containerBox.ts`、`src/isofile.ts`、`src/box.ts`、`entries/types.ts`。

## 0. 结论摘要

1. HEIF 的「项目」(item) 没有和属性绑定在一起，而是分成**两个互相独立的索引**：
   - `iinf` 下的 `infe` 定义项目身份（`item_ID`、`item_type`、`item_name`）；
   - `iprp` 下的 `ipco` 是一个**属性池**（按出现顺序从 1 开始编号），`ipma` 再用 `item_ID → [property_index…]` 把池里的属性「贴」到项目上。
2. 因此「封面和缩略图共享颜色描述」不是语法糖，而是**一个 `colr` 盒只存一份、两个项目在 `ipma` 里指向同一个 `property_index`**；
   「各有自己的画幅」则是**两个项目在 `ipma` 里分别指向两个不同的 `ispe`**。二者在语法上是同一种机制，只是指向的下标相同或不同。
3. 缩略图关联不在属性里，而在 `iref` 的 `thmb` 项引用中。**方向是「缩略图项 → 主图项」**（`from_item_ID` 是缩略图，
   `to_item_ID` 是被缩略的图）。`mp4box.js` 把它摊平为**缩略图项**上的 `item.ref_to = [{type:'thmb', id:{to_item_ID: 主图ID}}]`。
   主图项自身**没有**反向指针，所以从封面项出发必须**反向扫描**。
4. `pitm`（主项目）只做一件事：把某个 `item_ID` 标成 `items[id].primary = true`，并供 `getPrimaryItem()` /
   `itemToFragmentedTrackFile()` 取默认项。它**不参与**属性归属，也**不参与**缩略图关联；而且主项目可以是缩略图本身
   （真实文件 Nokia `C005.heic` 就是如此），所以「primary」不等于「封面」，不能拿 `pitm` 当缩略关系的根。

---

## 1. 源码中的容器结构

`meta` 在 MPEG-4 侧是 FullBox，在 QuickTime 侧是纯容器（`isQT` 标志见 `src/boxes/meta.ts:15`，分支见 `src/boxes/meta.ts:60-62`）：

```
meta (FullBox v0/f0)
├── hdlr      handler = 'pict'                      ← flattenItemInfo 的前置条件之一
├── pitm      主项目：item_id（v0=16bit，v1=32bit）  ← src/boxes/pitm.ts:10-17
├── iloc      每个项目的字节位置：item_ID → extents  ← 记录形状 src/boxes/iloc.ts:18-38，解析 :40-48；construction_method=1 时落在 idat（src/isofile.ts:2256-2258）
├── iinf      项目清单：entry_count + 若干 infe      ← src/boxes/iinf.ts:17-40
│   └── infe  v2/v3：item_ID, item_protection_index, item_type, item_name
│             （mime 再带 content_type/content_encoding，uri 带 item_uri_type）← src/boxes/infe.ts:35-50
├── iref      项目间引用（FullBox v0/v1 决定 16/32bit ID）← src/boxes/iref.ts:56-90
│   └── thmb  from_item_ID + reference_count + to_item_ID[]
├── iprp      属性总容器                            ← src/boxes/defaults.ts:330-337
│   ├── ipco  属性池（容器；子盒顺序即 property_index，1 起）← src/boxes/defaults.ts:338-346
│   └── ipma  项目-属性关联（可多个）                ← src/boxes/ipma.ts:17-40
└── (可选) idat / grpl / ipro / dinf …
```

两个容易踩的细节：

- `iprp` 的 `subBoxNames = ['ipma']`，所以 `iprp.ipmas` 是数组；而 `ipco` **不是** `subBoxNames`，只能通过 `iprp.ipco` 单值访问
  并出现在 `iprp.boxes` 里（`src/containerBox.ts:54-68`）。`ipco` 自己的 `subBoxNames = ['hvcC','ispe','clap','irot']`
  （`src/boxes/defaults.ts:345`），这四个类型只会进 `hvcCs/ispes/claps/irots` 数组，**不会有** `ipco.ispe` 这种单值属性；
  其它类型（如 `colr`、`pixi`、`auxC`）走 `this[type]` 单值，**重复出现时保留第一个并打 `ContainerBox` 警告**
  （`src/containerBox.ts:59-67`）。
- `ipma` 的 `version` 决定 `item_ID` 宽度（`v<1` 为 16 位），`flags & 1` 决定 `property_index` 是 7 位还是 15 位
  （`src/boxes/ipma.ts:22`、`src/boxes/ipma.ts:29-32`）。

---

## 2. 归属模型：三个索引 + 两条边

`flattenItemInfo()`（`src/isofile.ts:2207-2305`）把上述盒子摊平成 `ISOFile.items` / `ISOFile.entity_groups`：

| 摊平产物                                                         | 来源                                                                                                       | 代码                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------- |
| `items[id].id/name/type/content_type/…`                          | `iinf.item_infos[]`                                                                                        | `src/isofile.ts:2212-2229` |
| `items[id].extents[]/size`                                       | `iloc.items[]`（`base_offset + extent_offset`；`construction_method=1` 再加 `idat.start + idat.hdr_size`） | `src/isofile.ts:2240-2262` |
| `items[id].primary = true`                                       | `pitm.item_id`                                                                                             | `src/isofile.ts:2263-2270` |
| `items[from].ref_to.push({type, id})`                            | `iref.references[].references[]`                                                                           | `src/isofile.ts:2271-2278` |
| `item.properties[type] = box`、`item.properties.boxes.push(box)` | `ipma.associations[]` + `ipco.boxes[index-1]`                                                              | `src/isofile.ts:2279-2305` |

三个索引：

- **身份索引**：`item_ID`（`iinf`），也是 `iloc` / `iref` / `ipma` 的公共主键；
- **属性池索引**：`property_index` = `ipco.boxes` 的下标 **+1**（`ipma.property_index - 1`）；
- **实体组索引**：`grpl` 的 `group_id`。`ipma` 条目的 ID 先按 `items` 查，查不到再按 `entity_groups` 查
  （`items[association.id] ?? entity_groups[association.id]`，`src/isofile.ts:2284`），所以同一个 `ipma` 里的 ID
  在代码层面是「项目优先、组兜底」的两套命名空间。

两条边：

- `iref`：项目 → 项目（`thmb`、`dimg`、`auxl`、`cdsc`…，名称表见 `src/boxes/iref.ts:7-26`）；
- `ipma`：项目/组 → 属性池下标。

关键点：**属性只有「指向」，没有「拷贝」**。两个项目关联同一个 `property_index` 时，摊平后
`items[a].properties.colr === items[b].properties.colr`（同一个对象）；关联不同下标时才是两份独立对象。
这正好解释了「共享颜色描述 + 各自画幅」：

```
colr#1 ──────────┐            ┌── ispe#3 (1440×960)
                 ├─ item 1 ────┘
                 └─ item 2 ─────── ispe#5 (240×160)
```

---

## 3. 示例关系图（可逐字节追溯到原盒）

真实语料中，「共享 `colr` + 各自 `ispe`」在 AVIF 里可以直接找到（§7(c) 给了原盒偏移）；但在本机抽样的 HEIF 里，
`thmb` 对恰好都选择了复制 `colr` 或不带 `colr`（§7(b)(d)）。为了让「共享颜色描述 + 各自画幅」和「`thmb` 方向」
在同一张图上完整呈现，下面这**一个最小示例**按相同语法构造（可直接用本仓库解析复现）。所有偏移均为文件绝对偏移，
字节均可用 `xxd` 核对；§9 给出读取端复现代码，§10 给出该示例文件的完整构造脚本。

文件布局（`ftyp` 24B + `meta` 404B + `mdat` 5192B = 5620B）：

| 盒       | 绝对偏移 | 大小 | 关键内容                                                                         |
| -------- | -------: | ---: | -------------------------------------------------------------------------------- |
| `ftyp`   |        0 |   24 | `heic` / `mif1,heic`                                                             |
| `meta`   |       24 |  404 | v0/f0                                                                            |
| `hdlr`   |       36 |   38 | `handler='pict'`                                                                 |
| `pitm`   |       74 |   14 | v0 `item_id=1`                                                                   |
| `iloc`   |       88 |   58 | v0，offset/length 各 4B，base_offset 0：1→{436,4096}、2→{4532,1024}、3→{5556,64} |
| `iinf`   |      146 |   91 | v0，3 条 `infe`                                                                  |
| `infe`   |      160 |   26 | v2 `#1 hvc1 "Cover"`                                                             |
| `infe`   |      186 |   26 | v2 `#2 hvc1 "Thumb"`                                                             |
| `infe`   |      212 |   25 | v2 `#3 Exif "Meta"`                                                              |
| `iprp`   |      237 |  165 |                                                                                  |
| `ipco`   |      245 |  129 | 属性池，5 个子盒                                                                 |
| ├ `colr` |      253 |   19 | **#1** `nclx` primaries=1 transfer=13 matrix=6 full_range=1                      |
| ├ `hvcC` |      272 |   31 | **#2** 封面配置（level_idc=120）                                                 |
| ├ `ispe` |      303 |   20 | **#3** 1440×960 ← 封面画幅                                                       |
| ├ `hvcC` |      323 |   31 | **#4** 缩略图配置（level_idc=60）                                                |
| └ `ispe` |      354 |   20 | **#5** 240×160 ← 缩略图画幅                                                      |
| `ipma`   |      374 |   28 | v0/f0，2 条：item1 = [2(E),3(E),1]、item2 = [4(E),5(E),1]                        |
| `iref`   |      402 |   26 | v0，`thmb`：from=2 → to=[1]                                                      |
| └ `thmb` |      414 |   14 | `from_item_ID=2`、`count=1`、`to_item_ID=1`                                      |
| `mdat`   |      428 | 5192 | 1@436(4096B)、2@4532(1024B)、3@5556(64B)                                         |

原盒字节（`xxd` 摘录）——`ipma` 一条项的编码是 `item_ID(2B) | association_count(1B) | (E<<7 | index)(1B)…`：

```
@74 : 0000000e 7069746d 00000000 0001                      pitm v0 item_id=1
@374: 0000001c 69706d61 00000000 00000002
      0001 03 82 83 01                                      item 1: 3 个属性 = #2(E) #3(E) #1
      0002 03 84 85 01                                      item 2: 3 个属性 = #4(E) #5(E) #1
@402: 0000001a 69726566 00000000 0000000e 74686d62 0002 0001 0001
                                                           iref v0 / thmb from=2 to=1
@253: 00000013 636f6c72 6e636c78 0001 000d 0006 80          colr nclx(1,13,6) full-range
@303: 00000014 69737065 00000000 000005a0 000003c0          ispe 1440×960
@354: 00000014 69737065 00000000 000000f0 000000a0          ispe 240×160
```

摊平后的项目关系图（箭头标注了每一步的原盒来源）：

```
                          ┌─ hdlr@36  handler='pict'
                          │
ftyp@0 ── meta@24 ────────┼─ pitm@74  item_id=1 ───────────────────────────► items[1].primary = true
                          │                                                        │
                          ├─ iloc@88  1→{436,4096}  2→{4532,1024}  3→{5556,64}    │ (只标主项目，不建属性/缩略边)
                          │                                                        │
                          ├─ iinf@146 ─► infe@160 #1 hvc1 'Cover'  ─────────────► items[1]
                          │              infe@186 #2 hvc1 'Thumb'  ─────────────► items[2]
                          │              infe@212 #3 Exif 'Meta'   ─────────────► items[3]（无 ipma 条目）
                          │
                          ├─ iref@402 ─► thmb@414: from_item_ID=2, to_item_ID=1
                          │                    │                 └──命名的目标────────► items[1]
                          │                    └────► items[2].ref_to = [{type:'thmb', id:{to_item_ID:1}}]
                          │
                          └─ iprp@237
                              ├─ ipco@245  (property_index = 子盒序号，1 起)
                              │    #1 colr@253  nclx(1,13,6,full)  ◄──────────────┐  共享
                              │    #2 hvcC@272  level=120          ◄── item 1 独有 │
                              │    #3 ispe@303  1440×960           ◄── item 1 画幅 │
                              │    #4 hvcC@323  level=60           ◄── item 2 独有 │
                              │    #5 ispe@354  240×160            ◄── item 2 画幅 │
                              └─ ipma@374
                                   item 1 → [2, 3, 1] ──────────────────────────┘   (E,E,–)
                                   item 2 → [4, 5, 1] ──────────────────────────┘   (E,E,–)
```

用本仓库解析该文件得到的事实（与上图逐条对应）：

```
item 1 (Cover) primary=true ref_to=[]
  keyed : hvcC  colr(primaries=1,transfer=13,matrix=6,range=1)  ispe(1440x960)
  boxes : 1:hvcC  2:ispe  3:colr
item 2 (Thumb) primary 未设置（falsy，未被 pitm 标记）ref_to=[{"type":"thmb","id":{"to_item_ID":1}}]
  keyed : hvcC  colr(primaries=1,transfer=13,matrix=6,range=1)  ispe(240x160)
  boxes : 1:hvcC  2:ispe  3:colr
item 3 (Exif) properties = undefined
对象同一性: items[1].properties.colr === items[2].properties.colr  → true
            items[1].properties.ispe === items[2].properties.ispe  → false
```

> 说明：`boxes` 数组按 **`ipma` 里声明的顺序**（2,3,1 → hvcC,ispe,colr），不是 `ipco` 的物理顺序（colr,hvcC,ispe,…）。
> 这一点在把 `boxes` 当作 `description_boxes` 复用时要留意（`src/isofile.ts:2498-2501`）。

---

## 4. 读取端：从哪一项能找到缩略关联

`thmb` 边的方向是**缩略图 → 主图**，摊平后落在**缩略图项**上。因此：

- **从原始盒找**：`mp4.meta.iref.references` 中 `type === 'thmb'` 的条目，`from_item_ID` 是缩略图项，
  `references[].to_item_ID` 是主图项（`src/box.ts:272-296`，`src/boxes/iref.ts:68-88`）。
  也可以用遍历 API：`mp4.getBoxes('thmb')`（`src/isofile.ts:972-994` 会把 `iref.references` 递归进来）。
- **从摊平项找**：`items[缩略图ID].ref_to` 里 `{type:'thmb', id:{to_item_ID: 主图ID}}`（`src/isofile.ts:2271-2278`）。
  `ref_to` 的元素类型在 `entries/types.ts:273-276`（`{type: string; id: {to_item_ID: number}}`）。
  主图项的 `ref_to` **不会**出现来自缩略图的记录。
- **从主图（含 `pitm` 指向项）出发**：没有反向边，只能全量扫描：

```js
const coverId = mp4.meta.pitm?.item_id;
const thumbs = [];
for (const item of mp4.items) {
  if (!item?.ref_to) continue;
  if (item.ref_to.some(r => r.type === 'thmb' && r.id.to_item_ID === coverId)) thumbs.push(item);
}
```

同理，「缩略图画幅」要从缩略图项自己的 `properties.ispe` 取，而不是从主图项取（示例里 240×160 vs 1440×960）。
`mp4box.js` 也不会替 `thmb` 做任何继承：主图的 `colr` 不会自动出现在缩略图上，反过来也一样——是否共享完全取决于
`ipma` 是否指向同一 `property_index`。

---

## 5. 每项按类型取到的属性 vs 完整属性列表

`flattenItemInfo()` 为每个关联条目同时写两份视图（`src/isofile.ts:2291-2300`）：

```js
item.properties[propbox.type] = propbox; // ① 按 fourcc 取：后写覆盖先写（last-wins）
item.properties.boxes.push(propbox); // ② 完整列表：按 ipma 顺序，保留重复
```

| 视图                       | 语义                                                       | 示例文件的取值                                   |
| -------------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `item.properties.<fourcc>` | 按类型直达；**同一项关联了同类型多个盒时只有最后一个可见** | item 1：`.hvcC`=@272、`.ispe`=@303、`.colr`=@253 |
| `item.properties.boxes`    | `ipma` 顺序的完整属性列表，重复类型都在里面                | item 1：`[hvcC@272, ispe@303, colr@253]`         |
| `item.properties` 缺省     | 该项在 `ipma` 中完全没有条目                               | item 3（Exif）：`undefined`，不是空对象          |

各类型的解析字段（读取端实际能拿到什么）：

| 属性盒                                                       | 类 / 字段                                                                                                                                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ispe`                                                       | `image_width`、`image_height`（`src/boxes/ispe.ts:8-15`）——**画幅**                                                                                                                      |
| `colr`                                                       | `colour_type`；`nclx` 时 `colour_primaries`/`transfer_characteristics`/`matrix_coefficients`/`full_range_flag`；`rICC`/`prof` 时 `ICC_profile`（`src/boxes/colr.ts:8-27`）——**颜色描述** |
| `hvcC`                                                       | `configurationVersion`、`general_profile_*`、`general_level_idc`、`chroma_format_idc`、`bit_depth_*`、`nalu_arrays` 等（`src/boxes/hvcC.ts:11-28`）——**码流配置**                        |
| `av1C` / `vvcC` / `av3c`                                     | 对应编解码配置（`src/boxes/av1C.ts:5`、`src/boxes/vvcC.ts:5`、`src/boxes/av3c.ts:417`）                                                                                                  |
| `pixi`                                                       | `num_channels` + 各通道 `depth` 等（`src/boxes/pixi.ts:14-`）                                                                                                                            |
| `auxC`                                                       | `aux_type`、`aux_subtype`（`src/boxes/auxC.ts:8-16`）——标识 auxl 辅助项类型                                                                                                              |
| `irot` / `imir`                                              | `angle`（0–3）/ `axis`（`src/boxes/irot.ts:8-12`、`src/boxes/imir.ts:8-15`）——**方向**                                                                                                   |
| `clap` / `pasp`                                              | 裁剪参数 `cleanAperture*`/`*Off*` / 像素宽高比（`src/boxes/clap.ts:8-15`、`src/boxes/pasp.ts:8-12`）                                                                                     |
| `prfr` / `cclv` / `mdcv` / `clli` / `amve` / `cmin` / `cmex` | OMAF/HDR 类属性                                                                                                                                                                          |

另外三处会直接影响「按类型取值」的行为，已在字节级验证：

1. **重复类型的真实归属**：若某项在 `ipma` 里同时关联了两个 `ispe`（合法但少见），`.ispe` 是**最后一个**，
   而 `.boxes` 里两者都在。示例（构造）：item 1 关联 `colr#2(p=2)` 与 `colr#3(p=1)`，结果 `.colr.colour_primaries === 1`。
2. **`ipma` 的下标越界/0** 被静默跳过（`property_index > 0 && index - 1 < ipco.boxes.length`，`src/isofile.ts:2293-2296`）；
   因此 `boxes` 的数量可能小于 `association_count`。
3. **`essential` 标志在摊平时被丢弃**：`ipma` 解析出了 `essential`（`src/boxes/ipma.ts:29-32`），但 `flattenItemInfo`
   只写 `type` 与列表，`Item` 类型里也没有该字段（`entries/types.ts:257-281`）。读取端若需要「关键属性」语义，
   必须自己回读 `meta.iprp.ipmas[*].associations[*].props[*].essential`——示例里 item 1 的 `colr` 是非 essential（`0x01`），
   取不到这一事实。

---

## 6. `pitm`（主项目标记）在这张图里起什么作用

`pitm` 的作用范围**只有「默认项」这一件事**：

| 位置                          | 行为                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flattenItemInfo`             | `items[pitm.item_id].primary = true`；若该 ID 不在 `iinf` 中，仅 `Log.warn('Primary item_id #N does not exist in items')`，不抛错（`src/isofile.ts:2263-2270`） |
| `getPrimaryItem()`            | 返回 `this.getItem(pitm.item_id)`，即**带数据的**项目（`src/isofile.ts:2481-2483`）；`meta` 解析完但 `mdat` 尚未到达时返回 `undefined`                          |
| `itemToFragmentedTrackFile()` | 未显式给 `itemId` 时默认取主项目（`src/isofile.ts:2486-2492`）                                                                                                  |
| `pitm` 盒解析                 | v0 读 16 位、v1 读 32 位 `item_id`（`src/boxes/pitm.ts:10-17`）                                                                                                 |

它**不**做的事：

- 不建立缩略关联（那是 `iref/thmb` 的事）；
- 不参与属性归属（那是 `ipma` 的事）；
- 不保证「主项目 = 封面」。真实文件 Nokia `C005.heic`（`published/heif/C005.heic`，描述为
  “Thumbnail image as the primary item”）里 `pitm.item_id = 1005`，而 `iref` 里 `thmb` 的 `from_item_ID = 1005`、
  `to_item_ID = 1002`——**主项目就是缩略图，主图 1002 反而不是 primary**。

所以在关系图里，`pitm` 是一条**正交的标注**（「先展示谁」），与 `ipma`（「谁有什么属性」）、`iref`（「谁引用谁」）
三者互不推导。要拿封面必须结合场景：如果主项目自身带 `thmb` 引用，那它是缩略图，主图要去 `ref_to` 里找；
如果主项目不带 `thmb`，它才是「被缩略的那张图」，缩略图要反向扫描。

---

## 7. 真实文件佐证（含偏移，便于回溯原盒）

**(a) Nokia `C005.heic`（主项目 = 缩略图）**：`meta@24 size=510`，`pitm@69 item_id=1005`，
`iref@211` → `thmb@223 from=1005 to=1002`，`ipco@245` 内 `hvcC@253`(#1)、`ispe@361 1280×720`(#2)、
`hvcC@381`(#3)、`ispe@488 128×72`(#4)，`ipma@508`：1002→[1(E),2]、1005→[3(E),4]。摊平后
`items[1005].primary === true` 且 `items[1005].ref_to = [{type:'thmb', id:{to_item_ID:1002}}]`。
说明「主项目标记」与「缩略关联」彼此独立：`pitm` 指向缩略图，主图身份只能从 `thmb` 的反向端读到。

**(b) iPhone `IMG_1034.heic`（同值但不共享，且跨项共享的是 `irot`）**：`meta@24 size=3956`、`pitm@106 item_id=49`（grid 封面）、
`iref@1205` 内 `thmb@1325 from=50 to=49`、`cdsc@1339 from=51 to=49`；`ipco@1361`：
`colr@1369 560B prof`(#1)、`hvcC@1929`(#2)、`ispe@2041 512×512`(#3)、`ispe@2061 4032×3024`(#4)、`irot@2081`(#5)、`pixi@2090`(#6)、
`colr@2106 560B prof`(#7)、`hvcC@2666`(#8)、`ispe@2778 320×240`(#9)、`pixi@2798`(#10)，`ipma@2814`：
item 1–48（tile）→ [#3,#1,#2]，item 49（grid 封面）→ [#4,#5,#6]，item 50（缩略图）→ [#7,#8,#9,**#5**,#10]。
可见：封面项 **49 完全没有 `colr`**（颜色只挂在 tile 与缩略图上）；缩略图的 ICC `colr`(#7) 与 tile 的 `colr`(#1)
**字节完全相同（552B 负载逐字节相等）却各存一份**，没有让缩略图指向 #1；真正被跨项共享的是 `irot`(#5)——
`items[49].properties.irot === items[50].properties.irot` 为 `true`，而两份 `colr` 对象不同。
这正好说明：**共享与否是编码器的选择，内容相同不代表对象相同**，读取端不能靠「值相等」推断共享，也不能靠「共享边」推断值。

**(c) libavif `color_nogrid_alpha_nogrid_gainmap_grid.avif`（`colr` 共享的实证）**：`pitm@88 item_id=1`，`iprp@508`，`ipco` 的 13 个属性依次为
`ispe@524 128×200`(#1)、`pixi@544`(#2)、`av1C@560`(#3)、`colr@572 nclx(2,16,2)`(#4)、`pixi@591`(#5)、`av1C@605`(#6)、`auxC@617`(#7)、
`pixi@673`(#8)、`colr@689 nclx(1,13,6)`(#9)、`ispe@708 128×160`(#10)、`colr@728 nclx(2,2,2)`(#11)、`ispe@747 64×80`(#12)、`av1C@767`(#13)；
`ipma@779`：item 1（Color）→ [#1,#2,#3,#4]，item 2（Alpha）→ [#1,#5,#6,#7]，item 3（GMap tmap）→ [#1,#8,#9]，
item 4（GMap grid）→ [#10,#8,**#11**]，item 5–8（GMap tile）→ [#12,#8,#13,**#11**]。
即 `ispe#1` 被 item 1/2/3 共享、`colr#11` 被 item 4–8 共享、`pixi#8` 被 item 3–8 共享，而每个 tile 有自己的 `ispe#12`。
摊平后 `items[4].properties.colr === items[8].properties.colr` 为 `true`，`items[1].properties.ispe === items[2].properties.ispe` 为 `true`。
这说明「共享颜色描述 + 各自画幅」在真实文件里确实是靠 `ipma` 重复指向同一下标实现的（只是这里共享的是 grid/gainmap，
不是 `thmb` 对）；HEIF 侧机制完全相同，只是 §7(a)(b)(d) 的 `thmb` 样本恰好没有这么写。

**(d) 抽样统计（本机检查过的 70 个可解析 HEIF/HEIC/AVIF 文件，含 Nokia `heif_conformance` 中可下载的 37 个，其中 20 个含 `thmb` 对）**：
`thmb` 对之间共享属性最常见的是 `ispe`（如 `example.heic` 的 20004/20006、20005/20007 各共享一个 `ispe`；
Nokia `C012.heic` 的 10 个缩略图项 1023…1041 共享同一个 `ispe`），其次是 `irot`（§7(b)）；
**没有**发现「`thmb` 对之间共享 `colr`」的样例——`colr` 的跨项共享出现在 AVIF 的 grid/tile 之间（§7(c)）。
这不是语法限制——`ipma` 的机制对任何属性一视同仁——而是编码器选择；读取端也不能假设「封面和缩略图共享颜色」
或「一定不共享」，两种文件都存在。

---

## 8. 源码级的边界与坑（都已在字节级复现）

1. **`iref` 的 `from_item_ID` 不存在会抛异常**：`items[ref.from_item_ID].ref_to.push(...)` 没有空值保护
   （`src/isofile.ts:2275`）。构造 `thmb from=9`（`iinf` 只有 1、2）时 `flattenItemInfo` 直接
   `TypeError: Cannot read properties of undefined (reading 'ref_to')`。相对的，`pitm` 指向不存在的项只告警。
2. **只保留一个 `ipco`**：`iprp` 里出现第二个 `ipco` 时，`ContainerBox` 打
   “Box of type ipco already exists in container box iprp.” 并丢弃后者；`ipma` 仍可能引用被丢弃的下标 → 静默少属性。
   同理，`meta` 里第二个 `iref`/`iprp` 也会覆盖单值属性；虽然 `meta.irefs`/`meta.iprps`/`meta.iinfs` 在
   `src/boxes/meta.ts:19-36` 有声明，但实际解析路径不会填充这些数组（实测为 `undefined`）。**重复 `ipma` 是安全的**：
   `iprp.ipmas` 是数组，`flattenItemInfo` 会遍历全部（`src/isofile.ts:2280`）。
3. **`colr` 的 ICC 负载多读 8 字节**：`prof`/`rICC` 分支用 `this.size - 4` 而不是 `size - hdr_size - 4`
   （`src/boxes/colr.ts:24`、`src/boxes/colr.ts:26`），实测 684B 的 `colr` 读回 680B（应为 672B），
   多读的 8B 随后靠解析器的“seek backwards”回退，并打
   “Parsing of box 'colr' read 8 more bytes than the indicated box data size”。对「共享 ICC 颜色描述」的场景，
   `ICC_profile` 末尾会混入下一个盒的头部字节，比较两份 ICC 时需按 `size - hdr_size - 4` 截断。
4. **`boxes` 的顺序是 `ipma` 顺序**，不是 `ipco` 顺序（§3 已验证），`getBoxes('colr')` 这类遍历返回的是 `ipco` 物理顺序
   （`src/isofile.ts:972-994` 会进 `boxes`/`references`/`item_infos`），两套顺序不要混用。
5. **`getPrimaryItem()` 依赖数据**：`meta` 已在缓冲里、`mdat` 未到时它返回 `undefined`，而 `items[pitm.item_id].primary`
   已经是 `true`。判断「哪个是主项目」用 `pitm`/`primary`；取「主项目内容」才用 `getPrimaryItem()`。
6. **`property_index`/`item_ID` 的位宽随版本变化**：`ipma` v1 + `flags&1` 是 15 位下标，`iloc` v1/v2 才读
   `construction_method`（`src/boxes/iloc.ts:61-65`），`iref` v1 用 32 位 ID（`src/boxes/iref.ts:68-77`）。
   解析大于 65535 的项目编号或大于 127 的属性下标时，必须确认版本位。

---

## 9. 复现方式

```js
import { createFile, MP4BoxBuffer } from 'mp4box';

const file = createFile(true); // 保留 mdat，便于取数据
file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, 0));
file.flush(); // appendBuffer 内已自动跑过一次 flattenItemInfo

const { meta, items } = file;
console.log(meta.hdlr.handler); // 'pict'
console.log(meta.pitm.item_id); // 主项目 ID（不等于封面，见 §6）

for (const item of items) {
  if (!item) continue; // items 是按 item_ID 稀疏的数组
  const props = item.properties; // 该项无 ipma 条目时是 undefined
  console.log(
    item.id,
    item.primary,
    item.ref_to,
    props && Object.keys(props).filter(k => k !== 'boxes'), // 按类型的视图（last-wins）
    props && props.boxes.map(b => b.type),
  ); // 完整列表（ipma 顺序）
}

// 缩略图 → 主图 的边落在缩略图项上；主图项没有反向边，只能反向扫描。
// 注意 pitm 可能指向缩略图本身（§6），所以要先看主项目是否自己就是缩略图。
const primary = items[meta.pitm.item_id];
const primaryIsThumb = !!primary?.ref_to?.some(r => r.type === 'thmb');
const mainId = primaryIsThumb
  ? primary.ref_to.find(r => r.type === 'thmb').id.to_item_ID
  : primary.id;
const thumbs = items.filter(it =>
  it?.ref_to?.some(r => r.type === 'thmb' && r.id.to_item_ID === mainId),
);
const main = items[mainId];

for (const t of thumbs) {
  const tc = t.properties?.colr,
    mc = main?.properties?.colr; // 任何一方没有 colr 时不能比较
  console.log(
    'thumb',
    t.id,
    'size',
    t.properties?.ispe?.image_width,
    'x',
    t.properties?.ispe?.image_height,
    '| 都有 colr?',
    !!tc && !!mc,
    '| 同一对象?',
    !!tc && tc === mc, // 同一对象 = ipma 指向同一 property_index
    '| 值相同?',
    !!tc &&
      !!mc &&
      tc.colour_primaries === mc.colour_primaries &&
      tc.transfer_characteristics === mc.transfer_characteristics,
  );
}
```

> 若要看 `essential` 标志，只能回读 `meta.iprp.ipmas[*].associations[*].props[*]`（§5 第 3 条）；
> 若要比 ICC 负载，先按 `box.size - box.hdr_size - 4` 截断 `ICC_profile`（§8 第 3 条）。

---

## 10. 附录：§3 示例文件的构造脚本

下面的脚本生成的字节与 §3 的表格/十六进制逐字节一致（实测 5620B、`cmp` 相同），可用来核对偏移：

```js
import fs from 'node:fs';

const enc = new TextEncoder();
const cat = (...parts) => {
  const out = [];
  for (const p of parts) for (const v of Array.from(p instanceof Uint8Array ? p : p)) out.push(v);
  return out;
};
const u8 = n => [n & 0xff];
const u16 = n => [(n >>> 8) & 0xff, n & 0xff];
const u32 = n => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const str = s => Array.from(enc.encode(s));
const box = (t, ...p) => {
  const b = cat(...p);
  return new Uint8Array(cat(u32(8 + b.length), str(t), b));
};
const fullbox = (t, v, f, ...p) =>
  box(t, u8(v), [(f >>> 16) & 0xff, (f >>> 8) & 0xff, f & 0xff], ...p);

// mdatPayloadStart 只在第二遍构造时才知道（iloc 里是绝对偏移）
const makeMeta = mdatPayloadStart => {
  const hdlr = fullbox('hdlr', 0, 0, u32(0), str('pict'), u32(0), u32(0), u32(0), str('Photo\0'));
  const pitm = fullbox('pitm', 0, 0, u16(1));

  const itemLoc = (id, off, len) => cat(u16(id), u16(0), u16(1), u32(off), u32(len));
  const iloc = fullbox(
    'iloc',
    0,
    0,
    u8(0x44),
    u8(0x00),
    u16(3),
    itemLoc(1, mdatPayloadStart, 4096),
    itemLoc(2, mdatPayloadStart + 4096, 1024),
    itemLoc(3, mdatPayloadStart + 5120, 64),
  );

  const infe = (id, type, name) =>
    fullbox('infe', 2, 0, u16(id), u16(0), str(type), str(name + '\0'));
  const iinf = fullbox(
    'iinf',
    0,
    0,
    u16(3),
    infe(1, 'hvc1', 'Cover'),
    infe(2, 'hvc1', 'Thumb'),
    infe(3, 'Exif', 'Meta'),
  );

  const hvcC = level =>
    box('hvcC', [1, 1, 0x60, 0, 0, 0, 0, 0, 0, 0, 0, 0, level, 0, 0, 0, 1, 0, 0, 0, 0, 0x0f, 0]);

  // ipco 子盒顺序 = property_index：1 colr, 2 hvcC(cover), 3 ispe(cover), 4 hvcC(thumb), 5 ispe(thumb)
  const ipco = box(
    'ipco',
    box('colr', str('nclx'), u16(1), u16(13), u16(6), u8(0x80)),
    hvcC(120),
    fullbox('ispe', 0, 0, u32(1440), u32(960)),
    hvcC(60),
    fullbox('ispe', 0, 0, u32(240), u32(160)),
  );

  const assoc = (id, props) =>
    cat(
      u16(id),
      u8(props.length),
      props.map(([i, e]) => (e ? 0x80 : 0) | i),
    );
  const ipma = fullbox(
    'ipma',
    0,
    0,
    u32(2),
    assoc(1, [
      [2, 1],
      [3, 1],
      [1, 0],
    ]), // cover: hvcC(E), ispe(E), colr(非 E)
    assoc(2, [
      [4, 1],
      [5, 1],
      [1, 0],
    ]),
  ); // thumb: hvcC(E), ispe(E), colr(非 E，同一下标 → 共享)

  const iref = fullbox('iref', 0, 0, box('thmb', u16(2), u16(1), u16(1))); // 缩略图(2) → 主图(1)

  return fullbox('meta', 0, 0, hdlr, pitm, iloc, iinf, box('iprp', ipco, ipma), iref);
};

const ftyp = box('ftyp', str('heic'), u32(0), str('mif1'), str('heic'));
let meta = makeMeta(0); // 第一遍只为量 meta 大小
meta = makeMeta(ftyp.length + meta.length + 8); // meta 大小与偏移无关（固定 4 字节字段）
const mdat = box(
  'mdat',
  new Uint8Array(4096).fill(0x11),
  new Uint8Array(1024).fill(0x22),
  new Uint8Array(64).fill(0x33),
);
fs.writeFileSync('cover-thumb.heic', new Uint8Array(cat(ftyp, meta, mdat)));
```
