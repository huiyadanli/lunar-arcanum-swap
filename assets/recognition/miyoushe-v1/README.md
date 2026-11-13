# 米游社 Box 导入模板 v1

> 本目录为历史素材，继续保留原始裁片和注释。当前[自适应识别方案](../../../docs/miyoushe-box-import-flexible.md)不加载这些PNG或固定坐标配置，只使用[493字节的数字特征](../miyoushe-flexible/README.md)。以下模板清单和体积说明为旧版记录。

对应 [设计文档](../../../docs/miyoushe-box-import.md)。已裁切素材，尚未被网页代码引用。

跨设备推荐方案见[修订文档](../../../docs/miyoushe-box-import-adaptive.md)：分别归一化宽高，按牌框颜色判断拥有状态。该方案不加载 `missing-back.png`，其余 4 个 PNG 合计 20,460 B；现有牌背素材保留供对照。

第三张476px低分辨率图的验证见修订文档第7节：页首小字改作诊断参考，由页尾标识和全部22个双侧牌框确认布局。正式流程所需3个PNG为 `layout-footer.png`、`badge-ring.png`、`count-two.png`，共17,276 B；其他素材继续保留。

- `missing-back.png`：未获得牌背的固定局部，110 × 90 RGB。
- `count-two.png`：用户提供的“2”字原始模板，38 × 46 RGB；匹配时缩为 19 × 23。
- `badge-ring.png`：35 × 35 RGBA 数量角标外圈；仅比较 alpha ≥ 128 的像素，内部数字不参与。
- `layout-header.png`：固定“已解锁：”文字，66 × 22 RGB，不含可变数量。
- `layout-footer.png`：米游社固定标识，80 × 90 RGB，不含二维码。
- `layout.json`：原图 1080 × 7616 的网格、内容区域、匹配尺寸与初始阈值。

全部矩形使用 `[x, y, width, height]`，不是两个顶点。工作图宽度为 540px，位置从标定坐标缩放并 `Math.round`，不能逐行累计已取整的行距。

5 个 PNG 共 33,796 B；连同 JSON 共 36,448 B。采用小尺寸无损 PNG，浏览器端无需图像库。阈值目前仅经一张真实样图及其合成变体验证，接入 Canvas 后须再次验证。

重新生成（需要 Pillow 和本地原图 `docs/assets/mine.jpeg`）：

```powershell
python scripts/prepare-miyoushe-import.py --verify
```

脚本默认复用本目录已有的 `count-two.png`，不依赖临时附件路径。不要用字体重画该数字，也不要以网页字体的外观替代模板。

原始图片受项目现有 `docs/assets` 忽略规则影响，本目录素材、文档预览与验证文件可正常随项目保存。正式接入时从识别模块显式导入所需 PNG 和配置，不把开发期原图或预览图加入构建依赖。
