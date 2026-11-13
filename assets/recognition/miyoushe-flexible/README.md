# 自适应导入的数字特征

对应[当前设计与实现](../../../docs/miyoushe-box-import-flexible.md)。已由浏览器图片导入模块按需引用。

`digit-two.json` 是当前流程唯一需要的识别参考素材：从用户提供的原始“2”字裁片提取白色笔画，裁到实际字形边界，再归一化为16×24二值形状。

- 24行，每行用4位十六进制表示16个像素，最高位对应最左像素。
- 原始位图384bit，即48字节；包含尺寸、编码说明和来源的JSON为493字节。
- 只用于牌框右上角检测到的数字局部，不用于整图位置搜索。
- 牌背、页首文字、页尾标识、角标外圈均无需图片模板。

开发期重新生成并验证：

```powershell
python scripts/evaluate-miyoushe-flexible.py
```

脚本从已保留的 `assets/recognition/miyoushe-v1/count-two.png` 生成字形参考；正式网页只需要本目录JSON，不加载旧版PNG或固定布局配置。
