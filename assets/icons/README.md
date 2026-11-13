# UI 图标

`ui.svg` 是为本项目自绘的 SVG sprite，不依赖图标字体、CDN 或第三方运行库。
图标统一使用 24 × 24 画布、圆角细线，与月夜主题的银色和金色搭配。

在页面或片段中引用：

```html
<svg class="icon" aria-hidden="true" focusable="false">
  <use href="assets/icons/ui.svg#bell"></use>
</svg>
```

尺寸使用 `icon-xs`（14px）、`icon-sm`（16px）、默认（20px）、`icon-lg`（24px）。
颜色继承文字的 `currentColor`，可用 `icon-gold` 强调、`icon-fill` 填充。
图标只作为装饰；纯图标按钮应保留 `aria-label`，有文字的按钮由文字提供名称。
新增图标时在 sprite 中添加唯一的 `symbol`，无需调整应用启动流程。
